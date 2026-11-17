import { describe, it, expect } from 'vitest';
import {
  parseDurationSeconds, parsePluginList, parseThermalIntervalSeconds,
} from '../src/collect';

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

  // Fix round 2, item 3: decimal seconds such as 1.001 produce
  // 1000.9999999999999 ms in IEEE-754; that is a float artifact, not a
  // fractional millisecond, and must round to the exact integer.
  it('rounds decimal-second float artifacts to exact milliseconds', () => {
    expect(parseDurationSeconds('1.001')).toBe(1_001);
    expect(parseDurationSeconds('2.006')).toBe(2_006);
    expect(parseDurationSeconds('4.001')).toBe(4_001);
    expect(parseDurationSeconds('1.001s')).toBe(1_001);
  });

  it('still rejects a genuinely fractional millisecond', () => {
    for (const bad of ['0.0001', '1.0005', '0.0000001']) {
      expect(() => parseDurationSeconds(bad), `value ${bad}`).toThrow(/duration/);
      expect(() => parseDurationSeconds(bad)).toThrow(bad);
    }
  });
});

describe('parsePluginList', () => {
  it('splits, trims and deduplicates names', () => {
    expect(parsePluginList(' gpu, xpower ,gpu ')).toEqual(['gpu', 'xpower']);
  });

  it('rejects an unknown plugin', () => {
    expect(() => parsePluginList('gpu,nope')).toThrow(/nope/);
    expect(() => parsePluginList('gpu,nope')).toThrow(
      /ftrace, gpu, xpower, nativehook/,
    );
  });

  it('rejects empty elements instead of silently skipping them', () => {
    for (const bad of ['', ',', 'gpu,', ',gpu', 'gpu,,xpower']) {
      expect(() => parsePluginList(bad), `value ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe('parseThermalIntervalSeconds', () => {
  it('parses seconds into whole milliseconds', () => {
    expect(parseThermalIntervalSeconds('1')).toBe(1_000);
    expect(parseThermalIntervalSeconds('0.1')).toBe(100);
    expect(parseThermalIntervalSeconds('2s')).toBe(2_000);
    expect(parseThermalIntervalSeconds('3600')).toBe(3_600_000);
  });

  it('rejects intervals outside 0.1–3600 seconds', () => {
    for (const bad of ['0', '0.05', '3600.001', '-1', 'abc', '', 'NaN', 'Infinity']) {
      expect(() => parseThermalIntervalSeconds(bad), `value ${JSON.stringify(bad)}`)
        .toThrow(/thermal interval/);
    }
  });

  it('names the offending value', () => {
    expect(() => parseThermalIntervalSeconds('0')).toThrow(/"0"/);
    expect(() => parseThermalIntervalSeconds('abc')).toThrow(/"abc"/);
  });
});
