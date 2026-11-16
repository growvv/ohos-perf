import { MAX_QUERY_LIMIT, OhosPerfError, resolveQueryLimit } from '@ohos-perf/core';

/**
 * `query`'s flag parsers.
 *
 * Both live here rather than in commander option parsers so a bad value takes
 * the same failure path as every other CLI error: empty stdout, one message
 * on stderr, exit 1 — and, for `--args`, before any scene file is opened.
 */

/** Parse `--args` as a JSON object; arrays, scalars and null are rejected. */
export function parseQueryArgs(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OhosPerfError('invalid --args: not valid JSON', { code: 'QUERY_BAD_ARGS' });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OhosPerfError('invalid --args: expected a JSON object', { code: 'QUERY_BAD_ARGS' });
  }
  return value as Record<string, unknown>;
}

/**
 * Parse `--limit` with the same bounds the library enforces.
 *
 * A non-integer is rejected here rather than coerced: `Number('abc')` is
 * `NaN`, and a message about `NaN` does not tell the caller which value was
 * wrong. `resolveQueryLimit` still owns the range rule and its message.
 */
export function parseLimit(raw: string): number {
  const text = raw.trim();
  const bad = (): OhosPerfError =>
    new OhosPerfError(
      `limit must be an integer between 1 and ${MAX_QUERY_LIMIT}, got ${JSON.stringify(raw)}`,
      { code: 'QUERY_BAD_LIMIT' },
    );
  if (!/^-?\d+$/.test(text)) throw bad();
  try {
    return resolveQueryLimit(Number(text));
  } catch {
    // The range rule is the library's; only the message is re-worded so it
    // names the value the caller typed.
    throw bad();
  }
}
