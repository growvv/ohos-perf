import { describe, it, expect } from 'vitest';
import { maxOf, minOf } from '../src/extremes';

/*
 * `Math.max(...values)` puts one argument on the call stack per element, and
 * V8 throws `RangeError: Maximum call stack size exceeded` somewhere around
 * 124k–200k arguments. Every one of these helpers' call sites reads a length
 * the user's data decides: samples in a capture, points in a trend, suspects
 * in a scan. A capture long enough to matter is exactly the capture a user
 * runs the tool on, so the extremes have to be computed without spreading.
 *
 * The codebase already knows this — `empty-frame.ts` and `rs-skip.ts` both
 * carry a "a reduce, not Math.min(...)" comment — but the other call sites
 * were written without it.
 */

describe('maxOf', () => {
  it('returns the largest value', () => {
    expect(maxOf([3, 1, 4, 1, 5])).toBe(5);
    expect(maxOf([-2, -7])).toBe(-2);
  });

  it('throws on an empty array rather than returning -Infinity', () => {
    // A caller that reaches here with nothing has a bug upstream; returning
    // -Infinity would render as a number and hide it.
    expect(() => maxOf([])).toThrow();
  });

  it('handles 200k values, which Math.max(...values) cannot', () => {
    const values = new Array<number>(200_000);
    for (let index = 0; index < values.length; index++) values[index] = index % 997;
    expect(maxOf(values)).toBe(996);
    // The failure this guards against, for the record: the spread form throws.
    expect(() => Math.max(...values)).toThrow(RangeError);
  });
});

describe('minOf', () => {
  it('returns the smallest value', () => {
    expect(minOf([3, 1, 4, 1, 5])).toBe(1);
    expect(minOf([-2, -7])).toBe(-7);
  });

  it('throws on an empty array', () => {
    expect(() => minOf([])).toThrow();
  });

  it('handles 200k values', () => {
    const values = new Array<number>(200_000);
    for (let index = 0; index < values.length; index++) values[index] = index % 997;
    expect(minOf(values)).toBe(0);
  });
});
