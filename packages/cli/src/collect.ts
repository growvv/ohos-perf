import { OhosPerfError } from '@ohos-perf/core';

/** Node's setTimeout (and hitrace's own duration gate) clamp above this to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Parse `--duration <seconds>` into milliseconds.
 *
 * Accepts a bare number (`10`) or the same number with a trailing `s` (`10s`).
 * The resulting millisecond value must be a positive integer within
 * `(0, 2^31 - 1]`, matching `HitraceCollector`'s own gate: a sub-millisecond
 * or fractional-millisecond value would become `0`/a fraction that the
 * collector rejects anyway, and a value above the 32-bit setTimeout limit is
 * silently clamped to 1 ms. Accepting either here would turn a short capture
 * into an almost instantaneous one. Every rejection names the offending value.
 *
 * Kept here (not in `commands.ts`) so commander can validate a value without
 * the pure command layer depending on parsing rules.
 */
export function parseDurationSeconds(raw: string): number {
  const text = raw.trim();
  // A single optional `s` suffix; no whitespace, no unit other than seconds.
  const match = /^(\d+(?:\.\d+)?|\.\d+)s?$/.exec(text);
  const seconds = match === null ? Number.NaN : Number(match[1]);

  const bad = (why: string): OhosPerfError =>
    new OhosPerfError(
      `invalid --duration ${JSON.stringify(raw)}: ${why}` +
        ` (expected a positive whole number of milliseconds, e.g. 10 or 10s)`,
      { code: 'COLLECT_BAD_DURATION' },
    );

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw bad('expected a positive number of seconds');
  }
  const durationMs = seconds * 1000;
  if (!Number.isFinite(durationMs) || durationMs > MAX_TIMEOUT_MS) {
    throw bad('duration exceeds the 32-bit setTimeout limit');
  }
  if (!Number.isSafeInteger(durationMs)) {
    throw bad('duration is not a whole number of milliseconds');
  }
  return durationMs;
}
