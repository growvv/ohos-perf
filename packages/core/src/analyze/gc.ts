// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { TimeRange } from '../types';
import { resolveAppIpids } from './context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * GC invocation pressure from Ark-runtime trace events.
 *
 * Ported from `hapray/analyze/gc_analyzer.py`. The rule is HapRay's: an app is
 * under GC pressure when it invokes GC more than 10 times **and** more than
 * once per second, or when the `OS_GC_Thread` carries more than 15% of the
 * app's perf samples.
 *
 * Two deliberate divergences from HapRay, both visible in the output:
 *
 * 1. **The rate's denominator is the whole `callstack` span.** HapRay divides
 *    by `max(ts) - min(ts)` over the entire table, not by the app's own window,
 *    so a 60 s trace where the app ran for 2.6 s yields the same rate for both
 *    implementations. Dividing by the app's span instead makes the rate ~23x
 *    higher and fires the pressure rule when HapRay says OK.
 * 2. **Missing `perf.db` degrades the perf share; it does not suppress the
 *    report.** HapRay returns `None` when the perf database is absent, hiding
 *    trace-side counts it did measure. We emit those counts and a
 *    `gc.perf.degraded` proxy naming what is missing.
 */

/** The four GC phase events HapRay counts, in drill-down order. */
const GC_PATTERNS = [
  { pattern: '%H:FullGC::RunPhases%', key: 'full' },
  { pattern: '%H:PartialGC::RunPhases%', key: 'partial' },
  { pattern: '%H:SharedFullGC::RunPhases%', key: 'sharedFull' },
  { pattern: '%H:SharedGC::RunPhases%', key: 'shared' },
] as const;

/** HapRay's threshold: more than this many invocations in the span. */
const MAX_INVOCATIONS = 10;
/** HapRay's threshold: a GC-thread perf share above this is pressure. */
const MAX_PERF_SHARE = 0.15;
/** HapRay's thread name for the GC worker. */
const GC_THREAD_NAME = 'OS_GC_Thread';

export interface GcSignals {
  full: number;
  sharedFull: number;
  shared: number;
  partial: number;
  /** Every GC phase event the app emitted. */
  invocations: number;
  /** `max(ts) - min(ts)` over the whole `callstack` table. */
  spanNs: number;
  /** `invocations` per second over `spanNs`; 0 when the span is empty. */
  rate: number;
  /** True when the app exceeds both HapRay thresholds. */
  tooMany: boolean;
}

/**
 * Counts the app's GC phase events and measures its invocation rate.
 *
 * `ipids` must already be resolved (see `resolveAppIpids`); an empty list
 * matches nothing, so the result is all zeros rather than device-wide counts.
 * `db` is read through `CallstackQuery` so the `LIKE` predicates stay bound.
 */
export function computeGc(
  db: QueryHandle,
  opts: { ipids: readonly number[] },
): GcSignals {
  const counts = { full: 0, partial: 0, sharedFull: 0, shared: 0 };
  for (const { pattern, key } of GC_PATTERNS) {
    counts[key] = countMatches(db, pattern, opts.ipids);
  }
  const invocations = counts.full + counts.partial + counts.sharedFull + counts.shared;
  const spanNs = callstackSpan(db);
  const spanSeconds = spanNs / 1e9;
  const rate = spanSeconds > 0 ? invocations / spanSeconds : 0;
  return {
    ...counts,
    invocations,
    spanNs,
    rate,
    tooMany: invocations > spanSeconds && invocations > MAX_INVOCATIONS,
  };
}

/** One bound `LIKE` count, scoped to `ipids`; 0 for an empty scope. */
function countMatches(
  db: QueryHandle,
  pattern: string,
  ipids: readonly number[],
): number {
  if (ipids.length === 0) return 0;
  const [row] = db.query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM callstack
WHERE name LIKE ?
  AND callid IN (SELECT id FROM thread WHERE ipid IN (${ipids.map(() => '?').join(', ')}))`,
    [pattern, ...ipids],
  );
  return row?.n == null ? 0 : Number(row.n);
}

/**
 * `max(ts) - min(ts)` over the whole table, as HapRay measures it.
 *
 * Deliberately unscoped: the span is the trace's duration, not the app's, so
 * this stays comparable to HapRay's rate. 0 when the table is empty or holds a
 * single row.
 */
function callstackSpan(db: QueryHandle): number {
  const [row] = db.query<{ s: number | null; e: number | null }>(
    'SELECT MIN(ts) AS s, MAX(ts) AS e FROM callstack',
  );
  if (row?.s == null || row.e == null) return 0;
  return Number(row.e) - Number(row.s);
}

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

/**
 * The documented answer to "the capture produced no usable GC measurement".
 *
 * A zero labeled `exact` would read as "no GC pressure"; a `proxy` zero with a
 * reason and one `no_data` item says what is missing.
 */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  return {
    metrics: [
      metric({
        id: 'gc.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no GC measurement' },
        provenance: { collector: 'hitrace', device: ctx.deviceId },
      }),
    ],
    evidence: [
      evidence({
        kind: 'no_data',
        severity: 'info',
        subject: { process: appProcessName(ctx) },
        window: ctx.window,
        signals: {},
        explain: reason,
        drillDown: [],
        key: 'gc:no-data',
      }),
    ],
  };
}

/** `percent` (0..100) of `part` in `total`; 0 when `total` is 0. */
function share(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function fmtRate(rate: number): string {
  return rate.toFixed(2);
}

function fmtSpan(spanNs: number): string {
  return (spanNs / 1e9).toFixed(2);
}

/**
 * Emits `gc.*` metrics from Ark-runtime GC phase events.
 *
 * Counts only events the app's own threads emitted (`callstack.callid` joins
 * `thread.id`), so another process's GCs never inflate the app's numbers.
 */
export class GcAnalyzer implements Analyzer {
  readonly id = 'gc';
  readonly requires: CapabilityId[] = ['trace.ark'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return degradedResult(ctx, 'the trace database handle is not available');
    }
    const ipids = resolveAppIpids(ctx.processes, ctx.app.pids);
    if (ipids.length === 0) {
      return degradedResult(
        ctx,
        'no app process was identified in this trace, so GC events cannot be attributed',
      );
    }

    const signals = computeGc(ctx.db, { ipids });
    const metrics: Metric[] = [
      metric({
        id: 'gc.full.count',
        value: signals.full,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'callstack', rows: signals.invocations, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'gc.invocations.count',
        value: signals.invocations,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'callstack', rows: signals.invocations, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'gc.partial.count',
        value: signals.partial,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'callstack', rows: signals.invocations, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'gc.rate',
        value: signals.rate,
        unit: 'none',
        provenance: { collector: 'hitrace', table: 'callstack', device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'gc.shared.count',
        value: signals.shared,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'callstack', rows: signals.invocations, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'gc.shared_full.count',
        value: signals.sharedFull,
        unit: 'count',
        provenance: { collector: 'hitrace', table: 'callstack', rows: signals.invocations, device: ctx.deviceId },
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    const perfMetric = this.perfShare(ctx);
    metrics.push(perfMetric);

    return {
      metrics,
      evidence: [this.pressureEvidence(ctx, signals)],
    };
  }

  /**
   * `gc.perf.share`, or `gc.perf.degraded` when no samples back it.
   *
   * HapRay computes the share over the app's own perf threads, so the
   * denominator is the app's sample weight — not the device's.
   */
  private perfShare(ctx: AnalyzeContext): Metric {
    const degraded = (reason: string): Metric =>
      metric({
        id: 'gc.perf.degraded',
        value: 0,
        unit: '%',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no GC perf share' },
        provenance: { collector: 'hiperf', table: 'perf_sample', device: ctx.deviceId },
        window: ctx.window,
      });

    const perf = ctx.perf;
    if (perf === undefined) {
      return degraded('no perf database was provided, so the GC perf share cannot be measured');
    }
    if (!perf.hasSamples()) {
      return degraded(
        'perf_sample holds no samples (capture with --hiperf on a debuggable app to measure the GC perf share)',
      );
    }
    const appThreadIds = perf.threads([...ctx.app.pids]).map((thread) => thread.threadId);
    if (appThreadIds.length === 0) {
      return degraded('perf_thread has no threads for the app, so the GC perf share cannot be measured');
    }
    const total = perf.eventCount(appThreadIds);
    if (total === 0) {
      return degraded('the app perf threads carry no samples, so the GC perf share cannot be measured');
    }
    const gcThreadIds = perf.threadIdsNamed([...ctx.app.pids], GC_THREAD_NAME);
    if (gcThreadIds.length === 0) {
      return degraded(
        `perf_thread has no ${GC_THREAD_NAME} for the app, so the GC perf share cannot be measured`,
      );
    }
    const gcSamples = perf.eventCount(gcThreadIds);
    const value = share(gcSamples, total);
    return metric({
      id: 'gc.perf.share',
      value,
      unit: '%',
      fidelity: 'exact',
      provenance: { collector: 'hiperf', table: 'perf_sample', rows: gcSamples, device: ctx.deviceId },
      window: ctx.window,
    });
  }

  private pressureEvidence(ctx: AnalyzeContext, signals: GcSignals) {
    const thresholds = `> ${MAX_INVOCATIONS} invocations and > 1/s (${fmtRate(signals.rate)}/s over ${fmtSpan(signals.spanNs)}s)`;
    const explain = signals.tooMany
      ? `the app invoked GC ${signals.invocations} times, ${thresholds}: GC pressure is high`
      : `the app invoked GC ${signals.invocations} times over ${fmtSpan(signals.spanNs)}s (${fmtRate(signals.rate)}/s), below ${thresholds}`;
    return evidence({
      kind: 'gc_pressure',
      severity: signals.tooMany ? 'warn' : 'info',
      subject: { process: appProcessName(ctx) },
      window: ctx.window,
      signals: {
        full: signals.full,
        partial: signals.partial,
        shared: signals.shared,
        sharedFull: signals.sharedFull,
        invocations: signals.invocations,
        rate: Number(fmtRate(signals.rate)),
        spanSeconds: Number(fmtSpan(signals.spanNs)),
        perfShareThreshold: MAX_PERF_SHARE,
      },
      explain,
      drillDown: GC_PATTERNS.map(({ pattern, key }) => ({
        label: `${key} GC phases`,
        tool: 'callstack.matching',
        args: { pattern, startNs: ctx.window.startNs, endNs: ctx.window.endNs },
        returns: 'CallstackEvent[]',
        estRows: signals[key],
      })),
    });
  }
}
