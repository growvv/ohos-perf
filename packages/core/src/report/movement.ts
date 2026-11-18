import type { AnalyzeResult } from '../analyze/types';
import type { Fidelity } from '../device/capability';
import { OhosPerfError } from '../errors';
import { METRIC_DIRECTIONS, type MetricDirection } from './compare';
import type { EvidenceKind } from './evidence';
import type { Metric, MetricUnit } from './metric';

/**
 * Cross-run movement (P32): what changed between two measured runs, and by how
 * much, decided by this package's own direction vocabulary.
 *
 * HapRay's `PerfMulti.vue` draws a line per metric across report files and
 * leaves the reading to a human with four dropdowns; its `root_cause` reads one
 * run and never sees a second. The question a reader asks after a regression —
 * "what changed between the release that was fine and this one?" — needs the
 * two halves this module joins: the numbers on both sides, and the rule that
 * decides what "moved" means.
 *
 * Three rules are load-bearing, and each comes from a defect this package has
 * already paid for:
 *
 * 1. **A gap is never a movement.** A metric one run did not emit, or emitted
 *    as a skipped analyzer's degraded zero, is `gap` on that side — never
 *    `improved`, never a delta. This is the rule `buildTrend` settled for its
 *    series, and it matters more here: a root-cause report that opens with
 *    "jank rate improved from 12% to 0" sends the reader after the wrong
 *    problem.
 * 2. **The caller owns the direction.** `from` is always the baseline the
 *    caller named and `to` always the input, whatever their capture times say.
 *    Sorting by `startedAtNs` (as `buildTrend` does for its x axis) would
 *    silently invert every verdict when a baseline was captured later.
 * 3. **No percentage of zero.** A baseline of 0 gives `delta` without
 *    `deltaPct`; an infinite percentage is not a useful number and cannot be
 *    serialized to JSON as one.
 *
 * The direction of every metric id is {@link METRIC_DIRECTIONS}; a metric that
 * is not in it has no known direction and is reported `incomparable` with its
 * delta recorded — a rise is neither good nor bad, and guessing is worse than
 * admitting ignorance.
 */

/** How one metric moved between the two runs. */
export type MovementStatus = 'regressed' | 'improved' | 'unchanged' | 'incomparable' | 'gap';

/** One run's identity and measured result, as the movement sees it. */
export interface MovementInput {
  readonly label: string;
  readonly app: string;
  readonly device: string;
  readonly startedAtNs?: number;
  readonly result: AnalyzeResult;
}

/** The identity of one side, copied into the document so it needs no other file. */
export interface MovementSide {
  readonly label: string;
  readonly app: string;
  readonly device: string;
  readonly startedAtNs?: number;
}

export interface MovementRow {
  readonly id: string;
  readonly unit: MetricUnit;
  /** The baseline value; `null` when that run did not measure it. */
  readonly from: number | string | null;
  /** The current value; `null` when that run did not measure it. */
  readonly to: number | string | null;
  /** `to - from`; absent unless both sides are numeric. */
  readonly delta?: number;
  /** Percent over `|from|`; absent when `from` is 0 or either side is not numeric. */
  readonly deltaPct?: number;
  /**
   * Each side's fidelity; `null` for a side with no value.
   *
   * A movement compares two measurements, and `compare`/`buildTrend` both carry
   * fidelity for the same reason: an approximate baseline read against an exact
   * run is a weaker claim than two exact ones, and a row that dropped the
   * distinction would present them alike. The pair is kept per side because a
   * run can change how it measures a metric between captures.
   */
  readonly fidelity: { readonly from: Fidelity | null; readonly to: Fidelity | null };
  readonly status: MovementStatus;
  /** Why a side is a gap; present only when `status === 'gap'`. */
  readonly gap?: { readonly side: 'from' | 'to' | 'both'; readonly reason: string };
}

/** How many findings of one kind each run produced. */
export interface MovementEvidenceRow {
  readonly kind: EvidenceKind;
  readonly from: number;
  readonly to: number;
  readonly delta: number;
}

export interface RootCauseMovement {
  readonly from: MovementSide;
  readonly to: MovementSide;
  /** One sentence naming the worst regression, or stating that nothing regressed. */
  readonly verdict: string;
  /** Total order: regressed, improved, unchanged, incomparable, gap; then magnitude; then id. */
  readonly rows: readonly MovementRow[];
  /** Every kind either run reported, sorted by kind. */
  readonly evidence: readonly MovementEvidenceRow[];
  readonly totals: {
    readonly regressed: number;
    readonly improved: number;
    readonly unchanged: number;
    readonly incomparable: number;
    readonly gaps: number;
    /** `*.degraded` proxy metrics, which are gap markers and never rows. */
    readonly skipped: number;
  };
}

/** The status groups, in the order a reader wants them: bad news first. */
const GROUP_ORDER: Record<MovementStatus, number> = {
  regressed: 0,
  improved: 1,
  unchanged: 2,
  incomparable: 3,
  gap: 4,
};

/** Round to 3 decimals so a percentage is byte-stable across platforms. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The proxy id the engine writes for a skipped analyzer. */
const DEGRADED_SUFFIX = '.degraded';

/** One side's value: `null` when the run did not measure the metric. */
function sideValue(metric: Metric | undefined): number | string | null {
  if (metric === undefined || metric.degraded !== undefined) return null;
  return metric.value;
}

/** Why one side has no value, for a gap row's reason. */
function gapReason(id: string, metric: Metric | undefined, side: 'from' | 'to'): string {
  if (metric === undefined) return `the ${side} run emitted no ${id}`;
  return `${id} is degraded in the ${side} run: ${metric.degraded?.reason ?? 'no reason recorded'}`;
}

/**
 * Classify a numeric change against a known direction.
 *
 * `delta === 0` is `unchanged` regardless of direction: a metric that did not
 * move did not improve.
 */
function classify(direction: MetricDirection, delta: number): MovementStatus {
  if (delta === 0) return 'unchanged';
  if (direction === 'lower') return delta < 0 ? 'improved' : 'regressed';
  return delta > 0 ? 'improved' : 'regressed';
}

/** The movement of one metric id, given each side's metric (if any). */
function judge(id: string, before: Metric | undefined, after: Metric | undefined): MovementRow {
  const from = sideValue(before);
  const to = sideValue(after);
  const unit = (after ?? before)!.unit;
  // A side with no value has no fidelity either: `degraded` metrics are
  // skipped entirely, and an absent one was never measured.
  const fidelity = {
    from: from === null ? null : before!.fidelity,
    to: to === null ? null : after!.fidelity,
  };

  if (from === null || to === null) {
    const side = from === null && to === null ? 'both' : from === null ? 'from' : 'to';
    const reason = from === null
      ? gapReason(id, before, 'from')
      : gapReason(id, after, 'to');
    return { id, unit, from, to, fidelity, status: 'gap', gap: { side, reason } };
  }

  const numeric = typeof from === 'number' && typeof to === 'number';
  if (!numeric) {
    return { id, unit, from, to, fidelity, status: 'incomparable' };
  }

  const delta = to - from;
  const deltaPct = from === 0 ? undefined : round3(((to - from) / Math.abs(from)) * 100);
  const direction = METRIC_DIRECTIONS[id];
  const status = direction === undefined ? 'incomparable' : classify(direction, delta);
  return {
    id,
    unit,
    from,
    to,
    delta,
    ...(deltaPct === undefined ? {} : { deltaPct }),
    fidelity,
    status,
  };
}

/**
 * Rank rows for a reader: bad news first, then by how large the move was.
 *
 * Inside a group, a percentage is the comparable magnitude (a +200% on a 10 ms
 * figure and a +200% on a 900 MB figure are the same claim about the app), so
 * it sorts first; a row without one — a zero baseline — sorts by its absolute
 * delta, and the id breaks every remaining tie so the order is total.
 */
function compareRows(a: MovementRow, b: MovementRow): number {
  const group = GROUP_ORDER[a.status] - GROUP_ORDER[b.status];
  if (group !== 0) return group;
  if (a.status === 'gap') return byString(a.id, b.id);

  const pctA = a.deltaPct === undefined ? undefined : Math.abs(a.deltaPct);
  const pctB = b.deltaPct === undefined ? undefined : Math.abs(b.deltaPct);
  if (pctA !== pctB) {
    if (pctA === undefined) return 1;
    if (pctB === undefined) return -1;
    return pctB - pctA;
  }
  const deltaA = Math.abs(a.delta ?? 0);
  const deltaB = Math.abs(b.delta ?? 0);
  if (deltaA !== deltaB) return deltaB - deltaA;
  return byString(a.id, b.id);
}

/** Count evidence items by kind, so two runs' findings can be compared. */
function countKinds(result: AnalyzeResult): Map<EvidenceKind, number> {
  const counts = new Map<EvidenceKind, number>();
  for (const item of result.evidence) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * A value as the verdict sentence prints it: three decimals, no trailing
 * zeros.
 *
 * The row keeps the measured value — a reader comparing two runs needs the
 * number — but the sentence is prose, and "regressed from 4.733727810650888 to
 * 69.26406926406926" is a number only a machine reads.
 */
function spoken(value: number | string | null): string {
  if (typeof value !== 'number') return String(value);
  return String(round3(value));
}

/** One sentence from the ranked rows: the worst regression, or what did move. */
function verdictFor(from: MovementSide, to: MovementSide, rows: readonly MovementRow[]): string {
  const prefix = `${from.label} → ${to.label}: `;
  const regressions = rows.filter((row) => row.status === 'regressed');
  const worst = regressions[0];
  if (worst !== undefined) {
    const pct = worst.deltaPct === undefined ? '' : ` (${worst.deltaPct}%)`;
    const others = regressions.length - 1;
    return `${prefix}${worst.id} regressed from ${spoken(worst.from)} to ${spoken(worst.to)}${pct}`
      + (others === 0 ? '' : `, and ${others} other regression${others === 1 ? '' : 's'}`);
  }
  const improved = rows.filter((row) => row.status === 'improved').length;
  if (improved > 0) {
    return `nothing regressed between ${from.label} and ${to.label};`
      + ` ${improved} metric${improved === 1 ? '' : 's'} improved`;
  }
  return `nothing comparable moved between ${from.label} and ${to.label}`;
}

function sideOf(run: MovementInput): MovementSide {
  return {
    label: run.label,
    app: run.app,
    device: run.device,
    ...(run.startedAtNs === undefined ? {} : { startedAtNs: run.startedAtNs }),
  };
}

/**
 * Compare two runs and rank what moved.
 *
 * `from` is the baseline and `to` the current run, in that order, whatever
 * their capture times say. Throws rather than filtering when the runs measure
 * different apps: a movement across two apps is the app changing, not the app
 * changing behaviour, and a report that averaged the two would be false.
 * `device` is deliberately not refused — the document names both.
 */
export function buildMovement(from: MovementInput, to: MovementInput): RootCauseMovement {
  if (from.app !== to.app) {
    throw new OhosPerfError(
      `root-cause: the baseline measures ${from.app} and the input measures ${to.app};` +
        ' a movement is only comparable within one app',
      { code: 'ROOT_CAUSE_APP_MISMATCH' },
    );
  }

  const before = new Map(from.result.metrics.map((metric) => [metric.id, metric]));
  const after = new Map(to.result.metrics.map((metric) => [metric.id, metric]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  const rows: MovementRow[] = [];
  let skipped = 0;
  for (const id of ids) {
    // A skipped analyzer's proxy is a marker, not a metric: it is the same
    // zero on both sides by construction, and a row for it would say the
    // analyzer's absence did not change, which is not a measurement.
    if (id.endsWith(DEGRADED_SUFFIX)) {
      skipped += 1;
      continue;
    }
    rows.push(judge(id, before.get(id), after.get(id)));
  }
  rows.sort(compareRows);

  const beforeKinds = countKinds(from.result);
  const afterKinds = countKinds(to.result);
  const kinds = [...new Set([...beforeKinds.keys(), ...afterKinds.keys()])].sort(byString);
  const evidence: MovementEvidenceRow[] = kinds.map((kind) => {
    const start = beforeKinds.get(kind) ?? 0;
    const end = afterKinds.get(kind) ?? 0;
    return { kind, from: start, to: end, delta: end - start };
  });

  const totals = {
    regressed: rows.filter((row) => row.status === 'regressed').length,
    improved: rows.filter((row) => row.status === 'improved').length,
    unchanged: rows.filter((row) => row.status === 'unchanged').length,
    incomparable: rows.filter((row) => row.status === 'incomparable').length,
    gaps: rows.filter((row) => row.status === 'gap').length,
    skipped,
  };

  const fromSide = sideOf(from);
  const toSide = sideOf(to);
  return {
    from: fromSide,
    to: toSide,
    verdict: verdictFor(fromSide, toSide, rows),
    rows,
    evidence,
    totals,
  };
}
