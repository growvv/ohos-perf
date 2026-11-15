import type { ProcfsSample } from '../collectors/procfs';
import type { CapabilityId } from '../device/capability';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * `Math.round(sum / count)`; the empty guard keeps an unmeasurable mean from
 * surfacing as `NaN`. The caller only reaches this with a non-empty list, but
 * the guard is local so the helper cannot produce a non-finite value.
 */
function meanBytes(
  samples: ProcfsSample[],
  select: (sample: ProcfsSample) => number,
): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += select(sample);
  return Math.round(total / samples.length);
}

/** Maximum of the selected field; 0 when the list is empty. */
function peakBytes(
  samples: ProcfsSample[],
  select: (sample: ProcfsSample) => number,
): number {
  if (samples.length === 0) return 0;
  let peak = select(samples[0]);
  for (let i = 1; i < samples.length; i++) {
    const value = select(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

function memoryMetric(
  id: string,
  value: number,
  unit: MetricUnit,
  rows: number,
  ctx: AnalyzeContext,
): Metric {
  return metric({
    id,
    value,
    unit,
    fidelity: 'exact',
    provenance: {
      collector: 'procfs',
      rows,
      device: ctx.deviceId,
    },
  });
}

/**
 * The RSS metrics always exist for a non-empty capture; the PSS pair only when
 * at least one sample carried `smaps_rollup` data.
 *
 * PSS is computed over the smaps-bearing samples alone, so a missing
 * `smaps_rollup` never turns into a zero measurement. `rows` counts the
 * observations feeding each metric: every sample for RSS and `mem.samples`,
 * the smaps-bearing subset for PSS.
 */
function memoryMetrics(samples: ProcfsSample[], ctx: AnalyzeContext): Metric[] {
  const metrics: Metric[] = [
    memoryMetric(
      'mem.rss.peak',
      peakBytes(samples, (sample) => sample.status.vmRssBytes),
      'bytes',
      samples.length,
      ctx,
    ),
    memoryMetric(
      'mem.rss.mean',
      meanBytes(samples, (sample) => sample.status.vmRssBytes),
      'bytes',
      samples.length,
      ctx,
    ),
    memoryMetric('mem.samples', samples.length, 'count', samples.length, ctx),
  ];

  const withSmaps = samples.filter((sample) => sample.smaps !== undefined);
  if (withSmaps.length > 0) {
    const pssBytes = (sample: ProcfsSample): number =>
      sample.smaps?.pssBytes ?? 0;
    metrics.push(
      memoryMetric(
        'mem.pss.peak',
        peakBytes(withSmaps, pssBytes),
        'bytes',
        withSmaps.length,
        ctx,
      ),
      memoryMetric(
        'mem.pss.mean',
        meanBytes(withSmaps, pssBytes),
        'bytes',
        withSmaps.length,
        ctx,
      ),
    );
  }
  return metrics;
}

/**
 * One `memory_growth` item describing the first-to-last RSS change.
 *
 * The growth percentage is a rounded fact, not a leak verdict: the analyzer
 * applies no threshold and keeps severity at `info`.
 */
function growthEvidence(
  firstRssBytes: number,
  lastRssBytes: number,
  ctx: AnalyzeContext,
): Evidence {
  const deltaBytes = lastRssBytes - firstRssBytes;
  const growthPercent =
    firstRssBytes > 0
      ? Math.round((deltaBytes / firstRssBytes) * 10000) / 100
      : 0;
  return evidence({
    kind: 'memory_growth',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {
      firstRssBytes,
      lastRssBytes,
      deltaBytes,
      growthPercent,
    },
    explain:
      `RSS grew from ${firstRssBytes} to ${lastRssBytes} bytes` +
      ` (+${deltaBytes} bytes, ${growthPercent}%)`,
    drillDown: [],
  });
}

/** Zero-metrics evidence for a context assembled without a procfs capture. */
function missingProcfsEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'procfs samples (ctx.procfs) were not provided; run' +
      ' `ohos-perf collect --procfs` to capture RSS/PSS samples for memory analysis',
    drillDown: [],
  });
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Sort order for evidence: `(kind, window.startNs, id)`. */
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
 * Memory analyzer over the procfs capture that accompanied the trace.
 *
 * The engine gates this analyzer on `mem.procfs`; `ctx.procfs` is still checked
 * because the field is optional on `AnalyzeContext`. Without samples the
 * analyzer emits one `no_data` evidence naming the collection command and no
 * metrics, rather than reporting zeros as measurements.
 *
 * Samples are copied and sorted by `ts` ascending (stable for equal
 * timestamps), so first/last and the means do not depend on capture order and
 * the context array is never mutated. Growth is reported only when the last
 * RSS strictly exceeds the first; a flat or shrinking series produces no
 * evidence at all.
 */
export class MemoryAnalyzer implements Analyzer {
  readonly id = 'memory';
  readonly requires: CapabilityId[] = ['mem.procfs'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const samples = [...(ctx.procfs ?? [])].sort((a, b) => a.ts - b.ts);
    if (samples.length === 0) {
      return { metrics: [], evidence: [missingProcfsEvidence(ctx)] };
    }

    const firstRssBytes = samples[0].status.vmRssBytes;
    const lastRssBytes = samples[samples.length - 1].status.vmRssBytes;
    const metrics = memoryMetrics(samples, ctx);
    const evidenceItems =
      lastRssBytes > firstRssBytes
        ? [growthEvidence(firstRssBytes, lastRssBytes, ctx)]
        : [];

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
