import type { CapabilityId } from '../device/capability';
import type { TimeRange } from '../types';
import type { Frame } from '../query/frames';
import type { PerfQuery } from '../query/perf';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { resolveAppIpids } from './context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** One app thread's share of a frame's sampled-event load. */
export interface FrameLoadThread {
  threadId: number;
  threadName: string;
  /** Summed `event_count` inside the frame window. */
  samples: number;
}

/** Sampled-event weight attributed to one file path. */
export interface PerfFileAttribution {
  filePath: string;
  samples: number;
}

interface SamplePoint {
  ts: number;
  count: number;
}

interface ThreadSamples {
  threadId: number;
  threadName: string;
  points: SamplePoint[];
  /** `points[].ts`, kept separately for binary search. */
  timestamps: number[];
}

/** The setup a caller hands {@link FrameLoadIndex.build}. */
export interface FrameLoadIndexInput {
  perf: PerfQuery;
  /** App process ids (`process.pid`), matching `perf_thread.process_id`. */
  pids: readonly number[];
  /** The range to read samples for; frame windows must fall inside it. */
  range: TimeRange;
}

/** First index whose value is `>= target`. */
function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is `> target`. */
function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * One batched read of `perf_sample` that answers per-frame load queries.
 *
 * Reading the samples once and bucketing in memory is what makes a
 * per-frame join affordable: issuing one `SUM` per frame does a table scan
 * per frame, and HapRay's batch path solves the same problem the same way.
 *
 * The window is the frame's own **inclusive** `[ts, ts + dur]`; `dur <= 0`
 * collapses it to the point `[ts, ts]`, so a sample exactly at `ts` counts.
 * Only threads whose `perf_thread.process_id` is one of the app pids are
 * included; samples from other processes never contribute.
 *
 * ## Overlap
 *
 * `load()` is a per-frame window aggregate. When two app frames overlap in
 * time, the same sample contributes to both frame loads — matching HapRay's
 * batch path — so summing frame loads can exceed {@link spanWeight}, the
 * unique sample weight read for the whole range. Callers that need a share of
 * the app's total work should use `spanWeight`; callers that need a frame's
 * own cost use `load`.
 */
export class FrameLoadIndex {
  private constructor(
    private readonly threads: readonly ThreadSamples[],
    /** `perf_sample` rows read (not the summed weight). */
    readonly sampleRows: number,
    /** Distinct app thread ids in `perf_thread`. */
    readonly threadCount: number,
    /** Summed `event_count` of every sample read, without frame overlap. */
    readonly spanWeight: number,
  ) {}

  /**
   * Reads app-thread samples for `range`.
   *
   * Returns `undefined` when there is nothing to measure: no `perf_sample`
   * rows, no `perf_thread` rows for the app pids, or no samples inside the
   * range. Callers turn that into a degraded result with a reason rather than
   * reporting zeros.
   */
  static build(input: FrameLoadIndexInput): FrameLoadIndex | undefined {
    const { perf, pids, range } = input;
    if (!perf.hasSamples()) return undefined;

    const named = perf.threads([...pids]);
    const names = new Map<number, string>();
    for (const thread of named) {
      // A duplicate thread_id keeps its lowest perf_thread.id row (the query
      // is ordered by id), matching the deterministic tie-break elsewhere.
      if (!names.has(thread.threadId)) names.set(thread.threadId, thread.threadName);
    }
    const threadIds = [...names.keys()].sort((a, b) => a - b);
    if (threadIds.length === 0) return undefined;

    const rows = perf.samples(threadIds, range);
    if (rows.length === 0) return undefined;

    const points = new Map<number, SamplePoint[]>();
    for (const threadId of threadIds) points.set(threadId, []);
    let spanWeight = 0;
    for (const row of rows) {
      points.get(row.threadId)?.push({ ts: row.timestampTrace, count: row.eventCount });
      spanWeight += row.eventCount;
    }

    const threads: ThreadSamples[] = threadIds.map((threadId) => {
      const list = points.get(threadId) ?? [];
      return {
        threadId,
        threadName: names.get(threadId) ?? 'unknown',
        points: list,
        timestamps: list.map((point) => point.ts),
      };
    });
    return new FrameLoadIndex(threads, rows.length, threadIds.length, spanWeight);
  }

  /** Summed sampled-event weight of every app thread inside the frame window. */
  load(frame: Pick<Frame, 'ts' | 'dur'>): number {
    const start = frame.ts;
    const end = frame.ts + Math.max(0, frame.dur);
    let total = 0;
    for (const thread of this.threads) {
      if (thread.points.length === 0) continue;
      const from = lowerBound(thread.timestamps, start);
      const to = upperBound(thread.timestamps, end);
      for (let i = from; i < to; i++) total += thread.points[i].count;
    }
    return total;
  }

  /**
   * Splits a frame window by app thread.
   *
   * Only positive-weight threads are returned, sorted by `samples` descending
   * then `threadId` ascending, so equal weights never depend on row order.
   */
  threadLoads(frame: Pick<Frame, 'ts' | 'dur'>): FrameLoadThread[] {
    const start = frame.ts;
    const end = frame.ts + Math.max(0, frame.dur);
    const rows: FrameLoadThread[] = [];
    for (const thread of this.threads) {
      if (thread.points.length === 0) continue;
      const from = lowerBound(thread.timestamps, start);
      const to = upperBound(thread.timestamps, end);
      let samples = 0;
      for (let i = from; i < to; i++) samples += thread.points[i].count;
      if (samples > 0) {
        rows.push({ threadId: thread.threadId, threadName: thread.threadName, samples });
      }
    }
    rows.sort((a, b) => b.samples - a.samples || a.threadId - b.threadId);
    return rows;
  }
}

/** The no-samples reason shared with the empty-frame analyzer. */
export const NO_SAMPLES =
  'no perf samples: the scene was captured without --hiperf, or the app was ' +
  'not debuggable so perf recorded nothing';

/**
 * Why {@link FrameLoadIndex.build} returned `undefined`, when samples exist.
 *
 * The three absent states are different problems and a caller that collapses
 * them into {@link NO_SAMPLES} sends the reader after the wrong one: samples
 * for other processes mean the capture worked and the app simply recorded
 * nothing, which rebuilding with a debug signature may not fix.
 */
export function noSamplesReason(
  perf: PerfQuery,
  pids: readonly number[],
): string {
  if (!perf.hasSamples()) return NO_SAMPLES;
  if (perf.threads([...pids]).length === 0) {
    return 'perf samples exist but no perf thread belongs to the app process, so ' +
      'none of the load can be attributed to it';
  }
  return 'perf samples exist but none fall inside any app frame window; frame and ' +
    'perf timestamps may use different time bases';
}

/** The proxy + explanation a caller gets when load cannot be measured. */
function degradedResult(
  ctx: AnalyzeContext,
  reason: string,
  totalFrames: number,
): AnalyzeResult {
  const process = ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
  return {
    metrics: [
      metric({
        id: 'frame.load.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no frame load' },
        provenance: { collector: 'hiperf', device: ctx.deviceId },
        window: ctx.window,
      }),
    ],
    evidence: [
      evidence({
        kind: 'no_data',
        severity: 'info',
        subject: { process },
        window: ctx.window,
        signals: {},
        explain: reason,
        drillDown: [
          {
            label: 'All frames in window',
            tool: 'frames.all',
            args: { window: ctx.window },
            returns: 'Frame[]',
            estRows: totalFrames,
          },
        ],
        key: 'frame-load:no-data',
      }),
    ],
  };
}

/** Plain lexicographic order; locale-independent so output is byte-stable. */
function byMetricId(a: Metric, b: Metric): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort order for evidence: `(kind, window.startNs, id)`. */
function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Per-frame sampled-event load for the app's rendered actual frames.
 *
 * ## What a load is
 *
 * The summed `perf_sample.event_count` of every app-process thread whose
 * `timestamp_trace` falls inside the frame's own inclusive
 * `[ts, ts + dur]`. `event_count` is sample weight; it is not an instruction
 * count, CPU time or power.
 *
 * Frames from several app processes can overlap in time (ui and render in one
 * vsync period), so a sample contributes to each frame that contains it.
 * `frame.load.total` is therefore the sum of per-frame loads and can exceed
 * `frame.load.span.weight`, the unique weight read for the whole span.
 *
 * Only **rendered** app actual frames (`type = 0`, `flag !== 2`) feed the
 * summary and the top list: expect frames are predictions, and empty frames
 * are measured by the empty-frame analyzer.
 *
 * ## Degraded cases
 *
 * No app process, no perf samples, no app threads, or samples that exist but
 * never land inside a frame window all yield one `frame.load.degraded` proxy
 * with a reason. The last case matters most: it usually means the frame and
 * perf tables use different timestamp bases, and exact zeros would read as a
 * workload-free app.
 */
export class FrameLoadAnalyzer implements Analyzer {
  readonly id = 'frame-load';
  readonly requires: CapabilityId[] = ['trace.frames', 'perf.samples'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const all = ctx.frames.all(ctx.window);
    const ipids = resolveAppIpids(ctx.processes, ctx.app);
    if (ipids.length === 0) {
      return degradedResult(
        ctx,
        'no app process was identified in this trace, so frame load cannot be attributed',
        all.length,
      );
    }

    const appFrames = all.filter((frame) => frame.type === 0 && ipids.includes(frame.ipid));
    const rendered = appFrames.filter((frame) => frame.flag !== 2);

    if (ctx.perf === undefined || !ctx.perf.hasSamples()) {
      return degradedResult(ctx, NO_SAMPLES, all.length);
    }
    if (rendered.length === 0) {
      return {
        metrics: [],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: {
              process:
                ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName,
            },
            window: ctx.window,
            signals: { appFrames: appFrames.length },
            explain:
              appFrames.length === 0
                ? 'the app rendered no actual frames in this window, so there is no frame load to report'
                : 'every app actual frame in this window was empty (flag 2), so there is no rendered-frame load to report',
            drillDown: [
              {
                label: 'All frames in window',
                tool: 'frames.all',
                args: { window: ctx.window },
                returns: 'Frame[]',
                estRows: all.length,
              },
            ],
            key: 'frame-load:no-frames',
          }),
        ],
      };
    }

    const minTs = rendered[0].ts;
    // The maximum frame end, not the last-by-`ts` frame's end: a frame that
    // starts earlier can end later, and samples in that tail belong to its
    // inclusive window. Taking the last row's end would silently drop them.
    const maxEnd = rendered.reduce(
      (max, frame) => Math.max(max, frame.ts + Math.max(0, frame.dur)),
      minTs,
    );
    const index = FrameLoadIndex.build({
      perf: ctx.perf,
      pids: ctx.app.pids,
      range: {
        startNs: Math.min(ctx.window.startNs, minTs),
        endNs: Math.max(ctx.window.endNs, maxEnd),
      },
    });
    if (index === undefined) {
      return degradedResult(
        ctx,
        'no perf threads or samples were found for the app processes in this window',
        all.length,
      );
    }

    const loads = rendered.map((frame) => ({ frame, load: index.load(frame) }));
    const total = loads.reduce((sum, item) => sum + item.load, 0);
    if (total === 0 && index.spanWeight > 0) {
      return degradedResult(
        ctx,
        'perf samples exist but none fall inside any app frame window; frame and ' +
          'perf timestamps may use different time bases',
        all.length,
      );
    }

    const prov = {
      collector: 'hiperf',
      table: 'perf_sample',
      rows: index.sampleRows,
      device: ctx.deviceId,
    };
    const values = loads.map((item) => item.load);
    const max = values.reduce((a, b) => (b > a ? b : a), 0);
    const min = values.reduce((a, b) => (b < a ? b : a), values[0] ?? 0);
    const ranked = [...loads].sort(
      (a, b) =>
        b.load - a.load ||
        a.frame.ts - b.frame.ts ||
        a.frame.id - b.frame.id,
    );
    const top = ranked.slice(0, 10);
    const topSum = top.reduce((sum, item) => sum + item.load, 0);
    const metrics: Metric[] = [
      metric({
        id: 'frame.load.avg',
        value: total / rendered.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.frames.count',
        value: rendered.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.max',
        value: max,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.min',
        value: min,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.span.weight',
        value: index.spanWeight,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.top10.share',
        value: total > 0 ? (topSum / total) * 100 : 0,
        unit: '%',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'frame.load.total',
        value: total,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    // Lowest process.id wins for a duplicate ipid, matching the other
    // analyzers. Unresolved ipids fall back to `ipid:<n>` rather than borrowing
    // the app's name.
    const processNames = new Map<number, string>();
    for (const process of ctx.processes.all()) {
      if (!processNames.has(process.ipid)) processNames.set(process.ipid, process.name);
    }
    const originNs = all[0]?.ts ?? minTs;
    const rankOf = new Map<number, number>();
    top.forEach((item, i) => rankOf.set(item.frame.id, i + 1));

    const evidenceItems: Evidence[] = top.map((item) => {
      const { frame, load } = item;
      const name = processNames.get(frame.ipid) ?? '';
      const process = name === '' ? `ipid:${frame.ipid}` : name;
      const share = total > 0 ? (load / total) * 100 : 0;
      const offsetMs = (frame.ts - originNs) / 1e6;
      const durMs = frame.dur / 1e6;
      const topThread = index.threadLoads(frame)[0];
      return evidence({
        kind: 'frame_load',
        severity: 'info',
        subject: { process, frameNo: frame.frameNo },
        window: { startNs: frame.ts, endNs: frame.ts + frame.dur },
        // `frame_no` is 0 on every real row, so two same-process frames with
        // the same (ts, dur) hash to the same id and the engine rejects the
        // whole analysis with DUPLICATE_EVIDENCE_ID. The row id separates
        // them; it is hash material only and does not enter the object.
        key: `frame:${frame.id}`,
        signals: {
          rank: rankOf.get(frame.id) ?? 0,
          load,
          share,
          durMs,
          offsetMs,
          vsync: frame.vsync,
          flag: frame.flag,
          topThread: topThread?.threadName ?? 'unknown',
          topThreadLoad: topThread?.samples ?? 0,
        },
        explain:
          `${process} frame at ${offsetMs.toFixed(1)}ms cost ${load} sampled events ` +
          `(${share.toFixed(1)}% of frame load, dur ${durMs.toFixed(1)}ms, flag ${frame.flag})`,
        drillDown: [
          { label: 'Frame detail', tool: 'frames.get', args: { id: frame.id }, returns: 'Frame' },
          {
            label: 'Load by thread',
            tool: 'frame.load.threads',
            args: { startNs: frame.ts, endNs: frame.ts + frame.dur },
            returns: 'FrameLoadThread[]',
            estRows: index.threadCount,
          },
          {
            label: 'Load by symbol',
            tool: 'frame.load.symbols',
            args: { startNs: frame.ts, endNs: frame.ts + frame.dur },
            returns: 'PerfLeafAttribution[]',
          },
          {
            label: 'Callstack for frame',
            tool: 'callstack.range',
            args: { startNs: frame.ts, endNs: frame.ts + frame.dur },
            returns: 'CallstackEvent[]',
          },
        ],
      });
    });

    metrics.sort(byMetricId);
    evidenceItems.sort(byEvidenceOrder);
    return { metrics, evidence: evidenceItems };
  }
}
