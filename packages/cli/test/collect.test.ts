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
});
