import type { TimeRange } from '../types';
import type { Evidence, EvidenceKind } from './evidence';

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

/** The root-cause document schema. A change to any shape below bumps this. */
export const ROOT_CAUSE_SCHEMA_VERSION = 1;

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
  totals: { info: number; warn: number; critical: number };
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
  analysis?: RootCauseAnalysis;
}

/** Everything {@link buildRootCauseDocument} needs; all values are measured. */
export interface RootCauseInput {
  app: string;
  device: string;
  window: TimeRange;
  generator: RootCauseGenerator;
  evidence: readonly Evidence[];
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
): { info: number; warn: number; critical: number } {
  const totals = { info: 0, warn: 0, critical: 0 };
  for (const item of evidence) totals[item.severity] += 1;
  return totals;
}

/**
 * The one-sentence verdict.
 *
 * With evidence, it is the highest-severity observation's own sentence: the
 * analyzer already explained what it measured, and rewriting that would be a
 * second opinion nobody asked for. Without evidence the sentence says the run
 * found nothing, which is a measurement — distinct from a run that could not
 * look.
 */
function verdictFor(ranked: readonly RootCauseObservation[], total: number): string {
  if (total === 0) {
    return 'no evidence was produced for this scene, so there is nothing to explain';
  }
  const worst = ranked[0]!;
  const more = total === 1 ? '' : ` (and ${total - 1} other observation${total === 2 ? '' : 's'})`;
  return `${worst.severity}: ${worst.explain}${more}`;
}

/**
 * Build the deterministic document.
 *
 * The `analysis` field is absent: only {@link askRootCause} adds it, and only
 * when a model answered. A caller that renders the document without one gets a
 * usable report, which is the property HapRay's `--skip-llm` lacks.
 */
export function buildRootCauseDocument(input: RootCauseInput): RootCauseDocument {
  const ranked = rankObservations(input.evidence);
  return {
    schemaVersion: ROOT_CAUSE_SCHEMA_VERSION,
    generator: { ...input.generator },
    scene: {
      app: input.app,
      device: input.device,
      window: { startNs: input.window.startNs, endNs: input.window.endNs },
    },
    summary: {
      totals: countSeverities(input.evidence),
      verdict: verdictFor(ranked, input.evidence.length),
    },
    observations: ranked,
  };
}
