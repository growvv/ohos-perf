import type { TimeRange } from '../types';
import type { Evidence, EvidenceKind } from './evidence';
import type { RootCauseMovement } from './movement';

/**
 * The root-cause document (HapRay parity row 36).
 *
 * HapRay's `root-cause` reads its own report JSON files, hands them to a model,
 * and writes Markdown. The artifact is empty without an endpoint: `--skip-llm`
 * writes "Pending Agent Inference" placeholders, so a run with no model produces
 * nothing a reader can use.
 *
 * This module is the half that does not need a model. It ranks the evidence the
 * analyzers already produced — by *our* severities, in a total order — and
 * states a verdict from the highest one. The model, when there is one, adds a
 * `suspects` array on top; it never supplies the ranking.
 *
 * That split is the point. A model asked "what is the root cause" answers with
 * prose that cannot be checked. A model asked "here are 14 evidence items, cite
 * the ids you are reasoning from" can have its citations verified, which is what
 * {@link RootCauseSuspect.ungrounded} records.
 */

/**
 * The root-cause document schema. A change to any shape below bumps this.
 *
 * Version 2 added the optional `movement` block. An additive field is still a
 * shape change: a consumer that switches on the version needs to know that a
 * document may now carry a second run's numbers, and a version that stayed at 1
 * would make the two shapes indistinguishable.
 */
export const ROOT_CAUSE_SCHEMA_VERSION = 2;

/** Who produced the document; the version is the CLI package version. */
export interface RootCauseGenerator {
  name: string;
  version: string;
}

/** The scene the document describes. Inputs are copied, never referenced. */
export interface RootCauseScene {
  app: string;
  device: string;
  window: TimeRange;
}

/** One evidence item, restated so a reader needs no other file. */
export interface RootCauseObservation {
  /** The `Evidence.id` this restates; the model cites these. */
  evidenceId: string;
  kind: EvidenceKind;
  severity: 'info' | 'warn' | 'critical';
  /** The analyzer's own sentence, verbatim. */
  explain: string;
  subject: { process: string; thread?: string; frameNo?: number };
  /** The measured facts, copied verbatim from the evidence item. */
  signals: Record<string, number | string | readonly string[]>;
}

/** One cause a model proposed, with the citations that back it. */
export interface RootCauseSuspect {
  /** 1-based, in the order the model returned them. */
  rank: number;
  /** The evidence ids the model cited that this run actually produced. */
  evidenceIds: string[];
  /**
   * Moved metric ids the model attributes the change to. Checked against the
   * movement's own rows: an id that did not move is not a measured change, so
   * it is recorded in {@link ungrounded} instead of being presented as one.
   */
  metrics: string[];
  rootCause: string;
  fix: string;
  confidence: 'high' | 'medium' | 'low';
  /**
   * Names the model cited that no evidence carried. A non-empty list means the
   * suspect is *not* grounded in this run: the reader is told rather than being
   * shown an invented file, symbol or thread as though it were measured.
   */
  ungrounded: string[];
  triggerChain?: string;
}

/** The model's contribution, present only when a model answered. */
export interface RootCauseAnalysis {
  model: string;
  summary: string;
  suspects: RootCauseSuspect[];
  caveats: string[];
  needsMoreData: string[];
}

/** The deterministic verdict, always present. */
export interface RootCauseSummary {
  totals: {
    info: number;
    warn: number;
    critical: number;
    /**
     * How many observations are measurement gaps rather than findings. A run
     * over a sparse capture is mostly gaps, and a reader has to be able to tell
     * "nothing was wrong" from "nothing could be measured".
     */
    gaps: number;
  };
  /** One sentence, from the highest-severity observation. */
  verdict: string;
}

/** The complete, versioned document. */
export interface RootCauseDocument {
  schemaVersion: typeof ROOT_CAUSE_SCHEMA_VERSION;
  generator: RootCauseGenerator;
  scene: RootCauseScene;
  summary: RootCauseSummary;
  /** Ranked by severity then id: a total order, so two runs agree. */
  observations: RootCauseObservation[];
  /**
   * What changed between the baseline and this run, when the caller supplied
   * one. Absent means no baseline was given, which is a different fact from a
   * baseline whose runs happened to agree.
   */
  movement?: RootCauseMovement;
  analysis?: RootCauseAnalysis;
}

/** Everything {@link buildRootCauseDocument} needs; all values are measured. */
export interface RootCauseInput {
  app: string;
  device: string;
  window: TimeRange;
  generator: RootCauseGenerator;
  evidence: readonly Evidence[];
  /** The baseline-to-input movement, when the caller compared two runs. */
  movement?: RootCauseMovement;
}

/** Severity as a sort key: higher is more urgent. */
const SEVERITY_RANK: Record<Evidence['severity'], number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/**
 * Rank evidence for a reader: most urgent first, ties broken by id.
 *
 * The tie-break is not cosmetic. Without it the order depends on the input
 * array, and two runs over the same capture would produce documents that diff
 * against each other for no reason — the same defect the rest of this package
 * spends its determinism tests preventing.
 */
export function rankObservations(evidence: readonly Evidence[]): RootCauseObservation[] {
  return [...evidence]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => ({
      evidenceId: item.id,
      kind: item.kind,
      severity: item.severity,
      explain: item.explain,
      // Only the identity a reader needs; `pid` and `rule` are not part of the
      // narrative and would make the document's shape depend on the analyzer.
      subject: {
        process: item.subject.process,
        ...(item.subject.thread === undefined ? {} : { thread: item.subject.thread }),
        ...(item.subject.frameNo === undefined ? {} : { frameNo: item.subject.frameNo }),
      },
      signals: { ...item.signals },
    }));
}

/** Count each severity, so the summary can state the shape of the run. */
function countSeverities(
  evidence: readonly Evidence[],
): RootCauseSummary['totals'] {
  const totals = { info: 0, warn: 0, critical: 0, gaps: 0 };
  for (const item of evidence) {
    totals[item.severity] += 1;
    if (isGap(item)) totals.gaps += 1;
  }
  return totals;
}

/**
 * Whether an evidence item reports a gap rather than a finding.
 *
 * Three shapes are gaps, and each is a different way of saying "nothing was
 * measured here":
 *
 * - `degraded_capability` — the analyzer could not run at all;
 * - `no_data` — the capture did not carry the input the analyzer reads;
 * - an item with **no signals** — it carries no measured fact, so whatever it
 *   says is about the capture, not about the app. The `startup` analyzer's
 *   "no startup data" item is this shape while a measured startup carries its
 *   duration, which is why the kind alone is not enough.
 *
 * The distinction exists because a root-cause report that opens with "hilog
 * skipped" has told the reader nothing about performance. Severity cannot make
 * that distinction: a skipped analyzer is a `warn` and a measured jank is also
 * a `warn`.
 */
function isGap(item: Evidence): boolean {
  if (item.kind === 'degraded_capability' || item.kind === 'no_data') return true;
  return Object.keys(item.signals).length === 0;
}

/**
 * Whether an observation restates a gap rather than a finding.
 *
 * The same three shapes {@link isGap} recognizes, restated over the document's
 * own type so the verdict and the totals cannot disagree about what a gap is.
 */
function observationIsGap(item: RootCauseObservation): boolean {
  if (item.kind === 'degraded_capability' || item.kind === 'no_data') return true;
  return Object.keys(item.signals).length === 0;
}

/**
 * The one-sentence verdict.
 *
 * With a finding, it is that observation's own sentence: the analyzer already
 * explained what it measured, and rewriting that would be a second opinion
 * nobody asked for. Gaps are skipped — "hilog skipped: missing hilog.stream"
 * is why nothing was measured, not what went wrong — so a sparse capture does
 * not open with the collector it lacked. When every observation is a gap the
 * verdict says the run measured nothing, which is a different fact from a run
 * that measured and found nothing.
 */
function verdictFor(
  ranked: readonly RootCauseObservation[],
  total: number,
  gaps: number,
): string {
  if (total === 0) {
    return 'no evidence was produced for this scene, so there is nothing to explain';
  }
  const finding = ranked.find((item) => !observationIsGap(item));
  if (finding === undefined) {
    return `nothing was measured: all ${total} observation${total === 1 ? '' : 's'}`
      + ' report a gap in the capture, not a finding about the app';
  }
  const more = total === 1
    ? ''
    : ` (and ${total - 1} other observation${total === 2 ? '' : 's'}`
      + `${gaps === 0 ? '' : `, ${gaps} of them gaps in the capture`})`;
  return `${finding.severity}: ${finding.explain}${more}`;
}

/**
 * Build the deterministic document.
 *
 * The `analysis` field is absent: only {@link askRootCause} adds it, and only
 * when a model answered. A caller that renders the document without one gets a
 * usable report, which is the property HapRay's `--skip-llm` lacks.
 */
/**
 * Copy a movement so the document owns its own values.
 *
 * The same rule `scene` and `generator` already follow: a caller that reuses
 * its movement object must not be able to change a document it has already
 * built. The copy is explicit rather than `structuredClone` so a future field
 * added to the movement is a compile error here instead of a silent share.
 */
function copyMovement(movement: RootCauseMovement): RootCauseMovement {
  return {
    from: { ...movement.from },
    to: { ...movement.to },
    verdict: movement.verdict,
    rows: movement.rows.map((row) => ({
      ...row,
      ...(row.gap === undefined ? {} : { gap: { ...row.gap } }),
    })),
    evidence: movement.evidence.map((row) => ({ ...row })),
    totals: { ...movement.totals },
  };
}

export function buildRootCauseDocument(input: RootCauseInput): RootCauseDocument {
  const ranked = rankObservations(input.evidence);
  const totals = countSeverities(input.evidence);
  return {
    schemaVersion: ROOT_CAUSE_SCHEMA_VERSION,
    generator: { ...input.generator },
    scene: {
      app: input.app,
      device: input.device,
      window: { startNs: input.window.startNs, endNs: input.window.endNs },
    },
    summary: {
      totals,
      verdict: verdictFor(ranked, input.evidence.length, totals.gaps),
    },
    observations: ranked,
    ...(input.movement === undefined ? {} : { movement: copyMovement(input.movement) }),
  };
}
