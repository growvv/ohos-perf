import type { TimeRange } from '../types';
import type { Frame } from '../query/frames';
import type { PerfQuery } from '../query/perf';

/** One app thread's share of a frame's sampled-event load. */
export interface FrameLoadThread {
  threadId: number;
  threadName: string;
  /** Summed `event_count` inside the frame window. */
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
    return this.threadLoads(frame).reduce((sum, row) => sum + row.samples, 0);
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
