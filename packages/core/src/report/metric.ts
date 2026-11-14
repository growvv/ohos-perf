import type { Fidelity } from '../device/capability';
import type { TimeRange } from '../types';

/**
 * Unit of a metric value. `none` is for dimensionless values such as rates,
 * ratios expressed as plain numbers, or identifiers.
 */
export type MetricUnit = 'ms' | 'fps' | '%' | 'count' | 'bytes' | 'none';

/**
 * Where a metric came from.
 *
 * `collector` names the pipeline that produced the value, `table`/`rows` pin it
 * to a concrete database table and row count when one exists, and `device`
 * identifies the device class the value describes.
 */
export interface Provenance {
  collector: string;
  table?: string;
  rows?: number;
  device: string;
}

export interface Metric {
  /** Stable semantic id, e.g. `frame.jank.rate`. */
  id: string;
  value: number | string;
  unit: MetricUnit;
  window?: TimeRange;
  provenance: Provenance;
  /**
   * How directly the value measures what its id claims. Required: a caller
   * always knows whether the value is exact, approximate, or a proxy, and
   * defaulting it would silently mislabel data.
   */
  fidelity: Fidelity;
  degraded?: { reason: string; fallback: string };
}

/**
 * Builds a {@link Metric}, filling `unit` with `'none'` when omitted.
 *
 * Returns a new object; the input is never mutated. Nothing else is defaulted
 * — in particular `fidelity` must be supplied by the caller.
 */
export function metric(input: Omit<Metric, 'unit'> & { unit?: MetricUnit }): Metric {
  return { ...input, unit: input.unit ?? 'none' };
}
