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
 * into an almost instantaneous one. IEEE-754 artifacts within 1e-6 of a whole
 * millisecond are rounded to that integer. Every rejection names the value.
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
  const rawMs = seconds * 1000;
  if (!Number.isFinite(rawMs) || rawMs > MAX_TIMEOUT_MS) {
    throw bad('duration exceeds the 32-bit setTimeout limit');
  }
  // Decimal seconds are inexact in IEEE-754 (`1.001 * 1000` is
  // `1000.9999999999999`). A value within 1e-6 of a whole millisecond is that
  // whole millisecond; anything further away is a genuine fractional ms (e.g.
  // `1.0005` → `1000.5`) or a sub-millisecond duration and must be rejected.
  const durationMs = Math.round(rawMs);
  if (Math.abs(rawMs - durationMs) >= 1e-6) {
    throw bad('duration is not a whole number of milliseconds');
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 ||
      durationMs > MAX_TIMEOUT_MS) {
    throw bad('duration is not a positive whole number of milliseconds within the 32-bit limit');
  }
  return durationMs;
}
