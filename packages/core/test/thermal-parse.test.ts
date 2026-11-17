import { describe, it, expect } from 'vitest';
import { parseThermalOutput } from '../src/thermal/parse';

/*
 * The device output is a stream of `Type:` / `Temperature:` pairs surrounded
 * by hidumper headers. Two facts must survive the parse:
 *
 * - the raw number and the unit it was reported in, because HapRay's
 *   magnitude rule (`>= 1000` means millidegrees) is an inference this
 *   package records rather than hides;
 * - every sensor the device actually reported, in a deterministic order.
 *
 * The sample below is the measured Mate 60 output (2026-11-18). HapRay's own
 * test fixture records a `modem` sensor that reports plain Celsius on another
 * device, which is why the unit decision is per reading.
 */

const REAL_DEVICE_OUTPUT = `
-------------------------------[ability]-------------------------------


----------------------------------ThermalService----------------------------------
Type: Battery
Temperature: 31000
Type: ambient
Temperature: 22393
Type: charger
Temperature: 31050
Type: dot
Temperature: 29428
Type: rfboard
Temperature: 29952
Type: shell_back
Temperature: 30022
Type: shell_frame
Temperature: 30709
Type: shell_front
Temperature: 30496
Type: system_h
Temperature: 31400
`;

describe('parseThermalOutput', () => {
  it('reads every sensor from the measured device output, in name order', () => {
    const readings = parseThermalOutput(REAL_DEVICE_OUTPUT);
    expect(readings.map((r) => r.sensor)).toEqual([
      'Battery',
      'ambient',
      'charger',
      'dot',
      'rfboard',
      'shell_back',
      'shell_frame',
      'shell_front',
      'system_h',
    ]);
  });

  it('keeps the raw value and records the inferred unit', () => {
    const byName = new Map(parseThermalOutput(REAL_DEVICE_OUTPUT).map((r) => [r.sensor, r]));
    expect(byName.get('Battery')).toEqual({
      sensor: 'Battery',
      raw: 31000,
      unit: 'millidegree_celsius',
      celsius: 31,
    });
    expect(byName.get('dot')).toEqual({
      sensor: 'dot',
      raw: 29428,
      unit: 'millidegree_celsius',
      celsius: 29.43,
    });
  });

  it('does not divide a sensor that already reports Celsius', () => {
    // HapRay's recorded fixture: `modem` reports 27 for 27 °C.
    expect(parseThermalOutput('Type: modem\nTemperature: 27\n')).toEqual([
      { sensor: 'modem', raw: 27, unit: 'celsius', celsius: 27 },
    ]);
  });

  it('ignores headers, unrelated lines and a temperature with no type', () => {
    expect(parseThermalOutput('Temperature: 26000\n')).toEqual([]);
    expect(parseThermalOutput('some header\nType: rfboard\n')).toEqual([]);
  });

  it('drops only the pair whose temperature is not a number', () => {
    const text = 'Type: bad\nTemperature: not-a-number\nType: good\nTemperature: 25000\n';
    expect(parseThermalOutput(text)).toEqual([
      { sensor: 'good', raw: 25000, unit: 'millidegree_celsius', celsius: 25 },
    ]);
  });

  it('does not fabricate a reading from a blank or non-decimal temperature', () => {
    // `Number('')` is 0 and `Number('0x10')` is 16, so an empty or truncated
    // field used to become a real-looking 0 °C (or 16 °C) reading.
    const text = [
      'Type: blank',
      'Temperature:',
      'Type: spaces',
      'Temperature:    ',
      'Type: hex',
      'Temperature: 0x10',
      'Type: good',
      'Temperature: 25000',
    ].join('\n');
    expect(parseThermalOutput(text)).toEqual([
      { sensor: 'good', raw: 25000, unit: 'millidegree_celsius', celsius: 25 },
    ]);
  });

  it('keeps the last reading when one output repeats a sensor', () => {
    const text = 'Type: x\nTemperature: 1000\nType: x\nTemperature: 2000\n';
    expect(parseThermalOutput(text)).toEqual([
      { sensor: 'x', raw: 2000, unit: 'millidegree_celsius', celsius: 2 },
    ]);
  });

  it('returns an empty list for empty or header-only output', () => {
    expect(parseThermalOutput('')).toEqual([]);
    expect(parseThermalOutput('\n\n--- ThermalService ---\n')).toEqual([]);
  });
});
