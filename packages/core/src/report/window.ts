import type { TimeRange } from '../types';

/*
 * How a report states the span it measured.
 *
 * An analysis with no capture window — `analyze` over a scene whose trace has
 * no `trace_range`, or a hand-built fixture — is windowed over the whole
 * database and marked with `0 … MAX_SAFE_INTEGER`. Printed as numbers that
 * reads as a 285-year span, so every page that states a window says the same
 * words instead of exposing the sentinel.
 *
 * One copy serves the report and the flamegraph page, so the two cannot
 * describe the same capture differently.
 */

/** True when a range is the whole-database marker rather than a measured span. */
export function isWholeCapture(window: TimeRange): boolean {
  return window.endNs >= Number.MAX_SAFE_INTEGER;
}

/** A window a reader can act on: `1000 – 2000 ns`, or the whole capture. */
export function windowText(window: TimeRange): string {
  if (isWholeCapture(window)) return 'the whole capture';
  return `${window.startNs} – ${window.endNs} ns`;
}
