import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc } from '../transport/hdc';
import type { Collector, TraceCollectOptions } from './types';

/**
 * Default trace categories, matching HapRay `command_templates.py:36-60`.
 * All 25 were confirmed present on the emulator with `hitrace -l`.
 */
export const HITRACE_DEFAULT_CATEGORIES: string[] = [
  'ability', 'ace', 'app', 'ark', 'binder', 'disk', 'freq', 'graphic', 'idle',
  'irq', 'memreclaim', 'mmc', 'multimodalinput', 'notification', 'ohos',
  'pagecache', 'rpc', 'sched', 'sync', 'window', 'workq', 'zaudio', 'zcamera',
  'zimage', 'zmedia',
];

/** HapRay's `buffer_size_kb`. */
const DEFAULT_BUFFER_KB = 204800;

/**
 * Fixed device-side path. The directory accumulates files across sessions, so
 * collect() removes this path before recording and re-checks it afterwards.
 */
const DEVICE_TRACE_PATH = '/data/local/tmp/ohosperf_trace.htrace';

/**
 * hitrace's own success markers. hdc exits 0 even when hitrace fails, so these
 * strings — not the exit code — are the success signal.
 */
const BEGIN_MARKER = 'OpenRecording done';
const FINISH_MARKER = 'trace read done';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `durationMs` must be a finite positive number. Silently clamping 0, NaN or a
 * negative value to zero would produce a zero-length capture that later reads
 * as "the UI was static"; an unbounded value would hang the process. Rejecting
 * is the only outcome the caller can act on.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HITRACE_BAD_DURATION' },
    );
  }
}

/** stdout and stderr together; hitrace's diagnostics may land on either. */
function combined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** One-line excerpt of device output for an error message. */
function detail(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '(no output)';
}

/**
 * Parse the byte count of `path` from `ls -l` output.
 *
 * A line matches only when its **last** whitespace-separated token is exactly
 * `path`. Substring matching would also accept `/x/trace.htrace.bak` and
 * `/x/trace.htrace2`; the device directory accumulates files, so decoys are
 * realistic and must not be read as this capture's output.
 *
 * Android's toybox and GNU both put the size in the fifth field (after mode,
 * links, owner, group), but scanning from there for the first all-digit token
 * tolerates the date/time columns in either format.
 *
 * Exported for direct unit testing; it is a pure function.
 */
export function parseSize(output: string, path: string): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || tokens[tokens.length - 1] !== path) continue;
    for (let i = 4; i < tokens.length; i++) {
      if (/^\d+$/.test(tokens[i])) return Number(tokens[i]);
    }
  }
  return undefined;
}

export class HitraceCollector implements Collector {
  readonly id = 'hitrace';
  readonly provides: CapabilityId[] = [
    'trace.frames',
    'trace.sched',
    'trace.binder',
    'trace.thread_state',
    'render.vsync',
  ];

  /**
   * `-t` is deliberately absent: measured on the emulator, `--trace_begin -t 2`
   * kept recording for the full 8s host window. `--trace_begin` is long
   * recording mode, where `-t` has no effect; the host times the capture.
   */
  beginCommand(opts: TraceCollectOptions): string {
    const bufferKb = opts.bufferKb ?? DEFAULT_BUFFER_KB;
    const categories = opts.categories ?? HITRACE_DEFAULT_CATEGORIES;
    return `hitrace --trace_begin -b ${bufferKb} ${categories.join(' ')}`;
  }

  finishCommand(devicePath: string): string {
    return `hitrace --trace_finish -o ${devicePath}`;
  }

  /**
   * Capture one trace to `layout.traceFile`.
   *
   * The step order is load-bearing:
   *   1. remove the fixed device path so a failed capture cannot return a
   *      stale file from an earlier session;
   *   2. begin and require `OpenRecording done` (hdc exit 0 is not enough);
   *   3. wait the host-side duration;
   *   4. finish and require `trace read done`;
   *   5. require the file to exist with size > 0 before transferring;
   *   6. recv (which validates its own `FileTransfer finish` marker).
   *
   * Nothing is transferred unless every check above passes, so a failed or
   * empty capture can never overwrite `layout.traceFile` with stale data.
   *
   * `opts.durationMs` must be a finite number greater than 0; anything else
   * throws `HITRACE_BAD_DURATION` before the device is touched.
   */
  async collect(
    hdc: Hdc,
    target: string,
    opts: TraceCollectOptions,
    layout: SceneLayout,
  ): Promise<void> {
    assertDuration(opts.durationMs);

    const devicePath = DEVICE_TRACE_PATH;

    await hdc.shell(target, `rm -f ${devicePath}`);

    const begin = await hdc.shell(target, this.beginCommand(opts));
    if (!combined(begin).includes(BEGIN_MARKER)) {
      throw new OhosPerfError(
        `hitrace begin failed: expected "${BEGIN_MARKER}"; device output: ${detail(combined(begin))}`,
        { code: 'HITRACE_BEGIN_FAILED' },
      );
    }

    await delay(opts.durationMs);

    const finish = await hdc.shell(target, this.finishCommand(devicePath));
    if (!combined(finish).includes(FINISH_MARKER)) {
      throw new OhosPerfError(
        `hitrace finish failed: expected "${FINISH_MARKER}"; device output: ${detail(combined(finish))}`,
        { code: 'HITRACE_FINISH_FAILED' },
      );
    }

    const listing = await hdc.shell(target, `ls -l ${devicePath}`);
    const size = parseSize(listing.stdout, devicePath);
    if (size === undefined || size <= 0) {
      throw new OhosPerfError(
        `hitrace produced no trace output at ${devicePath}` +
          ` (${size === undefined ? 'file not found' : 'file is empty'});` +
          ` ls -l output: ${detail(combined(listing))}`,
        { code: 'HITRACE_NO_OUTPUT' },
      );
    }

    await hdc.recv(target, devicePath, layout.traceFile);
  }
}
