import { OhosPerfError, resolveQueryLimit } from '@ohos-perf/core';

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

/** Parse `--limit` with the same bounds the library enforces. */
export function parseLimit(raw: string): number {
  return resolveQueryLimit(Number(raw));
}
