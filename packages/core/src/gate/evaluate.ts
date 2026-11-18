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

/** Round to 3 decimals so a percentage is byte-stable across platforms. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isNumeric(metric: Metric | undefined): metric is Metric & { value: number } {
  return metric !== undefined && typeof metric.value === 'number';
}

/** Why a metric cannot be judged at all, or `undefined` when it can. */
function unavailable(metric: Metric | undefined, id: string): string | undefined {
  if (metric === undefined) return `the run emitted no ${id}`;
  if (metric.degraded !== undefined) return `${id} is degraded: ${metric.degraded.reason}`;
  if (typeof metric.value !== 'number') {
    return `${id} is not numeric (${typeof metric.value})`;
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
    return value <= bound.limit
      ? { id, status: 'pass', value, bound }
      : { id, status: 'fail', value, bound, excess: round3(value - bound.limit) };
  }
  if (bound.kind === 'min') {
    return value >= bound.limit
      ? { id, status: 'pass', value, bound }
      : { id, status: 'fail', value, bound, excess: round3(bound.limit - value) };
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
    return delta <= bound.limit
      ? { id, status: 'pass', value, baseline: base, bound }
      : { id, status: 'fail', value, baseline: base, bound, excess: round3(delta - bound.limit) };
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
  return pct <= bound.limit
    ? { id, status: 'pass', value, baseline: base, bound }
    : { id, status: 'fail', value, baseline: base, bound, excess: round3(pct - bound.limit) };
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
