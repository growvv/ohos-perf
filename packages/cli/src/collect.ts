import {
  HIPROFILER_PLUGIN_NAMES,
  OhosPerfError,
  type HiprofilerPluginName,
} from '@ohos-perf/core';

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

/** The thermal sampler's accepted interval range, in seconds. */
const MIN_THERMAL_INTERVAL_S = 0.1;
const MAX_THERMAL_INTERVAL_S = 3600;

/**
 * Parse `--thermal-interval <seconds>` into the integer milliseconds the
 * collector takes.
 *
 * 0.1 s is the collector's own floor (below it, successive `hidumper` calls
 * overlap); 3600 s is an hour, past which a capture interval cannot be shorter
 * than its own run. The value must resolve to a whole millisecond for the same
 * reason `--duration` does, and every rejection names the value.
 */
export function parseThermalIntervalSeconds(raw: string): number {
  const text = raw.trim();
  const match = /^(\d+(?:\.\d+)?|\.\d+)s?$/.exec(text);
  const seconds = match === null ? Number.NaN : Number(match[1]);

  const bad = (why: string): OhosPerfError =>
    new OhosPerfError(
      `invalid --thermal-interval ${JSON.stringify(raw)}: ${why}` +
        ` (expected a thermal interval between ${MIN_THERMAL_INTERVAL_S}` +
        ` and ${MAX_THERMAL_INTERVAL_S} seconds, e.g. 1 or 5)`,
      { code: 'COLLECT_BAD_THERMAL_INTERVAL' },
    );

  if (!Number.isFinite(seconds)) {
    throw bad('expected a number of seconds');
  }
  if (seconds < MIN_THERMAL_INTERVAL_S || seconds > MAX_THERMAL_INTERVAL_S) {
    throw bad(`the interval must be between ${MIN_THERMAL_INTERVAL_S}` +
      ` and ${MAX_THERMAL_INTERVAL_S} seconds`);
  }
  const rawMs = seconds * 1000;
  const intervalMs = Math.round(rawMs);
  if (Math.abs(rawMs - intervalMs) >= 1e-6) {
    throw bad('the interval is not a whole number of milliseconds');
  }
  return intervalMs;
}

/**
 * Parse `--plugins gpu,xpower` into the names `Device.collect` accepts.
 *
 * Names are validated here, before any device is touched, so a typo cannot
 * start a session with a plugin the daemon does not know. An empty list and
 * empty elements are rejected rather than silently skipped: `--plugins ,`
 * reads as "I chose plugins" and must not fall back to the default.
 */
export function parsePluginList(raw: string): HiprofilerPluginName[] {
  const names = raw.split(',').map((name) => name.trim());
  if (names.length === 0 || names.some((name) => name === '')) {
    throw new OhosPerfError(
      `invalid --plugins ${JSON.stringify(raw)}: expected a comma-separated list of ` +
        HIPROFILER_PLUGIN_NAMES.join(', '),
      { code: 'COLLECT_BAD_PLUGIN' },
    );
  }
  const plugins: HiprofilerPluginName[] = [];
  for (const name of names) {
    if (!(HIPROFILER_PLUGIN_NAMES as readonly string[]).includes(name)) {
      throw new OhosPerfError(
        `unknown hiprofiler plugin ${JSON.stringify(name)};` +
          ` expected one of ${HIPROFILER_PLUGIN_NAMES.join(', ')}`,
        { code: 'COLLECT_BAD_PLUGIN' },
      );
    }
    if (!plugins.includes(name as HiprofilerPluginName)) {
      plugins.push(name as HiprofilerPluginName);
    }
  }
  return plugins;
}
