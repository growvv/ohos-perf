// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { CapabilityId } from '../device/capability';
import type { QueryHandle } from '../db/driver';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import { NativeHookQuery, type NativeHookEvent } from '../query/native-hook';
import { ProcessQuery, ThreadQuery } from '../query/process';
import type { TimeRange } from '../types';
import { classifyNativePath } from './native-kinds';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** What an event does to the running total. */
export type NativeEventKind = 'alloc' | 'free' | 'other';

/**
 * Classifies `native_hook.event_type`.
 *
 * The column is numeric on the recorded traces but upstream compares it to
 * strings, so both forms are accepted. `null` — the column was NULL — and
 * anything else unrecognised is `other`: it is counted, but it must not move
 * the total in either direction.
 */
export function nativeEventKind(eventType: number | string | null): NativeEventKind {
  if (eventType === 0 || eventType === 'AllocEvent' || eventType === 'MmapEvent') return 'alloc';
  if (eventType === 1 || eventType === 'FreeEvent' || eventType === 'MunmapEvent') return 'free';
  return 'other';
}

/** One allocation still live at a given instant. */
export interface ActiveAlloc {
  addr: number;
  /** Remaining bytes; a partial free leaves a smaller size. */
  size: number;
  pid: number;
  tid: number;
  /** `0` means the event carried no callchain, so the block is unattributable. */
  callchainId: number;
  relativeNs: number;
}

/** Everything one replay of the events establishes. */
export interface NativeMemoryResult {
  /** Events read, including types that are neither alloc nor free. */
  events: number;
  allocCount: number;
  allocBytes: number;
  freeCount: number;
  freeBytes: number;
  /** Highest running total and the timestamp of the event that produced it. */
  peak: number;
  peakTs: number;
  /**
   * Id of the event that produced the peak, `null` when the peak is the initial
   * zero before any event. `(peakTs, peakId)` is the position the peak's
   * unreleased set must be replayed to: several events can share a timestamp,
   * and replaying all of them would report the set after later events already
   * ran.
   */
  peakId: number | null;
  /** Lowest running total; negative when the capture started mid-lifetime. */
  trough: number;
  /** Running total after the last event. */
  endTotal: number;
  /** Allocations whose address was NULL; they can never be freed. */
  unaddressedAllocs: number;
  /** Frees of an address with no tracked allocation. */
  unpairedFrees: number;
  /** Live bytes at the end whose event carried no callchain. */
  unattributedBytes: number;
  /**
   * Live allocations at the `(ts, id)` position, in event order. Omit `id` to
   * take the state after every event at `ts`.
   */
  unreleasedAt(ts: number, id?: number): ActiveAlloc[];
}

/** Events ordered by `(start_ts, id)`; the tie-break makes the walk stable. */
function ordered(events: readonly NativeHookEvent[]): NativeHookEvent[] {
  return [...events].sort((a, b) => a.startTs - b.startTs || a.id - b.id);
}

interface Replay {
  total: number;
  peak: number;
  peakTs: number;
  peakId: number | null;
  trough: number;
  unpairedFrees: number;
  unaddressedAllocs: number;
  allocCount: number;
  allocBytes: number;
  freeCount: number;
  freeBytes: number;
  active: Map<number, ActiveAlloc[]>;
  /** Event timestamp the replay stopped after; the last event's for a full run. */
  lastTs: number;
}

/**
 * Walks the events up to and including the `(untilTs, untilId)` position (all
 * events when omitted). The id bounds a timestamp shared by several events:
 * without it a peak at `ts` would be reported after every event at `ts` ran.
 *
 * Pairing is per address and LIFO: a runtime can reuse an address before the
 * previous block is released, so a free must consume the newest block first and
 * continue into older ones when it is larger. A partial free leaves a smaller
 * active block behind.
 */
function replay(events: readonly NativeHookEvent[], untilTs?: number, untilId?: number): Replay {
  const state: Replay = {
    total: 0,
    peak: 0,
    peakTs: events[0]?.startTs ?? 0,
    peakId: null,
    trough: 0,
    unpairedFrees: 0,
    unaddressedAllocs: 0,
    allocCount: 0,
    allocBytes: 0,
    freeCount: 0,
    freeBytes: 0,
    active: new Map(),
    lastTs: events[0]?.startTs ?? 0,
  };
  const origin = events[0]?.startTs ?? 0;

  for (const event of events) {
    if (untilTs !== undefined) {
      if (event.startTs > untilTs) break;
      if (event.startTs === untilTs && untilId !== undefined && event.id > untilId) break;
    }
    state.lastTs = event.startTs;
    const kind = nativeEventKind(event.eventType);
    if (kind === 'other') continue;

    // `heap_size` is stored as a magnitude; the sign comes from the event type.
    const size = Math.abs(event.heapSize);

    if (kind === 'alloc') {
      state.allocCount += 1;
      state.allocBytes += size;
      state.total += size;
      if (event.addr === 0) {
        state.unaddressedAllocs += 1;
      } else {
        const stack = state.active.get(event.addr);
        const alloc: ActiveAlloc = {
          addr: event.addr,
          size,
          pid: event.pid ?? 0,
          tid: event.itid,
          callchainId: event.callchainId,
          relativeNs: event.startTs - origin,
        };
        if (stack === undefined) state.active.set(event.addr, [alloc]);
        else stack.push(alloc);
      }
    } else {
      state.freeCount += 1;
      state.freeBytes += size;
      state.total -= size;
      const stack = state.active.get(event.addr);
      let remaining = size;
      if (stack !== undefined) {
        while (remaining > 0 && stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.size > remaining) {
            top.size -= remaining;
            remaining = 0;
          } else {
            remaining -= top.size;
            stack.pop();
          }
        }
        if (stack.length === 0) state.active.delete(event.addr);
      }
      // A free with nothing to consume still moves the total — dropping it
      // would understate a free-heavy capture — but it is counted so the
      // reader can see the total is not fully explained by paired events.
      // A zero-size free consumes nothing and is not evidence of a missing
      // allocation, so it is not unpaired: `heap_size` of 0 (or a NULL read as
      // 0) would otherwise inflate the count with a free that freed nothing.
      if (size > 0 && (stack === undefined || size === remaining)) state.unpairedFrees += 1;
    }

    if (state.total > state.peak) {
      state.peak = state.total;
      state.peakTs = event.startTs;
      state.peakId = event.id;
    }
    if (state.total < state.trough) state.trough = state.total;
  }
  return state;
}

/**
 * Pairs allocation and free events by address and derives the memory profile.
 *
 * The result is a pure function of the events: ordering, ties and the
 * unreleased sets never depend on map iteration or input order, so two runs
 * over the same capture are byte-identical.
 *
 * A capture that began after allocations happened starts its total at `0` and
 * may trough negative. That is reported, not clamped: clamping would make every
 * absolute figure after the trough look larger than it is.
 */
export function pairNativeMemory(
  events: readonly NativeHookEvent[],
): NativeMemoryResult {
  const sorted = ordered(events);
  const full = replay(sorted);
  const origin = sorted[0]?.startTs ?? 0;

  // Unattributed bytes are a property of the end instant: they answer "how much
  // live memory can no callchain explain", which only means something once the
  // whole capture has been replayed.
  let unattributedBytes = 0;
  for (const stack of full.active.values()) {
    for (const alloc of stack) {
      if (alloc.callchainId === 0) unattributedBytes += alloc.size;
    }
  }

  return {
    events: sorted.length,
    allocCount: full.allocCount,
    allocBytes: full.allocBytes,
    freeCount: full.freeCount,
    freeBytes: full.freeBytes,
    peak: full.peak,
    peakTs: full.peakTs,
    peakId: full.peakId,
    trough: full.trough,
    endTotal: full.total,
    unaddressedAllocs: full.unaddressedAllocs,
    unpairedFrees: full.unpairedFrees,
    unattributedBytes,
    unreleasedAt(ts: number, id?: number): ActiveAlloc[] {
      const state = replay(sorted, ts, id);
      const live: ActiveAlloc[] = [];
      for (const stack of state.active.values()) {
        for (const alloc of stack) {
          // A block with no callchain cannot be attributed to a row; its bytes
          // are reported once by `unattributedBytes` instead.
          if (alloc.callchainId !== 0 && alloc.size > 0) live.push({ ...alloc });
        }
      }
      return live;
    },
  };
}

/** First app-event timestamp; the origin for every relative figure. */
export function nativeOrigin(events: readonly NativeHookEvent[]): number {
  return ordered(events)[0]?.startTs ?? 0;
}

/** Last app-event timestamp, used as the end instant. */
export function nativeEndTs(events: readonly NativeHookEvent[]): number {
  const sorted = ordered(events);
  return sorted[sorted.length - 1]?.startTs ?? 0;
}

/** Name lookups the aggregation needs, all resolved by the caller once. */
export interface NativeNames {
  /** `process.pid` → process name. */
  processes: Map<number, string>;
  /** `thread.itid` → thread name. */
  threads: Map<number, string>;
  /** `data_dict` id → file path. */
  files: Map<number, string>;
  /** `data_dict` id → symbol. */
  symbols: Map<number, string>;
  /** `callchain_id` → its deepest frame, the one that owns the allocation. */
  frameLeaves: Map<number, { fileId: number; symbolId: number }>;
}

/** One unreleased-memory row: a callchain and thread at one instant. */
export interface UnreleasedRow {
  callchainId: number;
  pid: number;
  process: string;
  tid: number;
  thread: string;
  file: string;
  symbol: string;
  /** Summed remaining bytes. */
  size: number;
  /** Active allocations merged into this row. */
  count: number;
  /** Earliest allocation instant, relative to the first app event. */
  firstRelativeNs: number;
  category: number;
  categoryName: string;
  subCategory: string;
}

function rowOrder(a: UnreleasedRow, b: UnreleasedRow): number {
  return (
    b.size - a.size ||
    a.callchainId - b.callchainId ||
    a.pid - b.pid ||
    a.tid - b.tid
  );
}

/**
 * Resolves every name the aggregation needs from the trace's own tables.
 *
 * The leaf frame is the deepest one: `NativeHookQuery.frames` orders by
 * `(callchain_id, depth, id)`, so the last entry of each list is the
 * allocation site. A callchain with no frames keeps no leaf entry, and its
 * rows then carry no file or symbol.
 */
export function buildNativeNames(
  query: NativeHookQuery,
  events: readonly NativeHookEvent[],
  processNames: ReadonlyMap<number, string>,
  threadNames: ReadonlyMap<number, string>,
): NativeNames {
  const callchainIds = [...new Set(events.map((event) => event.callchainId))].filter(
    (id) => id > 0,
  );
  const frames = query.frames(callchainIds);
  const frameLeaves = new Map<number, { fileId: number; symbolId: number }>();
  const fileIds: number[] = [];
  const symbolIds: number[] = [];
  for (const [callchainId, list] of frames) {
    const leaf = list[list.length - 1];
    if (leaf === undefined) continue;
    frameLeaves.set(callchainId, { fileId: leaf.fileId, symbolId: leaf.symbolId });
    fileIds.push(leaf.fileId);
    symbolIds.push(leaf.symbolId);
  }
  return {
    processes: new Map(processNames),
    threads: new Map(threadNames),
    files: query.dataDict(fileIds),
    symbols: query.dataDict(symbolIds),
    frameLeaves,
  };
}

/**
 * Merges live allocations into rows keyed by `(callchainId, pid, tid)`.
 *
 * The process, thread, file and symbol come from the trace's own name tables;
 * a name the trace does not carry is `''` for a process and `'unknown'` for a
 * thread, matching how the rest of the package renders a missing name. The
 * category is resolved from the leaf frame, because the leaf is the allocation
 * site, not the outermost caller.
 */
export function aggregateUnreleased(
  allocs: readonly ActiveAlloc[],
  names: NativeNames,
): UnreleasedRow[] {
  const rows = new Map<string, UnreleasedRow>();
  for (const alloc of allocs) {
    const key = `${alloc.callchainId}:${alloc.pid}:${alloc.tid}`;
    const existing = rows.get(key);
    if (existing !== undefined) {
      existing.size += alloc.size;
      existing.count += 1;
      existing.firstRelativeNs = Math.min(existing.firstRelativeNs, alloc.relativeNs);
      continue;
    }
    const leaf = names.frameLeaves.get(alloc.callchainId);
    const file = leaf === undefined ? '' : names.files.get(leaf.fileId) ?? '';
    const symbol = leaf === undefined ? '' : names.symbols.get(leaf.symbolId) ?? '';
    const thread = names.threads.get(alloc.tid) ?? 'unknown';
    const category = classifyNativePath(file.length > 0 ? file : null, symbol.length > 0 ? symbol : null, thread);
    rows.set(key, {
      callchainId: alloc.callchainId,
      pid: alloc.pid,
      process: names.processes.get(alloc.pid) ?? '',
      tid: alloc.tid,
      thread,
      file,
      symbol,
      size: alloc.size,
      count: 1,
      firstRelativeNs: alloc.relativeNs,
      category: category.category,
      categoryName: category.categoryName,
      subCategory: category.subCategory,
    });
  }
  return [...rows.values()].sort(rowOrder);
}

/**
 * Everything one native-memory read establishes, or `undefined` when the
 * capture has no `native_hook` rows for the app.
 *
 * Both the analyzer and the named queries go through here, so "unreleased at
 * the end" means the same rows in the report and in a drill-down.
 */
export interface NativeSnapshot {
  events: NativeHookEvent[];
  names: NativeNames;
  pair: NativeMemoryResult;
  /** First and last event timestamps, the instant `peak`/`end` are relative to. */
  origin: number;
  endTs: number;
}

/**
 * Reads and pairs the app's native events.
 *
 * An absent or empty `native_hook` table yields `undefined` rather than a
 * zero-valued result: the caller must be able to tell "no native data" from
 * "no native allocations", and only the first is degraded.
 */
export function loadNativeMemory(
  db: QueryHandle,
  pids: readonly number[],
  range?: TimeRange,
): NativeSnapshot | undefined {
  if (pids.length === 0) return undefined;
  const query = new NativeHookQuery(db);
  const events = query.events(pids, range);
  if (events.length === 0) return undefined;

  const processes = new Map<number, string>();
  for (const process of new ProcessQuery(db).all()) {
    if (!processes.has(process.pid)) processes.set(process.pid, process.name);
  }
  const threads = new Map<number, string>();
  for (const thread of new ThreadQuery(db).all()) {
    if (!threads.has(thread.itid)) threads.set(thread.itid, thread.name);
  }

  return {
    events,
    names: buildNativeNames(query, events, processes, threads),
    pair: pairNativeMemory(events),
    origin: nativeOrigin(events),
    endTs: nativeEndTs(events),
  };
}

/** One timeline bucket; only buckets that saw an event are emitted. */
export interface NativeTimelineBucket {
  startNs: number;
  endNs: number;
  allocBytes: number;
  freeBytes: number;
  /** `allocBytes - freeBytes` for this bucket. */
  deltaBytes: number;
  /** Running total after the bucket's last event. */
  totalBytes: number;
  isPeak: boolean;
}

/** Default bucket width: one second. */
const DEFAULT_BUCKET_NS = 1_000_000_000;

/**
 * Buckets the events into fixed windows anchored at the first event.
 *
 * An empty bucket is omitted rather than emitted as zeros: "the capture
 * recorded nothing here" and "nothing changed here" are different facts, and a
 * zero would conflate them. `isPeak` marks the bucket holding the peak event,
 * so a reader can find the worst instant without re-deriving it.
 */
export function buildNativeTimeline(
  events: readonly NativeHookEvent[],
  bucketNs: number = DEFAULT_BUCKET_NS,
): NativeTimelineBucket[] {
  if (!Number.isFinite(bucketNs) || bucketNs <= 0) {
    throw new Error(`bucketNs must be a positive finite number of nanoseconds, got ${bucketNs}`);
  }
  const sorted = ordered(events);
  const origin = sorted[0]?.startTs ?? 0;
  const buckets = new Map<number, NativeTimelineBucket>();
  let total = 0;
  let peak = Number.NEGATIVE_INFINITY;
  let peakIndex = -1;

  for (const event of sorted) {
    const kind = nativeEventKind(event.eventType);
    if (kind === 'other') continue;
    const size = Math.abs(event.heapSize);
    const index = Math.floor((event.startTs - origin) / bucketNs);
    let bucket = buckets.get(index);
    if (bucket === undefined) {
      const startNs = origin + index * bucketNs;
      bucket = {
        startNs,
        endNs: startNs + bucketNs,
        allocBytes: 0,
        freeBytes: 0,
        deltaBytes: 0,
        totalBytes: 0,
        isPeak: false,
      };
      buckets.set(index, bucket);
    }
    if (kind === 'alloc') {
      bucket.allocBytes += size;
      bucket.deltaBytes += size;
      total += size;
    } else {
      bucket.freeBytes += size;
      bucket.deltaBytes -= size;
      total -= size;
    }
    bucket.totalBytes = total;
    if (total > peak) {
      peak = total;
      peakIndex = index;
    }
  }

  const result = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => bucket);
  const peakBucket = buckets.get(peakIndex);
  if (peakBucket !== undefined) peakBucket.isPeak = true;
  return result;
}

/** Rows that carry an evidence item at each point. */
const EVIDENCE_LIMIT = 10;
/** A row at or above this share of the point's total is a warning. */
const WARN_SHARE = 5;

/** First non-empty app process name, matching the other analyzers. */
function appProcessName(ctx: AnalyzeContext): string {
  return ctx.app.processNames.find((name) => name !== '') ?? ctx.app.packageName;
}

function byMetricId(a: Metric, b: Metric): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function byEvidenceOrder(a: Evidence, b: Evidence): number {
  if (a.kind < b.kind) return -1;
  if (a.kind > b.kind) return 1;
  if (a.window.startNs < b.window.startNs) return -1;
  if (a.window.startNs > b.window.startNs) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The proxy + explanation a caller gets when nothing can be measured. */
function degradedResult(ctx: AnalyzeContext, reason: string): AnalyzeResult {
  return {
    metrics: [
      metric({
        id: 'mem.native.degraded',
        value: 0,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason, fallback: 'no native memory measurement' },
        provenance: { collector: 'hiprofiler', device: ctx.deviceId },
        window: ctx.window,
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
        key: 'native-memory:no-data',
      }),
    ],
  };
}

const STATISTIC_REASON =
  'native_hook_statistic carries no per-allocation timestamp, thread or address, ' +
  'so peak, timeline and the per-thread split are unavailable';

function sumRows(rows: readonly UnreleasedRow[]): number {
  return rows.reduce((sum, row) => sum + row.size, 0);
}

function distinctCallchains(rows: readonly UnreleasedRow[]): number {
  return new Set(rows.map((row) => row.callchainId)).size;
}

/**
 * Native heap growth from the `nativehook` hiprofiler plugin.
 *
 * The analyzer pairs alloc and free events per address and reports the running
 * total, its peak and trough, and what was still live at the peak and at the
 * end. "Unreleased" is a statement about the capture window, not a leak claim:
 * memory still held when the trace stopped may be freed a millisecond later,
 * and a trace that began mid-lifetime starts at zero and can trough negative.
 *
 * When only `native_hook_statistic` exists the analyzer reports the end-of-
 * capture unreleased bytes per callchain as a proxy and deliberately omits the
 * peak, the timeline and the thread split — those rows cannot support them.
 */
export class NativeMemoryAnalyzer implements Analyzer {
  readonly id = 'native-memory';
  readonly requires: CapabilityId[] = ['mem.native_hook'];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    if (ctx.db === undefined) {
      return degradedResult(ctx, 'the trace database handle is not available');
    }
    if (ctx.app.pids.length === 0) {
      return degradedResult(
        ctx,
        'the capture has no pid for the app, so native_hook rows cannot be attributed',
      );
    }

    const snapshot = loadNativeMemory(ctx.db, ctx.app.pids, ctx.window);
    if (snapshot === undefined) {
      const query = new NativeHookQuery(ctx.db);
      // App-scoped, not table-wide: another process's statistic rows cannot
      // stand in for this app's, and the fallback would otherwise report
      // "0 bytes across 0 callchains" as if it had measured something.
      if (query.statistics(ctx.app.pids).length === 0) {
        return degradedResult(
          ctx,
          'the trace has no native_hook or native_hook_statistic rows for the app; ' +
            'capture with `hiprofiler --plugins nativehook` against a debuggable app',
        );
      }
      return this.statisticsOnly(ctx, query);
    }

    const { pair, names, endTs } = snapshot;
    // The peak's set is the state right after the peak event, not after every
    // event sharing its timestamp: `(peakTs, peakId)` is the position. A peak
    // that never rose above zero (`peakId === null`) has nothing live.
    const peakRows =
      pair.peakId === null
        ? []
        : aggregateUnreleased(pair.unreleasedAt(pair.peakTs, pair.peakId), names);
    const endRows = aggregateUnreleased(pair.unreleasedAt(endTs), names);
    const process = appProcessName(ctx);
    const prov = {
      collector: 'hiprofiler',
      table: 'native_hook',
      rows: snapshot.events.length,
      device: ctx.deviceId,
    };

    const metrics: Metric[] = [
      metric({
        id: 'mem.native.events.count',
        value: snapshot.events.length,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.alloc.count',
        value: pair.allocCount,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.alloc.bytes',
        value: pair.allocBytes,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.free.count',
        value: pair.freeCount,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.free.bytes',
        value: pair.freeBytes,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.total.peak',
        value: pair.peak,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.total.trough',
        value: pair.trough,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.total.end',
        value: pair.endTotal,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.unreleased.peak',
        value: sumRows(peakRows),
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.unreleased.end',
        value: sumRows(endRows),
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.unreleased.unattributed.bytes',
        value: pair.unattributedBytes,
        unit: 'bytes',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.alloc.unaddressed.count',
        value: pair.unaddressedAllocs,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.free.unpaired.count',
        value: pair.unpairedFrees,
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.callchains.count',
        value: distinctCallchains(endRows),
        unit: 'count',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.peak.offset',
        value: (pair.peakTs - snapshot.origin) / 1e6,
        unit: 'ms',
        provenance: prov,
        fidelity: 'exact',
        window: ctx.window,
      }),
    ];

    const items: Evidence[] = [
      ...this.pointEvidence(ctx, process, 'peak', pair.peakTs, peakRows),
      ...this.pointEvidence(ctx, process, 'end', endTs, endRows),
    ];

    metrics.sort(byMetricId);
    items.sort(byEvidenceOrder);
    return { metrics, evidence: items };
  }

  /**
   * The top rows at one instant, each with the queries that explain it.
   *
   * The severity threshold is a concentration signal — a row holding a large
   * share of live memory is worth a look — not a judgment that it is wrong.
   */
  private pointEvidence(
    ctx: AnalyzeContext,
    process: string,
    point: 'peak' | 'end',
    ts: number,
    rows: readonly UnreleasedRow[],
  ): Evidence[] {
    const total = sumRows(rows);
    return rows.slice(0, EVIDENCE_LIMIT).map((row) => {
      const share = total > 0 ? (row.size / total) * 100 : 0;
      const window = {
        startNs: Math.max(ctx.window.startNs, ts - 500_000_000),
        endNs: Math.min(ctx.window.endNs, ts + 500_000_000),
      };
      return evidence({
        kind: 'native_memory',
        severity: share >= WARN_SHARE ? 'warn' : 'info',
        subject: { process, thread: row.thread, pid: row.pid },
        window,
        // Every row at one point shares the window, and usually the process,
        // thread and pid, so the id material alone collides — and the engine
        // turns a collision into DUPLICATE_EVIDENCE_ID, failing the whole run.
        // The point and the callchain are what actually distinguish the rows.
        key: `native-memory:${point}:${row.callchainId}:${row.pid}:${row.tid}`,
        signals: {
          point,
          size: row.size,
          count: row.count,
          share,
          relativeMs: row.firstRelativeNs / 1e6,
          callchainId: row.callchainId,
          pid: row.pid,
          tid: row.tid,
          category: row.category,
          categoryName: row.categoryName,
          subCategory: row.subCategory,
          file: row.file,
          symbol: row.symbol,
        },
        explain:
          `${row.size} bytes still allocated at the ${point} of the capture ` +
          `(${row.count} block${row.count === 1 ? '' : 's'}) in ` +
          `${row.symbol || row.file || 'an unknown frame'} on thread ${row.thread}; ` +
          'unreleased means "still live when the capture stopped", not "leaked"',
        drillDown: [
          {
            label: 'Full callchain',
            tool: 'mem.native.callchain',
            args: { callchainId: row.callchainId },
            returns: 'NativeCallchainFrame[]',
          },
          {
            label: `All unreleased rows at the ${point}`,
            tool: 'mem.native.unreleased',
            args: { point },
            returns: 'UnreleasedRow[]',
          },
          {
            label: 'Frames around this instant',
            tool: 'frames.all',
            args: { window },
            returns: 'Frame[]',
          },
        ],
      });
    });
  }

  /** The statistic-only path: end-of-capture totals, explicitly a proxy. */
  private statisticsOnly(ctx: AnalyzeContext, query: NativeHookQuery): AnalyzeResult {
    const rows = query.statistics(ctx.app.pids);
    const byCallchain = new Map<number, number>();
    for (const row of rows) {
      const live = row.applySize - row.releaseSize;
      byCallchain.set(row.callchainId, (byCallchain.get(row.callchainId) ?? 0) + live);
    }
    const end = [...byCallchain.values()].reduce((sum, value) => sum + value, 0);
    const prov = {
      collector: 'hiprofiler',
      table: 'native_hook_statistic',
      rows: rows.length,
      device: ctx.deviceId,
    };
    const metrics: Metric[] = [
      metric({
        id: 'mem.native.statistic.fallback',
        value: 1,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason: STATISTIC_REASON, fallback: 'native_hook_statistic' },
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.unreleased.end',
        value: end,
        unit: 'bytes',
        fidelity: 'proxy',
        degraded: { reason: STATISTIC_REASON, fallback: 'apply_size - release_size' },
        provenance: prov,
        window: ctx.window,
      }),
      metric({
        id: 'mem.native.callchains.count',
        value: byCallchain.size,
        unit: 'count',
        fidelity: 'proxy',
        degraded: { reason: STATISTIC_REASON, fallback: 'distinct statistic callchains' },
        provenance: prov,
        window: ctx.window,
      }),
    ];
    metrics.sort(byMetricId);
    return {
      metrics,
      evidence: [
        evidence({
          kind: 'native_memory',
          severity: 'info',
          subject: { process: appProcessName(ctx) },
          window: ctx.window,
          signals: { point: 'end', size: end, count: byCallchain.size },
          explain:
            `native_hook_statistic reports ${end} bytes still allocated across ` +
            `${byCallchain.size} callchains at the end of the capture; ${STATISTIC_REASON}`,
          drillDown: [],
        }),
      ],
    };
  }
}
