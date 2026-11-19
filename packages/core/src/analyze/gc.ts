// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { resolveAppIpids } from './context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/**
 * GC invocation pressure from Ark-runtime trace events.
 *
 * Ported from `hapray/analyze/gc_analyzer.py`. HapRay's rule has two clauses,
 * and either one raises the verdict: more than 10 invocations **and** more than
 * once per second, or the `OS_GC_Thread` carrying more than 15% of the app's
 * perf samples. Both are implemented; the count clause alone would report OK
 * for an app whose collector thread is burning a third of its CPU.
 *
 * One deliberate divergence from HapRay, visible in the output: **a missing
 * `perf.db` degrades the perf share; it does not suppress the report.** HapRay
 * returns `None` when the perf database is absent, hiding trace-side counts it
 * did measure. We emit those counts and a `gc.perf.degraded` proxy naming what
 * is missing. The count clause still decides the severity in that case, and the
 * evidence's `explain` says the share was not measured.
 *
 * The rate's denominator is the whole `callstack` span, as HapRay computes it —
 * `max(ts) - min(ts)` over the entire table, not the app's own window.
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
/** HapRay's threshold, as a percentage of the app's sample weight. */
const MAX_PERF_SHARE_PCT = 15;
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
  /** True when the count clause alone fires: `> 10` invocations and `> 1/s`. */
  tooMany: boolean;
}

/**
 * Counts the app's GC phase events and measures its invocation rate.
 *
 * `ipids` must already be resolved (see `resolveAppIpids`); an empty list
 * matches nothing, so the result is all zeros rather than device-wide counts.
 * The raw SQL is here because no query class owns a `LIKE` count scoped by
 * `thread.ipid`; the `LIKE` predicates stay bound as parameters.
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
    const ipids = resolveAppIpids(ctx.processes, ctx.app);
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

    // A single-row `callstack` gives a zero span, so the rate has no
    // denominator. Omitting it is the same choice `empty-frame` makes for its
    // rate; a 0 there would read as a measurement.
    if (signals.spanNs > 0) {
      metrics.push(
        metric({
          id: 'gc.rate',
          value: signals.rate,
          unit: 'none',
          provenance: { collector: 'hitrace', table: 'callstack', device: ctx.deviceId },
          fidelity: 'exact',
          window: ctx.window,
        }),
      );
    }

    const perf = this.perfShare(ctx);
    metrics.push(perf.metric);

    return {
      metrics,
      evidence: [this.pressureEvidence(ctx, signals, perf.sharePct)],
    };
  }

  /**
   * `gc.perf.share` plus the number behind it, or a degraded proxy and
   * `undefined`.
   *
   * HapRay computes the share over the app's own perf threads, so the
   * denominator is the app's sample weight — not the device's. The caller
   * needs the number, not just the metric: HapRay's second pressure clause is
   * `perf_percentage > 0.15`.
   */
  private perfShare(ctx: AnalyzeContext): { metric: Metric; sharePct: number | undefined } {
    const degraded = (reason: string): { metric: Metric; sharePct: undefined } => ({
      metric: metric({
        id: 'gc.perf.degraded',
        value: 0,
        unit: '%',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no GC perf share' },
        provenance: { collector: 'hiperf', table: 'perf_sample', device: ctx.deviceId },
        window: ctx.window,
      }),
      sharePct: undefined,
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
    // Windowed like the flamegraph's totals, so the two analyzers describe the
    // same sample population when a caller narrows the window.
    const total = perf.eventCount(appThreadIds, ctx.window);
    if (total === 0) {
      return degraded('the app perf threads carry no samples, so the GC perf share cannot be measured');
    }
    const gcThreadIds = perf.threadIdsNamed([...ctx.app.pids], GC_THREAD_NAME);
    if (gcThreadIds.length === 0) {
      return degraded(
        `perf_thread has no ${GC_THREAD_NAME} for the app, so the GC perf share cannot be measured`,
      );
    }
    const gcSamples = perf.eventCount(gcThreadIds, ctx.window);
    const value = share(gcSamples, total);
    return {
      metric: metric({
        id: 'gc.perf.share',
        value,
        unit: '%',
        fidelity: 'exact',
        provenance: { collector: 'hiperf', table: 'perf_sample', rows: gcSamples, device: ctx.deviceId },
        window: ctx.window,
      }),
      sharePct: value,
    };
  }

  private pressureEvidence(
    ctx: AnalyzeContext,
    signals: GcSignals,
    sharePct: number | undefined,
  ) {
    // HapRay raises the verdict on either clause: the count rule, or a GC
    // thread carrying more than 15% of the app's samples.
    const shareFires = sharePct !== undefined && sharePct > MAX_PERF_SHARE_PCT;
    const pressure = signals.tooMany || shareFires;

    const thresholds = `> ${MAX_INVOCATIONS} invocations and > 1/s (${fmtRate(signals.rate)}/s over ${fmtSpan(signals.spanNs)}s)`;
    const countClause = `the app invoked GC ${signals.invocations} times, ${thresholds}`;
    const shareClause = sharePct === undefined
      ? 'the GC perf share was not measured'
      : `the GC thread's perf share is ${fmtRate(sharePct)}% of the app's samples ` +
        `(threshold > ${MAX_PERF_SHARE_PCT}%)`;

    let explain: string;
    if (pressure) {
      const fired = shareFires && !signals.tooMany
        ? `the GC thread's perf share is ${fmtRate(sharePct!)}% of the app's samples, above ${MAX_PERF_SHARE_PCT}%`
        : shareFires
          ? `${countClause} and ${shareClause}`
          : countClause;
      explain = `${fired}: GC pressure is high`;
    } else if (signals.tooMany) {
      explain = `${countClause}: GC pressure is high`;
    } else {
      explain = `the app invoked GC ${signals.invocations} times over ${fmtSpan(signals.spanNs)}s ` +
        `(${fmtRate(signals.rate)}/s), below ${thresholds}; ${shareClause}`;
    }

    return evidence({
      kind: 'gc_pressure',
      severity: pressure ? 'warn' : 'info',
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
        // Percent, matching the `gc.perf.share` metric's unit, and only when
        // the share was actually measured.
        ...(sharePct === undefined ? {} : { perfSharePct: sharePct }),
        perfShareThresholdPct: MAX_PERF_SHARE_PCT,
      },
      explain,
      // No `estRows`: `callstack.matching` has no ipid argument, so it returns
      // every process's matches, not the app's count. Promising the app's count
      // would understate the rows a caller actually gets back.
      drillDown: GC_PATTERNS.map(({ pattern, key }) => ({
        label: `${key} GC phases`,
        tool: 'callstack.matching',
        args: { pattern, startNs: ctx.window.startNs, endNs: ctx.window.endNs },
        returns: 'CallstackEvent[]',
      })),
    });
  }
}
