/**
 * Judging a measured run against its budgets.
 *
 * The rule that shapes this module: a gate may only pass on data it has. A
 * metric the run did not emit, a metric the engine degraded to a zero proxy,
 * a non-numeric value and a percentage against a zero baseline are all
 * `missing` — never a comfortable pass. That is the difference between a gate
 * and a threshold check, and it is why this capability is worth having at all:
 * a job that goes green because the analyzer stopped running is worse than no
 * job.
 */

import type { AnalyzeResult } from '../analyze/types';
import type { Metric } from '../report/metric';
import type { BudgetBound, BudgetDocument, BudgetEntry } from './schema';

export type GateStatus = 'pass' | 'fail' | 'missing';

export interface GateVerdict {
  readonly id: string;
  readonly status: GateStatus;
  /** The measured value; absent when the metric was not measured. */
  readonly value?: number;
  /** The baseline value, for a delta bound. */
  readonly baseline?: number;
  /** The bound as the document wrote it. */
  readonly bound: BudgetBound;
  /** How far past the bound the value was, in the bound's own unit; only on `fail`. */
  readonly excess?: number;
  /** Why the metric could not be judged; only on `missing`. */
  readonly reason?: string;
}

export interface GateResult {
  readonly name: string;
  /** `fail` when any verdict is not `pass`. */
  readonly status: 'pass' | 'fail';
  /** In document order — `parseBudgetDocument` already sorted by id. */
  readonly verdicts: readonly GateVerdict[];
  readonly totals: { readonly pass: number; readonly fail: number; readonly missing: number };
}

/**
 * Round to 3 decimals so a percentage is byte-stable across platforms, but
 * never round a real excess down to zero: a verdict of `fail` with `(0 past)`
 * tells the reader the gate contradicted itself.
 */
function excess(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 && value > 0 ? value : rounded;
}

/**
 * The slack a comparison allows.
 *
 * Binary floating point makes an exactly-compliant value land a hair over its
 * bound: 11 stuttered of 20 rendered frames is `55.00000000000001`, and 16.8
 * against 16 ms is a `5.000000000000004`% rise. Without slack a run that met
 * its budget fails the build, which is the worst failure a gate can have. The
 * slack is relative to the bound and far below any measurement's resolution,
 * so a genuine violation (55.0001 against 55) still fails.
 */
function tolerance(limit: number): number {
  return 1e-9 * Math.max(1, Math.abs(limit));
}

function isNumeric(metric: Metric | undefined): metric is Metric & { value: number } {
  // `typeof NaN === 'number'`: a value the analyzer could not compute is not a
  // measurement, and judging it would produce a verdict with no number behind
  // it (and `null` once serialized).
  return (
    metric !== undefined &&
    typeof metric.value === 'number' &&
    Number.isFinite(metric.value)
  );
}

/** Why a metric cannot be judged at all, or `undefined` when it can. */
function unavailable(metric: Metric | undefined, id: string): string | undefined {
  if (metric === undefined) return `the run emitted no ${id}`;
  if (metric.degraded !== undefined) return `${id} is degraded: ${metric.degraded.reason}`;
  if (typeof metric.value !== 'number') {
    return `${id} is not numeric (${typeof metric.value})`;
  }
  if (!Number.isFinite(metric.value)) {
    return `${id} is not numeric (${String(metric.value)})`;
  }
  return undefined;
}

/** Judge one entry; every branch returns exactly one verdict. */
function judge(
  entry: BudgetEntry,
  current: Metric | undefined,
  baseline: Metric | undefined,
): GateVerdict {
  const { id, bound } = entry;

  const why = unavailable(current, id);
  if (why !== undefined) {
    return { id, status: 'missing', bound, reason: why };
  }
  // `unavailable` guarantees a numeric value; this keeps the type honest
  // without a non-null assertion.
  if (!isNumeric(current)) {
    return { id, status: 'missing', bound, reason: `the run emitted no ${id}` };
  }
  const value = current.value;

  if (bound.kind === 'max') {
    return value <= bound.limit + tolerance(bound.limit)
      ? { id, status: 'pass', value, bound }
      : { id, status: 'fail', value, bound, excess: excess(value - bound.limit) };
  }
  if (bound.kind === 'min') {
    return value >= bound.limit - tolerance(bound.limit)
      ? { id, status: 'pass', value, bound }
      : { id, status: 'fail', value, bound, excess: excess(bound.limit - value) };
  }

  // Delta bounds: the baseline is required, and a percentage of zero is not a
  // number this gate will invent.
  const baseWhy = unavailable(baseline, id);
  if (baseWhy !== undefined) {
    const reason =
      baseline === undefined
        ? `the baseline emitted no ${id}`
        : baseline.degraded !== undefined
          ? `the baseline ${id} is degraded: ${baseline.degraded.reason}`
          : typeof baseline.value !== 'number'
            ? `the baseline ${id} is not numeric (${typeof baseline.value})`
            : baseWhy;
    return { id, status: 'missing', bound, reason };
  }
  if (!isNumeric(baseline)) {
    return { id, status: 'missing', bound, reason: `the baseline emitted no ${id}` };
  }
  const base = baseline.value;

  if (bound.kind === 'maxDelta') {
    const delta = value - base;
    return delta <= bound.limit + tolerance(bound.limit)
      ? { id, status: 'pass', value, baseline: base, bound }
      : {
          id,
          status: 'fail',
          value,
          baseline: base,
          bound,
          excess: excess(delta - bound.limit),
        };
  }

  // `maxDeltaPct`: divide by the magnitude, so -100 -> -90 reads as a 10% fall
  // toward zero rather than a -10% one.
  if (base === 0) {
    return {
      id,
      status: 'missing',
      bound,
      reason: `a percentage of a zero ${id} baseline is undefined`,
    };
  }
  const pct = ((value - base) / Math.abs(base)) * 100;
  return pct <= bound.limit + tolerance(bound.limit)
    ? { id, status: 'pass', value, baseline: base, bound }
    : {
        id,
        status: 'fail',
        value,
        baseline: base,
        bound,
        excess: excess(pct - bound.limit),
      };
}

/**
 * Evaluate every budget in `doc` against `current`, and against `baseline` for
 * the delta bounds.
 *
 * No IO, no sorting, no mutation of the inputs: the caller owns reading the
 * two runs, and the document already carries its own order. A missing
 * baseline is not an error here — it is a `missing` verdict for each delta
 * budget — because the core function must not guess what the CLI could have
 * refused before opening anything.
 */
export function evaluateGate(
  doc: BudgetDocument,
  current: AnalyzeResult,
  baseline?: AnalyzeResult,
): GateResult {
  const now = new Map(current.metrics.map((metric) => [metric.id, metric]));
  const before = new Map((baseline?.metrics ?? []).map((metric) => [metric.id, metric]));

  const verdicts = doc.budgets.map((entry) =>
    judge(entry, now.get(entry.id), before.get(entry.id)),
  );

  const totals = { pass: 0, fail: 0, missing: 0 };
  for (const verdict of verdicts) totals[verdict.status] += 1;

  return {
    name: doc.name,
    status: totals.pass === verdicts.length ? 'pass' : 'fail',
    verdicts,
    totals,
  };
}

/** The canonical `gate.json`, matching `analyze --json`: two spaces, trailing newline. */
export function renderGateJson(result: GateResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}
