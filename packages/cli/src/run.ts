/**
 * Argument parsing for `ohos-perf run`.
 *
 * Kept out of `program.ts` so commander can validate a value without the pure
 * command layer depending on the parsing rules, and out of `commands.ts` for
 * the same reason `collect.ts` exists.
 */

import { OhosPerfError } from '@ohos-perf/core';

/**
 * Parse `--only open,scroll` into step ids.
 *
 * An empty element is rejected rather than skipped: `--only open,` reads as
 * "I named two steps", and silently running one would report a run that does
 * not match the request. Order is preserved here and ignored by the runner,
 * which runs steps in scenario order.
 */
export function parseOnly(raw: string): string[] {
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.some((id) => id === '')) {
    throw new OhosPerfError(
      `invalid --only ${JSON.stringify(raw)}: an empty step id names no step;` +
        ' expected a comma-separated list of ids',
      { code: 'SCENARIO_BAD_ONLY' },
    );
  }
  return ids;
}
