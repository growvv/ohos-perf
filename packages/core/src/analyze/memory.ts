import type { CapabilityId } from '../device/capability';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric, type MetricUnit } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * `Math.round(sum / count)` over a series that is already free of non-finite
 * values; the empty guard keeps an unmeasurable mean from surfacing as `NaN`.
 *
 * The exact sum can overflow to `Infinity` even when every value is finite
 * (two `Number.MAX_VALUE` samples are enough), and `Infinity` would serialize
 * as `null`. When that happens the mean is computed by dividing first:
 * `values.reduce((acc, value) => acc + value / n, 0)`. Rounding those
 * quotients can still push the scaled sum past `MAX_VALUE` (three equal
 * `MAX_VALUE` samples), so the final fallback is a running mean, which stays
 * between the series minimum and maximum. Both fallbacks only serve malformed
 * or adversarial input; normal captures take the exact path.
 */
function meanBytes(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  if (Number.isFinite(total)) return Math.round(total / values.length);

  let scaled = 0;
  for (const value of values) scaled += value / values.length;
  if (Number.isFinite(scaled)) return Math.round(scaled);

  // Bounded because RSS/PSS bytes are non-negative and every input is finite.
  let mean = 0;
  for (let i = 0; i < values.length; i++) {
    mean += (values[i] - mean) / (i + 1);
  }
  return Math.round(mean);
}

/** Maximum of a finite series; 0 when the list is empty. */
function peakBytes(values: number[]): number {
  if (values.length === 0) return 0;
  let peak = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) peak = values[i];
  }
  return peak;
}

/**
 * The finite members of a series, in input order.
 *
 * The plan's global rule is that a metric never carries `NaN`/`Infinity`; a
 * malformed capture value is dropped rather than poisoning the whole series.
 */
function finiteValues(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
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
 * The RSS metrics for a non-empty finite series; the PSS pair only when at
 * least one sample carried a finite `smaps_rollup.pssBytes`.
 *
 * PSS is computed over the smaps-bearing samples alone, so a missing
 * `smaps_rollup` never turns into a zero measurement. `rows` counts the
 * observations feeding each metric: the finite RSS values for the RSS pair,
 * the finite PSS values for the PSS pair, and every captured sample for
 * `mem.samples` — that metric describes capture volume, not the filtered
 * measurement series, so it stays the unfiltered `ctx.procfs` length.
 */
function memoryMetrics(
  rssValues: number[],
  pssValues: number[],
  sampleCount: number,
  ctx: AnalyzeContext,
): Metric[] {
  const metrics: Metric[] = [
    memoryMetric('mem.rss.peak', peakBytes(rssValues), 'bytes', rssValues.length, ctx),
    memoryMetric('mem.rss.mean', meanBytes(rssValues), 'bytes', rssValues.length, ctx),
    memoryMetric('mem.samples', sampleCount, 'count', sampleCount, ctx),
  ];

  if (pssValues.length > 0) {
    metrics.push(
      memoryMetric('mem.pss.peak', peakBytes(pssValues), 'bytes', pssValues.length, ctx),
      memoryMetric('mem.pss.mean', meanBytes(pssValues), 'bytes', pssValues.length, ctx),
    );
  }
  return metrics;
}

/**
 * One `memory_growth` item describing the first-to-last RSS change.
 *
 * The growth percentage is a rounded fact, not a leak verdict: the analyzer
 * applies no threshold and keeps severity at `info`.
 *
 * `deltaBytes` and `growthPercent` can overflow even though both endpoints are
 * finite (`first = 1, last = MAX_VALUE`, or a first value near
 * `Number.MIN_VALUE`). Evidence signals may never be `NaN`/`Infinity`, so such
 * a case emits no growth item at all; normal captures are unaffected.
 */
function growthEvidence(
  firstRssBytes: number,
  lastRssBytes: number,
  ctx: AnalyzeContext,
): Evidence | undefined {
  const deltaBytes = lastRssBytes - firstRssBytes;
  const growthPercent =
    firstRssBytes > 0
      ? Math.round((deltaBytes / firstRssBytes) * 10000) / 100
      : 0;
  if (!Number.isFinite(deltaBytes) || !Number.isFinite(growthPercent)) {
    return undefined;
  }
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

/** Zero-metrics evidence when samples exist but none has a finite RSS value. */
function nonFiniteRssEvidence(ctx: AnalyzeContext): Evidence {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: appProcessName(ctx) },
    window: ctx.window,
    signals: {},
    explain:
      'procfs samples were captured, but they carried no usable finite RSS' +
      ' value; run `ohos-perf collect --procfs` to capture RSS/PSS samples' +
      ' for memory analysis',
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
 * Samples are copied and sorted by `ts` ascending, so first/last and the means
 * do not depend on capture order and the context array is never mutated.
 * `Array.prototype.sort` is stable (ES2019+), so equal timestamps keep their
 * input order; the first and last finite RSS values in that order define the
 * growth check. Non-finite `vmRssBytes`/`pssBytes` values are dropped before
 * any arithmetic: a series with no finite RSS at all takes a `no_data` branch
 * (with a message distinguishing an absent capture from unusable captured
 * values), and a series with no finite PSS omits the PSS metrics, so no metric
 * can carry `NaN` or `Infinity`. Growth is reported only when the last finite
 * RSS strictly exceeds the first and both its delta and percentage are finite;
 * a flat, shrinking, or unrepresentable series produces no evidence at all.
 */
export class MemoryAnalyzer implements Analyzer {
  readonly id = 'memory';
  readonly requires: CapabilityId[] = ['mem.procfs'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const samples = [...(ctx.procfs ?? [])].sort((a, b) => a.ts - b.ts);
    const rssValues = finiteValues(
      samples.map((sample) => sample.status.vmRssBytes),
    );
    if (rssValues.length === 0) {
      const evidenceItems =
        samples.length === 0
          ? [missingProcfsEvidence(ctx)]
          : [nonFiniteRssEvidence(ctx)];
      return { metrics: [], evidence: evidenceItems };
    }

    const pssValues = finiteValues(
      samples
        .filter((sample) => sample.smaps !== undefined)
        .map((sample) => sample.smaps?.pssBytes ?? Number.NaN),
    );
    const firstRssBytes = rssValues[0];
    const lastRssBytes = rssValues[rssValues.length - 1];
    const metrics = memoryMetrics(
      rssValues,
      pssValues,
      samples.length,
      ctx,
    );
    const growth =
      lastRssBytes > firstRssBytes
        ? growthEvidence(firstRssBytes, lastRssBytes, ctx)
        : undefined;
    const evidenceItems = growth === undefined ? [] : [growth];

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
