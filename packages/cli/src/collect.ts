import { OhosPerfError } from '@ohos-perf/core';

/**
 * Parse `--duration <seconds>` into milliseconds.
 *
 * Accepts a bare number (`10`) or the same number with a trailing `s` (`10s`).
 * A duration of zero, a negative value, `NaN`/`Infinity`, or anything that is
 * not a finite positive number is rejected with an error that names the bad
 * value: the CLI prints that message on stderr and exits 1, so an ambiguous
 * "invalid duration" would leave the user unable to tell what was wrong.
 *
 * Kept here (not in `commands.ts`) so commander can validate a value without
 * the pure command layer depending on parsing rules.
 */
export function parseDurationSeconds(raw: string): number {
  const text = raw.trim();
  // A single optional `s` suffix; no whitespace, no unit other than seconds.
  const match = /^(\d+(?:\.\d+)?|\.\d+)s?$/.exec(text);
  const seconds = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new OhosPerfError(
      `invalid --duration ${JSON.stringify(raw)}: expected a positive number of seconds (e.g. 10 or 10s)`,
      { code: 'COLLECT_BAD_DURATION' },
    );
  }
  return seconds * 1000;
}
