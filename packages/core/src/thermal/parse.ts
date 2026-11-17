/**
 * The `hidumper -s ThermalService -a '-t'` output, parsed.
 *
 * The device prints one pair per sensor, surrounded by service headers:
 *
 *     Type: Battery
 *     Temperature: 31000
 *
 * HapRay normalizes by magnitude — a value at or above 1000 is millidegrees,
 * otherwise plain Celsius — and discards the original number. Here the raw
 * value and the unit it was read in travel with the normalized Celsius value,
 * so a consumer can see that the conversion was an inference rather than a
 * reading. The rule is HapRay's, measured on two devices: the Mate 60 reports
 * all sensors in millidegrees, while a recorded device reports `modem` in
 * plain Celsius.
 *
 * The parser only reads; deciding that an empty result is a failed capture is
 * the collector's job.
 */

import { round2HalfEven } from '../rounding';

/** The unit a reading was reported in, before normalization. */
export type ThermalUnit = 'celsius' | 'millidegree_celsius';

/** One sensor's value from one device sample. */
export interface ThermalReading {
  readonly sensor: string;
  /** The device's own number, unchanged. */
  readonly raw: number;
  readonly unit: ThermalUnit;
  /** `raw / 1000` for millidegrees, else `raw`; two decimals, as HapRay reports. */
  readonly celsius: number;
}

const TYPE = 'Type:';
const TEMPERATURE = 'Temperature:';

/**
 * A decimal literal, the only temperature form the service prints. `Number()`
 * is not usable alone for the check: it turns `''` into 0 and `0x10` into 16,
 * either of which would turn a blank field into a real-looking reading.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function bySensor(a: ThermalReading, b: ThermalReading): number {
  return a.sensor < b.sensor ? -1 : a.sensor > b.sensor ? 1 : 0;
}

/**
 * Parse one device dump into readings sorted by sensor name.
 *
 * A temperature with no preceding type, a non-numeric temperature, and a
 * repeated sensor are not errors: hidumper headers are normal, the pair rule
 * is the device's own, and a repeated type resolves to the last value (as
 * HapRay's dict does). Duplicate sensors are collapsed, never averaged.
 */
export function parseThermalOutput(text: string): ThermalReading[] {
  const byName = new Map<string, ThermalReading>();
  let current: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(TYPE)) {
      current = line.slice(TYPE.length).trim();
      continue;
    }
    if (!line.startsWith(TEMPERATURE)) continue;
    if (current === undefined || current === '') continue;

    const value = line.slice(TEMPERATURE.length).trim();
    if (!DECIMAL.test(value)) {
      current = undefined;
      continue;
    }
    const raw = Number(value);
    const unit: ThermalUnit =
      Math.abs(raw) >= 1000 ? 'millidegree_celsius' : 'celsius';
    const celsius = round2HalfEven(unit === 'millidegree_celsius' ? raw / 1000 : raw);
    byName.set(current, { sensor: current, raw, unit, celsius });
    current = undefined;
  }

  return [...byName.values()].sort(bySensor);
}
