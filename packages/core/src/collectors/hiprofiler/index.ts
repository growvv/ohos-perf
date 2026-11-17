/**
 * hiprofiler collection driver.
 *
 * hiprofiler_cmd is the CLI DevEco Studio and HapRay both drive the on-device
 * profiler with; it manages the session over the daemon's gRPC socket for us.
 * The command writes one `.htrace` file, which the normal ingest path converts
 * to the same SQLite schema as a hitrace capture.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityId } from '../../device/capability';
import { OhosPerfError } from '../../errors';
import type { SceneLayout } from '../../ingest/scene';
import type { Hdc } from '../../transport/hdc';
import type { Collector } from '../types';
import { parseSize } from '../hitrace';
import { buildHiprofilerConfig, type HiprofilerPlugin } from './config';

/** Fixed device-side paths; removed before and after every session. */
export const DEVICE_CONFIG_PATH = '/data/local/tmp/ohos-perf-hiprofiler.cfg';
export const DEVICE_OUTPUT_PATH = '/data/local/tmp/ohos-perf-hiprofiler.htrace';

export interface HiprofilerCollectOptions {
  /** Requested capture length; rounded up to whole seconds for `-t`. */
  readonly durationMs: number;
  readonly plugins: readonly HiprofilerPlugin[];
  /** Ring buffer pages; the daemon requires at least 16384. */
  readonly bufferPages?: number;
}

/** hiprofiler_cmd's success marker; hdc exits 0 even when a session fails. */
const DONE_MARKER = 'DONE';

/**
 * The size of a trace that holds only the container's header and the config
 * echo, measured on a Mate 60 (API 26): 1024-byte header, a 4-byte length and
 * a 70-byte `ftrace-plugin_config` block — 1098 bytes, with no event section.
 *
 * A session that runs its whole `-t` window without recording anything still
 * writes this file and still prints `DONE`. Checking `size > 0` accepted it,
 * trace_streamer turned it into an 88-table database whose only non-empty
 * tables were metadata, and every analyzer then reported zero on data it never
 * saw. The exact figure is used as a floor with headroom: a capture with a
 * single event is already several kilobytes, so a trace this small cannot be a
 * measurement of anything.
 */
const SKELETON_MAX_BYTES = 2048;

/** Node's setTimeout 32-bit limit; the daemon takes whole seconds anyway. */
const MAX_DURATION_MS = 2_147_483_647;

/** How many device-output lines an error message may quote. */
const DETAIL_MAX_LINES = 5;

function detail(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '(no output)';
  const shown = lines.slice(0, DETAIL_MAX_LINES).join(' | ');
  return lines.length > DETAIL_MAX_LINES
    ? `${shown} | ... (${lines.length - DETAIL_MAX_LINES} more lines)`
    : shown;
}

function combined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HIPROFILER_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_DURATION_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_DURATION_MS} (got ${String(durationMs)})`,
      { code: 'HIPROFILER_BAD_DURATION' },
    );
  }
}

/** hiprofiler_cmd takes whole seconds; a partial second must not truncate to 0. */
export function secondsFor(durationMs: number): number {
  return Math.ceil(durationMs / 1000);
}

/**
 * The session command. `-t` is the daemon-side duration: unlike hitrace, the
 * daemon owns the clock, so the host does not need to sleep.
 */
export function hiprofilerCommand(seconds: number): string {
  return `hiprofiler_cmd -c ${DEVICE_CONFIG_PATH} -o ${DEVICE_OUTPUT_PATH} -t ${seconds} -s -k`;
}

export class HiprofilerCollector implements Collector {
  readonly id = 'hiprofiler';
  readonly provides: CapabilityId[] = [
    'trace.frames',
    'mem.native_hook',
    'mem.gpu',
    'power.xpower',
  ];

  /**
   * Run one profiler session into `layout.traceFile`.
   *
   * The plugin templates and the config envelope are validated before the
   * first device call, so a bad pid or a too-small buffer never costs a
   * session. The device is left clean in a `finally`: the fixed paths are
   * removed and a `hiprofiler_cmd --kill` is issued, because a transport
   * failure would otherwise leave the daemon holding a session and every
   * later start would fail.
   */
  async collect(
    hdc: Hdc,
    target: string,
    opts: HiprofilerCollectOptions,
    layout: SceneLayout,
  ): Promise<void> {
    assertDuration(opts.durationMs);
    if (opts.plugins.length === 0) {
      // A session with no plugins records nothing; the daemon would either
      // reject it or complete with an empty trace that reads as a quiet app.
      throw new OhosPerfError('hiprofiler requires at least one plugin', {
        code: 'HIPROFILER_BAD_PLUGIN',
      });
    }
    const config = buildHiprofilerConfig({
      plugins: opts.plugins,
      ...(opts.bufferPages === undefined ? {} : { bufferPages: opts.bufferPages }),
    });

    mkdirSync(layout.root, { recursive: true });
    const hostConfig = join(layout.root, 'hiprofiler.cfg');
    writeFileSync(hostConfig, config, 'utf8');

    try {
      await hdc.shell(target, `rm -f ${DEVICE_CONFIG_PATH} ${DEVICE_OUTPUT_PATH}`);
      await hdc.send(target, hostConfig, DEVICE_CONFIG_PATH);

      const session = await hdc.shell(target, hiprofilerCommand(secondsFor(opts.durationMs)));
      if (!combined(session).includes(DONE_MARKER)) {
        throw new OhosPerfError(
          `hiprofiler session failed: expected "${DONE_MARKER}"; device output: ` +
            detail(combined(session)),
          { code: 'HIPROFILER_SESSION_FAILED' },
        );
      }

      const listing = await hdc.shell(target, `ls -l ${DEVICE_OUTPUT_PATH}`);
      const size = parseSize(listing.stdout, DEVICE_OUTPUT_PATH);
      if (size === undefined || size <= 0) {
        throw new OhosPerfError(
          `hiprofiler produced no trace output at ${DEVICE_OUTPUT_PATH}` +
            ` (${size === undefined ? 'file not found' : 'file is empty'});` +
            ` ls -l output: ${detail(combined(listing))}`,
          { code: 'HIPROFILER_NO_OUTPUT' },
        );
      }
      if (size <= SKELETON_MAX_BYTES) {
        // The session completed but recorded nothing, so the file is the
        // container skeleton rather than a measurement. Failing here is what
        // keeps a quiet capture from being analyzed as a fast one.
        throw new OhosPerfError(
          `hiprofiler wrote ${size} bytes to ${DEVICE_OUTPUT_PATH}, which is the` +
            ` container skeleton and holds no events: the session ran but recorded` +
            ` nothing. Check that the target app was running and that the plugins` +
            ` asked for are supported by this device.` +
            ` ls -l output: ${detail(combined(listing))}`,
          { code: 'HIPROFILER_NO_OUTPUT' },
        );
      }

      // Receive to a sibling temp path and rename only after the transfer
      // completes: hdc truncates/creates the destination before streaming, so
      // a dropped target would otherwise leave a partial `.htrace` that a
      // later `ingestScene` converts as if the capture had completed. The
      // rename also preserves a previous scene's trace on failure.
      const partial = `${layout.traceFile}.partial`;
      try {
        await hdc.recv(target, DEVICE_OUTPUT_PATH, partial);
        renameSync(partial, layout.traceFile);
      } finally {
        try {
          rmSync(partial, { force: true });
        } catch {
          // Best effort: never replace the transfer failure.
        }
      }
    } finally {
      await this.killBestEffort(hdc, target);
      try {
        await hdc.shell(target, `rm -f ${DEVICE_CONFIG_PATH} ${DEVICE_OUTPUT_PATH}`);
      } catch {
        // Deliberately swallowed; the original failure is what the caller sees.
      }
      rmSync(hostConfig, { force: true });
    }
  }

  /** Never throws: this runs while an error is propagating. */
  private async killBestEffort(hdc: Hdc, target: string): Promise<void> {
    try {
      await hdc.shell(target, 'hiprofiler_cmd --kill');
    } catch {
      // Deliberately swallowed.
    }
  }
}
