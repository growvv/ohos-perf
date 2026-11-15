import { describe, it, expect } from 'vitest';
import { parseDurationSeconds } from '../src/collect';

/**
 * Duration parsing is a pure rule: `collect.ts` owns it so `program.ts` can
 * stay free of validation and `commands.ts` can stay free of process/IO.
 */
describe('parseDurationSeconds', () => {
  it('parses a bare number of seconds into milliseconds', () => {
    expect(parseDurationSeconds('10')).toBe(10_000);
  });

  it('accepts a trailing s suffix (10s)', () => {
    expect(parseDurationSeconds('10s')).toBe(10_000);
    expect(parseDurationSeconds('1.5s')).toBe(1_500);
  });

  it('rejects zero, negative, non-finite and non-numeric values', () => {
    for (const bad of ['0', '0s', '-1', '-2.5s', 'abc', '', '  ', 'NaN', 'Infinity', '1x']) {
      expect(() => parseDurationSeconds(bad), `value ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('names the offending value in the error message', () => {
    for (const bad of ['0', '-1', 'abc', 'NaN', '1x']) {
      expect(() => parseDurationSeconds(bad)).toThrow(new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('rejects a duration whose millisecond value overflows the hitrace limit', () => {
    for (const bad of ['1' + '0'.repeat(306), '3e9', '999999999999']) {
      expect(() => parseDurationSeconds(bad), `value ${bad}`).toThrow(/duration/);
      expect(() => parseDurationSeconds(bad)).toThrow(bad);
    }
  });

  it('rejects sub-millisecond and fractional-millisecond durations', () => {
    for (const bad of ['0.0001', '1.0005', '0.0000001']) {
      expect(() => parseDurationSeconds(bad), `value ${bad}`).toThrow(/duration/);
      expect(() => parseDurationSeconds(bad)).toThrow(bad);
    }
  });

  it('accepts whole-millisecond values including 10s', () => {
    expect(parseDurationSeconds('10s')).toBe(10_000);
    expect(parseDurationSeconds('0.001')).toBe(1);
    expect(parseDurationSeconds('2147483.647')).toBe(2_147_483_647);
  });
});
