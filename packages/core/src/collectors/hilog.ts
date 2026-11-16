import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CapabilityId } from '../device/capability';
import { OhosPerfError } from '../errors';
import type { SceneLayout } from '../ingest/scene';
import type { Hdc } from '../transport/hdc';
import type { Collector } from './types';

/** The command whose stdout is the log stream. */
export const HILOG_COMMAND = 'hilog';

/**
 * `hilog` streams until stopped; the host clock bounds the capture. This is
 * the same pattern as hitrace, where `--trace_begin` is also host-timed.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new OhosPerfError(
      `durationMs must be a finite number greater than 0 (got ${String(durationMs)})`,
      { code: 'HILOG_BAD_DURATION' },
    );
  }
  if (durationMs > MAX_TIMEOUT_MS) {
    throw new OhosPerfError(
      `durationMs must not exceed ${MAX_TIMEOUT_MS} ms (the 32-bit setTimeout limit)` +
        ` (got ${String(durationMs)})`,
      { code: 'HILOG_BAD_DURATION' },
    );
  }
}

function removeStale(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Captures the device's hilog stream into the scene.
 *
 * The output is the raw log text, one line per record. Parsing happens
 * offline (`parseHilogText`), so the artifact is exactly what the device
 * printed and a parser change never requires a re-capture.
 */
export class HilogCollector implements Collector {
  readonly id = 'hilog';
  readonly provides: CapabilityId[] = ['hilog.stream'];

  async collect(
    hdc: Hdc,
    target: string,
    opts: { durationMs: number },
    layout: SceneLayout,
  ): Promise<{ lines: number }> {
    assertDuration(opts.durationMs);
    removeStale(layout.hilogFile);

    const result = await hdc.shellFor(target, HILOG_COMMAND, opts.durationMs);
    const text = result.stdout;
    // hdc exits 0 even when the device tool fails, so the only success signal
    // is content. An empty stream is a failed capture, never a quiet app.
    if (text.trim() === '') {
      throw new OhosPerfError(
        `hilog produced no output in ${opts.durationMs} ms` +
          (result.stderr.trim() === '' ? '' : `; device stderr: ${result.stderr.trim().slice(0, 200)}`),
        { code: 'HILOG_NO_OUTPUT' },
      );
    }

    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.hilogFile, text);
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    return { lines };
  }
}

/**
 * Read the captured log back.
 *
 * Returns `undefined` when the scene has no `hilog.log`: an absent artifact
 * is a scene that never captured logs, and the analyzer turns that into a
 * degraded reason rather than an empty measurement.
 */
export function readHilogText(layout: SceneLayout): string | undefined {
  if (!existsSync(layout.hilogFile)) return undefined;
  return readFileSync(layout.hilogFile, 'utf8');
}
