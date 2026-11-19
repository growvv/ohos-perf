/**
 * Extremes of a numeric array, without spreading it into a call.
 *
 * `Math.max(...values)` passes one argument per element, and V8 throws
 * `RangeError: Maximum call stack size exceeded` once the array reaches
 * roughly 124k–200k elements. Every caller here reads a length the user's
 * capture decides — samples in a thermal trace, points in a trend, suspects
 * in a scan — so the long capture that matters most is exactly the one the
 * spread form fails on.
 *
 * The codebase already documents this hazard at the call sites that were
 * written with it in mind (`analyze/empty-frame.ts`, `analyze/rs-skip.ts`);
 * these two functions exist so the rest do not have to rediscover it.
 */

/** The largest value. Throws on an empty array, where `Math.max()` returns -Infinity. */
export function maxOf(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('maxOf: empty array');
  let best = values[0]!;
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value > best) best = value;
  }
  return best;
}

/** The smallest value. Throws on an empty array, where `Math.min()` returns Infinity. */
export function minOf(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('minOf: empty array');
  let best = values[0]!;
  for (let index = 1; index < values.length; index++) {
    const value = values[index]!;
    if (value < best) best = value;
  }
  return best;
}
