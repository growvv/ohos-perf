import type { CapabilityState } from '../device/capability';
import { OhosPerfError } from '../errors';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { BinderAnalyzer } from './binder';
import { ComponentReuseAnalyzer } from './components';
import { EmptyFrameAnalyzer } from './empty-frame';
import { FaultTreeAnalyzer } from './fault-tree';
import { FlamegraphAnalyzer } from './flamegraph';
import { FrameLoadAnalyzer } from './frame-load';
import { FrameAnalyzer } from './frames';
import { GcAnalyzer } from './gc';
import { MemoryAnalyzer } from './memory';
import { MemoryMeasureAnalyzer } from './mem-measure';
import { NativeMemoryAnalyzer } from './native-memory';
import { StartupAnalyzer } from './startup';
import { RenderAnalyzer } from './render';
import { RsSkipAnalyzer } from './rs-skip';
import { ThreadAnalyzer } from './threads-score';
import { VsyncAnalyzer } from './vsync';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byAnalyzerId(a: Analyzer, b: Analyzer): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Sort order for evidence: `(kind, window.startNs, id)`, as in the analyzers. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The fixed reason text for a skipped analyzer.
 *
 * Ids and reasons are in `missing` order (sorted by id by `satisfies`), so the
 * string is deterministic for the same capability matrix.
 */
function degradedReason(missing: CapabilityState[]): string {
  const ids = missing.map((state) => state.id).join(', ');
  const reasons = missing.map((state) => state.reason ?? 'unavailable').join('; ');
  return `missing ${ids}: ${reasons}`;
}

/**
 * The placeholder a skipped analyzer contributes: a zero-count proxy.
 *
 * The value is not measured, so `fidelity: 'proxy'` and the explicit
 * `degraded` block prevent a consumer from reading the zero as a real
 * measurement. The analyzer's own metrics are not emitted at all.
 */
function degradedMetric(
  analyzer: Analyzer,
  ctx: AnalyzeContext,
  missing: CapabilityState[],
): Metric {
  return metric({
    id: `${analyzer.id}.degraded`,
    value: 0,
    unit: 'count',
    fidelity: 'proxy',
    degraded: { reason: degradedReason(missing), fallback: 'analyzer skipped' },
    provenance: { collector: 'capability-matrix', device: ctx.deviceId },
  });
}

/**
 * One explanation per skipped analyzer.
 *
 * The subject and window are the same for every skipped analyzer in a run, so
 * `key: analyzer.id` is what keeps two `degraded_capability` items from
 * colliding on one evidence id. The key is hash material only; it is not part
 * of the returned object.
 */
function degradedEvidence(
  analyzer: Analyzer,
  ctx: AnalyzeContext,
  missing: CapabilityState[],
): Evidence {
  const ids = missing.map((state) => state.id);
  const process =
    ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
  return evidence({
    kind: 'degraded_capability',
    severity: 'warn',
    subject: { process },
    window: ctx.window,
    signals: { missing: ids.join(',') },
    explain: `${analyzer.id} skipped: ${degradedReason(missing)}`,
    drillDown: [
      {
        label: 'Capability matrix',
        tool: 'caps.get',
        args: { ids },
        returns: 'CapabilityState[]',
        estRows: ids.length,
      },
    ],
    key: analyzer.id,
  });
}

/**
 * One analyzer's share of a run.
 *
 * A skipped analyzer still gets a section, with `status: 'degraded'` and the
 * placeholder metric/evidence pair the engine synthesizes, so a report can
 * name the missing capability in place instead of dropping the section.
 */
export interface AnalyzerSection {
  readonly analyzerId: string;
  readonly status: 'measured' | 'degraded';
  readonly result: AnalyzeResult;
}

/** A whole run: the merged result plus the per-analyzer sections it came from. */
export interface AnalyzerRun {
  readonly result: AnalyzeResult;
  readonly sections: AnalyzerSection[];
}

/**
 * Runs every analyzer whose capability requirements are satisfied.
 *
 * Analyzers are sorted by `id` and run sequentially, so both the call order
 * and the merged output are deterministic regardless of the caller's array
 * order (D5). An analyzer with an unsatisfied requirement is not called: it
 * contributes one `<id>.degraded` proxy metric and one `degraded_capability`
 * evidence item naming the missing capabilities and the device's own reasons.
 * Every analyzer also contributes one {@link AnalyzerSection} to `sections`,
 * in the same id order, so a report can attribute each metric to its source.
 *
 * The returned arrays are new and sorted (`metrics` by `id`, `evidence` by
 * `(kind, window.startNs, id)`). Two analyzers emitting the same metric id
 * make the report ambiguous, so the whole run fails with
 * `DUPLICATE_METRIC_ID` instead of silently keeping one value; the same
 * integrity rule applies to evidence ids (`DUPLICATE_EVIDENCE_ID`). Neither
 * the context nor any analyzer (including its result arrays) is mutated.
 */
export async function runAnalyzerSections(
  analyzers: readonly Analyzer[],
  ctx: AnalyzeContext,
): Promise<AnalyzerRun> {
  const ordered = [...analyzers].sort(byAnalyzerId);
  const metrics: Metric[] = [];
  const evidenceItems: Evidence[] = [];
  const sections: AnalyzerSection[] = [];

  for (const analyzer of ordered) {
    const check = ctx.caps.satisfies(analyzer.requires);
    if (!check.ok) {
      const result: AnalyzeResult = {
        metrics: [degradedMetric(analyzer, ctx, check.missing)],
        evidence: [degradedEvidence(analyzer, ctx, check.missing)],
      };
      metrics.push(...result.metrics);
      evidenceItems.push(...result.evidence);
      sections.push({ analyzerId: analyzer.id, status: 'degraded', result });
      continue;
    }

    const result = await analyzer.run(ctx);
    metrics.push(...result.metrics);
    evidenceItems.push(...result.evidence);
    sections.push({ analyzerId: analyzer.id, status: 'measured', result });
  }

  metrics.sort(byMetricId);
  for (let i = 1; i < metrics.length; i++) {
    if (metrics[i].id === metrics[i - 1].id) {
      throw new OhosPerfError('DUPLICATE_METRIC_ID', { code: 'DUPLICATE_METRIC_ID' });
    }
  }

  evidenceItems.sort(byEvidenceOrder);
  // An evidence consumer keyed on `id` (D4) silently drops all but one of a
  // duplicate group, so a duplicate is a report-integrity failure, not a
  // cosmetic one. Mirrors the metric check above.
  for (let i = 1; i < evidenceItems.length; i++) {
    if (evidenceItems[i].id === evidenceItems[i - 1].id) {
      throw new OhosPerfError('DUPLICATE_EVIDENCE_ID', {
        code: 'DUPLICATE_EVIDENCE_ID',
      });
    }
  }
  return { result: { metrics, evidence: evidenceItems }, sections };
}

/**
 * Runs every analyzer and returns only the merged result.
 *
 * A thin wrapper over {@link runAnalyzerSections}; existing callers keep the
 * old shape and behavior exactly.
 */
export async function runAnalyzers(
  analyzers: readonly Analyzer[],
  ctx: AnalyzeContext,
): Promise<AnalyzeResult> {
  return (await runAnalyzerSections(analyzers, ctx)).result;
}

/**
 * The analyzers an offline `analyze` run executes by default.
 *
 * Additional analyzers are appended as they are implemented; the function
 * returns a fresh array so callers may add or remove entries without
 * affecting another run.
 */
export function defaultAnalyzers(): Analyzer[] {
  return [
    new FrameAnalyzer(),
    new FrameLoadAnalyzer(),
    new FaultTreeAnalyzer(),
    new BinderAnalyzer(),
    new ThreadAnalyzer(),
    new MemoryAnalyzer(),
    new MemoryMeasureAnalyzer(),
    new NativeMemoryAnalyzer(),
    new StartupAnalyzer(),
    new RenderAnalyzer(),
    new GcAnalyzer(),
    new VsyncAnalyzer(),
    new EmptyFrameAnalyzer(),
    new RsSkipAnalyzer(),
    new FlamegraphAnalyzer(),
    new ComponentReuseAnalyzer(),
  ];
}
