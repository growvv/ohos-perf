import type { AnalyzeResult } from '../analyze/types';
import type { Fidelity } from '../device/capability';
import type { MetricUnit } from './metric';

/**
 * Which way a metric improves.
 *
 * A metric id absent from {@link METRIC_DIRECTIONS} has no known direction:
 * a rise is neither good nor bad, so the comparison reports it as
 * `incomparable` rather than guessing. Guessing is worse than admitting
 * ignorance here — a baseline report that calls a regression an improvement
 * sends the reader after the wrong problem.
 */
export type MetricDirection = 'lower' | 'higher';

/**
 * The direction of every metric the analyzers emit.
 *
 * Frame throughput counts are higher-is-better (`frame.fps`,
 * `frame.count`, `frame.rendered.count`); every frame quality rate and every
 * latency, memory, redundant-thread and startup figure is lower-is-better.
 * `fault.*` counters are event counts whose meaning depends on the event, so
 * they are deliberately absent. Degraded proxies are absent too: a
 * `*.degraded` zero is not a measurement to compare.
 */
export const METRIC_DIRECTIONS: Readonly<Record<string, MetricDirection>> = {
  'frame.avg.duration': 'lower',
  'frame.count': 'higher',
  'frame.empty.rate': 'lower',
  'frame.fps': 'higher',
  'frame.jank.rate': 'lower',
  'frame.rendered.count': 'higher',

  'binder.interfaces.count': 'lower',
  'binder.latency.avg': 'lower',
  'binder.latency.max': 'lower',
  'binder.process.pairs': 'lower',
  'binder.thread.pairs': 'lower',
  'binder.transactions.count': 'lower',

  'thread.instructions.total': 'lower',
  'thread.patterns.count': 'lower',
  'thread.redundant.count': 'lower',
  'thread.redundant.instructions': 'lower',
  'thread.redundant.instructions.ratio': 'lower',

  'mem.measure.rss.avg': 'lower',
  'mem.measure.rss.peak': 'lower',
  'mem.pss.mean': 'lower',
  'mem.pss.peak': 'lower',
  'mem.rss.mean': 'lower',
  'mem.rss.peak': 'lower',
  'mem.samples': 'lower',

  'startup.count': 'lower',
  'startup.duration': 'lower',

  'render.fps.live': 'higher',
  'render.hitch.count': 'lower',
};

export type DeltaStatus =
  | 'improved'
  | 'regressed'
  | 'unchanged'
  | 'added'
  | 'removed'
  | 'incomparable';

/** Every status, in the order `totals` lists them. */
const STATUSES: readonly DeltaStatus[] = [
  'improved', 'regressed', 'unchanged', 'added', 'removed', 'incomparable',
];

export interface MetricDelta {
  readonly id: string;
  readonly unit: MetricUnit;
  readonly baseline: number | string | null;
  readonly current: number | string | null;
  /** Numeric difference (current - baseline); absent for non-numeric or added/removed. */
  readonly delta?: number;
  /** Percent change; absent when baseline is 0 or either side is non-numeric. */
  readonly deltaPct?: number;
  readonly fidelity: Fidelity;
  readonly status: DeltaStatus;
}

export interface BaselineComparison {
  readonly rows: MetricDelta[];
  /** Count of rows per status; all six keys are always present. */
  readonly totals: Record<DeltaStatus, number>;
}

/** Round to 3 decimals so a percentage is byte-stable across platforms. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Classify a numeric change against a known direction.
 *
 * `delta === 0` is `unchanged` regardless of direction: a metric that did not
 * move did not improve, and reporting it as one would inflate the improved
 * count with noise.
 */
function classify(direction: MetricDirection, delta: number): DeltaStatus {
  if (delta === 0) return 'unchanged';
  if (direction === 'lower') return delta < 0 ? 'improved' : 'regressed';
  return delta > 0 ? 'improved' : 'regressed';
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compare two analyses metric by metric.
 *
 * The rows are the union of both metric id sets sorted by id, so the output is
 * byte-identical for the same inputs (D5) and two runs can be diffed directly.
 * Only metrics present on both sides with numeric values can be improved or
 * regressed; everything else is reported as what it is — `added`, `removed`,
 * or `incomparable` — and never silently dropped.
 *
 * `deltaPct` divides by `|baseline|`, so a metric that moved from -10 to -5
 * reads as a 50% change toward zero rather than a sign-flipped one. A zero
 * baseline has no percentage: every change is infinitely large, which is not
 * a useful number.
 */
export function compareResults(
  baseline: AnalyzeResult,
  current: AnalyzeResult,
): BaselineComparison {
  const before = new Map(baseline.metrics.map((metric) => [metric.id, metric]));
  const after = new Map(current.metrics.map((metric) => [metric.id, metric]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  const rows: MetricDelta[] = ids.map((id) => {
    const start = before.get(id);
    const end = after.get(id);

    if (start === undefined && end !== undefined) {
      return {
        id, unit: end.unit, baseline: null, current: end.value,
        fidelity: end.fidelity, status: 'added',
      };
    }
    if (start !== undefined && end === undefined) {
      return {
        id, unit: start.unit, baseline: start.value, current: null,
        fidelity: start.fidelity, status: 'removed',
      };
    }
    // Both sides exist; the branch above guarantees `end` too, but keep the
    // types honest without a non-null assertion.
    if (start === undefined || end === undefined) {
      throw new Error(`unreachable: ${id} present on neither side`);
    }

    const base = start.value;
    const cur = end.value;
    const numeric = typeof base === 'number' && typeof cur === 'number';
    const direction = METRIC_DIRECTIONS[id];
    const delta = numeric ? cur - base : undefined;
    const deltaPct =
      numeric && base !== 0 ? round3(((cur - base) / Math.abs(base)) * 100) : undefined;
    const status: DeltaStatus =
      numeric && direction !== undefined ? classify(direction, cur - base) : 'incomparable';

    return {
      id,
      unit: end.unit,
      baseline: base,
      current: cur,
      ...(delta === undefined ? {} : { delta }),
      ...(deltaPct === undefined ? {} : { deltaPct }),
      fidelity: end.fidelity,
      status,
    };
  });

  const totals = Object.fromEntries(STATUSES.map((status) => [status, 0])) as
    Record<DeltaStatus, number>;
  for (const row of rows) totals[row.status] += 1;

  rows.sort(byId);
  return { rows, totals };
}
