import { OhosPerfError } from '@ohos-perf/core';

/** The strategies the walk implements, in the order help lists them. */
const STRATEGIES = ['depth_first', 'breadth_first', 'random'] as const;

/**
 * Parse `--strategy`, refusing anything the walk does not implement.
 *
 * Commander cannot enumerate the values itself (it has no choices option), so
 * the refusal lives here — in the command layer, before any device is touched.
 * Falling back to a default would be worse than refusing: the walk would run
 * with an order the caller did not ask for and report it under their word.
 */
export function parseStrategy(raw: string): 'depth_first' | 'breadth_first' | 'random' {
  const found = STRATEGIES.find((strategy) => strategy === raw);
  if (found === undefined) {
    throw new OhosPerfError(
      `explore: unknown strategy ${JSON.stringify(raw)};` +
        ` use one of ${STRATEGIES.join(', ')}`,
      { code: 'SCENARIO_BAD_STRATEGY' },
    );
  }
  return found;
}

/**
 * Parse `--max-steps`, refusing zero and negatives.
 *
 * A walk of zero steps reaches one screen and reports nothing, which is a
 * successful-looking run that did no work. HapRay's default is 30.
 */
export function parseMaxSteps(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OhosPerfError(
      `explore: --max-steps must be a positive integer (got ${JSON.stringify(raw)})`,
      { code: 'SCENARIO_BAD_STEPS' },
    );
  }
  return value;
}
