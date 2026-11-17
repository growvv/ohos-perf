import type { AnalyzerSection } from '../analyze/engine';
import type { AppIdentity, TimeRange } from '../types';
import type { DeltaStatus, BaselineComparison } from './compare';
import type { Evidence } from './evidence';
import type { Metric } from './metric';

/** The report document schema. A change to any shape below bumps this. */
export const REPORT_SCHEMA_VERSION = 1;

/** Who produced the report; the version is the CLI package version. */
export interface ReportGenerator {
  name: string;
  version: string;
}

/** The scene the report describes. Inputs are copied, never referenced. */
export interface ReportScenario {
  app: { packageName: string; processNames: string[] };
  device: string;
  window: TimeRange;
  /** Capture start from `scene.json`; absent when the scene did not record one. */
  startedAtNs?: number;
  /**
   * The screenshot the bundle carries at `assets/screenshot.png`. Present only
   * when the scene had one, so a renderer can tell "no image" from "an image
   * whose size it was not told".
   */
  screenshot?: { width: number; height: number };
}

/** One analyzer's contribution, ready for rendering. */
export interface ReportSection {
  /** The analyzer id, e.g. `frames`. Also the HTML section anchor. */
  id: string;
  title: string;
  status: 'measured' | 'degraded';
  /** The engine's explanation of why the analyzer was skipped. */
  degradedReason?: string;
  /** Sorted by `id`, as the engine emits them. */
  metrics: Metric[];
  /** Sorted by `(kind, window.startNs, id)`, as the engine emits them. */
  evidence: Evidence[];
}

export interface ReportTotals {
  metrics: number;
  evidence: number;
  bySeverity: { info: number; warn: number; critical: number };
  measured: number;
  degraded: number;
}

/** The complete, versioned report document. */
export interface ReportModel {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generator: ReportGenerator;
  scenario: ReportScenario;
  sections: ReportSection[];
  totals: ReportTotals;
  comparison?: BaselineComparison;
}

/** Everything `buildReport` needs; all values are already measured. */
export interface ReportInput {
  generator: ReportGenerator;
  app: AppIdentity;
  device: string;
  window: TimeRange;
  startedAtNs?: number;
  sections: readonly AnalyzerSection[];
  comparison?: BaselineComparison;
  /**
   * The scene's screenshot dimensions, when one was captured. The report copies
   * the file to `assets/screenshot.png` and renders it in the `ui` section; the
   * dimensions are here so the page can state them without decoding the PNG
   * again. Absent means no image was captured, and the page says so instead of
   * pointing at a file that does not exist.
   */
  screenshot?: { width: number; height: number };
}

/** The compact roll-up written to `summary.json`. */
export interface ReportSummary {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  app: string;
  device: string;
  window: TimeRange;
  sections: Array<{
    id: string;
    title: string;
    status: 'measured' | 'degraded';
    degradedReason?: string;
    metrics: number;
    evidence: number;
  }>;
  totals: ReportTotals;
  comparison?: Record<DeltaStatus, number>;
}

/**
 * Human titles for the analyzers shipped today.
 *
 * An id absent here titles as itself: a new analyzer renders honestly before
 * anyone writes its title, instead of failing the report.
 */
export const SECTION_TITLES: Readonly<Record<string, string>> = {
  binder: 'IPC binder',
  components: 'Component reuse',
  'empty-frame': 'Empty frames',
  'fault-tree': 'Fault tree',
  flamegraph: 'Flamegraph',
  'frame-load': 'Frame load',
  frames: 'Frames',
  gc: 'GC pressure',
  hilog: 'Hilog',
  'mem-measure': 'Memory measurement',
  'native-memory': 'Native memory',
  memory: 'Memory trend',
  render: 'Render',
  'rs-skip': 'RenderService skips',
  startup: 'Startup',
  threads: 'Threads',
  ui: 'UI',
  vsync: 'VSync',
};

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort order shared with the engine: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  return (
    byString(a.kind, b.kind) ||
    a.window.startNs - b.window.startNs ||
    byString(a.id, b.id)
  );
}

function emptySeverityCounts(): ReportTotals['bySeverity'] {
  return { info: 0, warn: 0, critical: 0 };
}

/**
 * Builds the report document from a section-aware engine run.
 *
 * The inputs are copied and sorted, never mutated. Sorting repeats the engine's
 * order so a model assembled by hand (as in tests) is just as deterministic as
 * one produced by `runAnalyzerSections` — the report must be byte-stable (D5)
 * no matter which layer produced its parts.
 */
export function buildReport(input: ReportInput): ReportModel {
  const sections: ReportSection[] = [...input.sections]
    .sort((a, b) => byString(a.analyzerId, b.analyzerId))
    .map((section) => {
      const metrics = [...section.result.metrics].sort((a, b) => byString(a.id, b.id));
      const evidence = [...section.result.evidence].sort(byEvidenceOrder);
      // The engine synthesizes exactly one degraded_capability item per
      // skipped analyzer; its explain text is the device's own reason.
      const reason = evidence.find((item) => item.kind === 'degraded_capability')?.explain;
      return {
        id: section.analyzerId,
        title: SECTION_TITLES[section.analyzerId] ?? section.analyzerId,
        status: section.status,
        ...(reason === undefined ? {} : { degradedReason: reason }),
        metrics,
        evidence,
      };
    });

  const bySeverity = emptySeverityCounts();
  for (const section of sections) {
    for (const item of section.evidence) bySeverity[item.severity] += 1;
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generator: { ...input.generator },
    scenario: {
      app: {
        packageName: input.app.packageName,
        processNames: [...input.app.processNames],
      },
      device: input.device,
      window: { ...input.window },
      ...(input.startedAtNs === undefined ? {} : { startedAtNs: input.startedAtNs }),
      ...(input.screenshot === undefined ? {} : { screenshot: { ...input.screenshot } }),
    },
    sections,
    totals: {
      metrics: sections.reduce((n, section) => n + section.metrics.length, 0),
      evidence: sections.reduce((n, section) => n + section.evidence.length, 0),
      bySeverity,
      measured: sections.filter((section) => section.status === 'measured').length,
      degraded: sections.filter((section) => section.status === 'degraded').length,
    },
    ...(input.comparison === undefined ? {} : { comparison: input.comparison }),
  };
}

/** Collapses the model to its per-section counts and totals. */
export function summarizeReport(model: ReportModel): ReportSummary {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    app: model.scenario.app.packageName,
    device: model.scenario.device,
    window: { ...model.scenario.window },
    sections: model.sections.map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status,
      ...(section.degradedReason === undefined
        ? {}
        : { degradedReason: section.degradedReason }),
      metrics: section.metrics.length,
      evidence: section.evidence.length,
    })),
    totals: {
      metrics: model.totals.metrics,
      evidence: model.totals.evidence,
      bySeverity: { ...model.totals.bySeverity },
      measured: model.totals.measured,
      degraded: model.totals.degraded,
    },
    ...(model.comparison === undefined
      ? {}
      : { comparison: { ...model.comparison.totals } }),
  };
}

/**
 * The canonical JSON serialization for `report.json` and `summary.json`.
 *
 * Two-space indent plus a trailing newline matches `analyze --json`, so a
 * consumer reads every document in this package the same way.
 */
export function renderReportJson(model: ReportModel): string {
  return JSON.stringify(model, null, 2) + '\n';
}

export function renderSummaryJson(summary: ReportSummary): string {
  return JSON.stringify(summary, null, 2) + '\n';
}
