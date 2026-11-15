// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { QueryHandle } from '../db/driver';
import { OhosPerfError } from '../errors';
import { PerfQuery } from '../query/perf';
import {
  ProcessQuery,
  ThreadQuery,
  type ProcessInfo,
  type ThreadInfo,
} from '../query/process';
import { num, str } from '../query/rows';
import { InstantQuery } from '../query/sched';
import type { TimeRange } from '../types';

/** HapRay `find_wakeup_chain`: how far before the frame start it may look. */
const SEARCH_WINDOW_NS = 50_000_000;
/** HapRay `find_wakeup_chain`: `max_depth = 20`. */
const MAX_WAKEUP_DEPTH = 20;
/**
 * HapRay `_query_callchains_batch`: at most 20 chains are returned per thread.
 * `PerfQuery.callchains` enforces this cap and the 50-distinct-chain-id cap.
 */
const MAX_RETURNED_CALLCHAINS = 20;

/**
 * The tables HapRay tries, in order, when no explicit range is supplied.
 *
 * `callstack_events` and `trace` do not exist in every trace_streamer output,
 * so an absent table is skipped rather than queried.
 */
const RANGE_TABLES = ['trace_range', 'frame_slice', 'callstack_events', 'trace'];

/**
 * HapRay's process-name patterns, verbatim from `frame_utils.is_system_thread`.
 *
 * A `%` suffix is a prefix rule and a `.` suffix is a prefix rule; anything
 * else is a substring match.
 */
const SYSTEM_PROCESS_PATTERNS = [
  'hiperf',
  'render_service',
  'sysmgr-main',
  'OS_%',
  'ohos.%',
  'pp.%',
  'hilogd',
  'hiprofiler',
  'hiprofiler_cmd',
  'hiprofiler_plug',
  'hiprofilerd',
  'kworker',
  'hdcd',
  'hiview',
  'foundation',
  'resource_schedu',
  'netmanager',
  'wifi_manager',
  'telephony',
  'sensors',
  'multimodalinput',
  'accountmgr',
  'accesstoken_ser',
  'samgr',
  'memmgrservice',
  'distributeddata',
  'privacy_service',
  'security_guard',
  'time_service',
  'bluetooth_servi',
  'media_service',
  'audio_server',
  'rmrenderservice',
  'ohos.sceneboard',
];

/**
 * HapRay's thread-name patterns, verbatim from `frame_utils.is_system_thread`.
 *
 * Here `%` and `_` suffixes are prefix rules; anything else is a substring
 * match. Note the difference from the process list: `_`, not `.`.
 */
const SYSTEM_THREAD_PATTERNS = [
  'OS_%',
  'ohos.%',
  'pp.%',
  'hiperf',
  'hiprofiler',
  'hiprofiler_cmd',
  'hiprofiler_plug',
  'hiprofilerd',
  'HmTraceReader',
  'kworker',
  'hilogd',
  'render_service',
  'VSyncGenerator',
  'RSUniRenderThre',
  'RSHardwareThrea',
  'RSBackgroundThr',
  'Present Fence',
  'Acquire Fence',
  'Release Fence',
  'gpu-work-server',
  'tppmgr-sched-in',
  'tppmgr-misc',
  'fs-kmsgfd',
  'dh-irq-bind',
  'dpu_gfx_primary',
  'display_engine_',
  'gpu-pm-release',
  'hisi_frw',
  'rcu_sched',
  'effect thread',
  'gpu-wq-id',
  'gpu-token-id',
  'irq/',
  'ksoftirqd',
  'netlink_handle',
  'hisi_tx_sch',
  'hisi_hcc',
  'hisi_rxdata',
  'spi',
  'gpufreq',
  'npu_excp',
  'dra_thread',
  'agent_vltmm',
  'tuid',
  'hw_kstate',
  'pci_ete_rx0',
  'wlan_bus_rx',
  'bbox_main',
  'kthread-joind',
  'dmabuf-deferred',
  'chr_web_thread',
  'ldk-kallocd',
];

/** One app thread row, from the `thread JOIN process` query. */
interface AppThreadRow {
  itid: number;
  tid: number;
  name: string | null;
  pid: number | null;
  processName: string | null;
}

interface RawAppThreadRow {
  itid: number | null;
  tid: number | null;
  name: string | null;
  pid: number | null;
  process_name: string | null;
}

/**
 * One row of HapRay's `thread_info_map`.
 *
 * `tid`, `name`, `pid` and `processName` keep SQL NULL: the public wakeup
 * entry exposes them as `null`, and HapRay's raw query distinguishes a missing
 * name from an empty one.
 */
interface ThreadInfoRow {
  id: number | null;
  itid: number | null;
  tid: number | null;
  name: string | null;
  pid: number | null;
  processName: string | null;
}

interface RawThreadInfoRow {
  id: number | null;
  itid: number | null;
  tid: number | null;
  name: string | null;
  pid: number | null;
  process_name: string | null;
}

/** `tid -> names` from HapRay `_build_tid_to_info_cache`. */
interface TidInfo {
  threadName: string;
  processName: string;
}

/** HapRay `_build_perf_thread_id_map`'s three lookup structures. */
interface PerfThreadMaps {
  pidTidToPerfTid: Map<string, number>;
  pidNameToPerfTid: Map<string, number>;
  validPerfTidsByPid: Map<number, Set<number>>;
}

/** App- and system-thread instruction totals, split as HapRay splits them. */
interface InstructionTotals {
  app: Map<number, number>;
  system: Map<number, number>;
}

/** One link of a wakeup chain: a trace itid and its BFS depth. */
interface WakeupChainEntry {
  itid: number;
  depth: number;
}

/** The callchain shape carried by one wakeup thread. */
type WakeupCallchains = ThreadWakeupThread['callchains'];
type ThreadStates = ThreadWakeupThread['threadStates'];

/**
 * One thread taking part in an app thread's wakeup chain.
 *
 * Field names and nullability follow the HapRay payload: `tid`, `threadName`,
 * `pid` and `processName` stay `null` when the trace row has no value.
 */
export interface ThreadWakeupThread {
  itid: number;
  tid: number | null;
  threadName: string | null;
  pid: number | null;
  processName: string | null;
  instructionCount: number;
  isSystemThread: boolean;
  wakeupDepth: number;
  threadStates: Array<{ ts: number; dur: number; state: string }>;
  callchains: Array<{
    functions: Array<{ symbol: string; name: string; filePath: string }>;
  }>;
}

/** One app thread's wakeup-chain analysis, as HapRay's ThreadWakeup payload. */
export interface ThreadWakeupResult {
  threadId: number;
  threadInfo: {
    threadName: string;
    startTs: number | null;
    endTs: number | null;
  };
  totalInstructions: number;
  wakeupThreads: ThreadWakeupThread[];
}

/**
 * HapRay `frame_utils.is_system_thread`, including both pattern lists.
 *
 * A null/undefined name is the empty string. Process patterns win over thread
 * patterns; on both lists a trailing `%` is a prefix rule, a trailing `.`
 * (process) or `_` (thread) is a prefix rule, and everything else is a
 * substring match.
 */
function isSystemThread(
  processName: string | null | undefined,
  threadName: string | null | undefined,
): boolean {
  const process = processName ?? '';
  const thread = threadName ?? '';
  for (const pattern of SYSTEM_PROCESS_PATTERNS) {
    if (pattern.endsWith('%')) {
      if (process.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern.endsWith('.')) {
      if (process.startsWith(pattern)) return true;
    } else if (process.includes(pattern) || process === pattern) {
      return true;
    }
  }
  for (const pattern of SYSTEM_THREAD_PATTERNS) {
    if (pattern.endsWith('%')) {
      if (thread.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern.endsWith('_')) {
      if (thread.startsWith(pattern)) return true;
    } else if (thread.includes(pattern) || thread === pattern) {
      return true;
    }
  }
  return false;
}

/** True when `name` is a user table (HapRay checks `type = 'table'`). */
function hasTable(db: QueryHandle, name: string): boolean {
  return (
    db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    ).length > 0
  );
}

/** HapRay's `trace_range` branch: first row, both columns non-NULL. */
function readTraceRange(db: QueryHandle): TimeRange | null {
  const [row] = db.query<{ start_ts: number | null; end_ts: number | null }>(
    'SELECT start_ts, end_ts FROM trace_range LIMIT 1',
  );
  if (!row || row.start_ts === null || row.end_ts === null) return null;
  return { startNs: row.start_ts, endNs: row.end_ts };
}

/**
 * HapRay's `min(ts), max(ts)` branch for every non-`trace_range` table.
 *
 * `table` is always one of the fixed `RANGE_TABLES` entries, never input.
 */
function readMinMaxRange(db: QueryHandle, table: string): TimeRange | null {
  const [row] = db.query<{ min_ts: number | null; max_ts: number | null }>(
    `SELECT min(ts) AS min_ts, max(ts) AS max_ts FROM ${table}`,
  );
  if (!row || row.min_ts === null || row.max_ts === null) return null;
  return { startNs: row.min_ts, endNs: row.max_ts };
}

/**
 * HapRay's range fallback chain: `trace_range -> frame_slice ->
 * callstack_events -> trace`.
 *
 * An explicit range always wins. An absent table, an empty result, or a query
 * error moves on to the next table. `frame_slice` additionally extends the end
 * to `max(ts + COALESCE(dur, 0))`, because a slice's duration may run past its
 * last start. When no table yields a range the analysis cannot be faithful,
 * so this fails with `THREAD_NO_TIME_RANGE` instead of inventing one.
 */
function resolveTimeRange(db: QueryHandle, explicit?: TimeRange): TimeRange {
  if (explicit !== undefined) {
    return { startNs: explicit.startNs, endNs: explicit.endNs };
  }

  for (const table of RANGE_TABLES) {
    if (!hasTable(db, table)) continue;
    try {
      const range =
        table === 'trace_range'
          ? readTraceRange(db)
          : readMinMaxRange(db, table);
      if (range === null) continue;
      let endNs = range.endNs;
      if (table === 'frame_slice') {
        const [extended] = db.query<{ max_end: number | null }>(
          'SELECT max(ts + COALESCE(dur, 0)) AS max_end FROM frame_slice',
        );
        if (extended?.max_end != null) {
          endNs = Math.max(endNs, extended.max_end);
        }
      }
      return { startNs: range.startNs, endNs };
    } catch {
      // HapRay catches per-table failures and tries the next table.
      continue;
    }
  }

  throw new OhosPerfError('THREAD_NO_TIME_RANGE', {
    code: 'THREAD_NO_TIME_RANGE',
  });
}

/**
 * HapRay's per-app-thread query:
 * `thread JOIN process ON ipid WHERE process.pid IN (app_pids)`.
 *
 * Raw SQL keeps `thread.name` NULL (the outer `threadInfo.threadName` applies
 * its own `or ''`). `ORDER BY t.id` makes `maxThreads` and result construction
 * deterministic; it matches HapRay's natural row order on the fixture traces.
 */
function loadAppThreads(db: QueryHandle, appPids: number[]): AppThreadRow[] {
  if (appPids.length === 0) return [];
  const placeholders = appPids.map(() => '?').join(', ');
  return db
    .query<RawAppThreadRow>(
      `SELECT t.itid, t.tid, t.name, p.pid, p.name AS process_name
FROM thread t
INNER JOIN process p ON t.ipid = p.ipid
WHERE p.pid IN (${placeholders})
ORDER BY t.id`,
      appPids,
    )
    .map((row) => ({
      itid: num(row.itid),
      tid: num(row.tid),
      name: row.name,
      pid: row.pid,
      processName: row.process_name,
    }));
}

/**
 * HapRay `_build_instant_cache` over `[rangeStart, rangeEnd]`.
 *
 * `InstantQuery.wakeups` enforces exactly HapRay's fixed predicate
 * (`sched_wakeup`/`sched_waking`, `ref_type = 'itid'`, both refs present) and
 * gives the candidate list a stable order; the BFS then sorts by timestamp
 * descending and keeps the first candidate, so equal timestamps retain that
 * order just like Python's stable `sort(..., reverse=True)`.
 */
function buildInstantCache(
  db: QueryHandle,
  range: TimeRange,
): Map<number, Array<[number, number]>> {
  const cache = new Map<number, Array<[number, number]>>();
  for (const event of new InstantQuery(db).wakeups(range)) {
    let events = cache.get(event.ref);
    if (events === undefined) {
      events = [];
      cache.set(event.ref, events);
    }
    events.push([event.wakeupFrom, event.ts]);
  }
  return cache;
}

/**
 * HapRay `frame_wakeup_chain.find_wakeup_chain`, cached branch only.
 *
 * Starting at the subject thread, walk backwards to the thread that woke it.
 * Each hop considers only cached wakeups in
 * `[frameStart - 50ms, currentTs]`; when the current thread belongs to an app
 * process and any of those wakers do too, the latest app-process waker wins,
 * otherwise the latest waker overall. One waker is enqueued per hop, so a
 * visited latest waker ends that branch (it does not fall back to an older
 * one) — exactly as in HapRay. `frame_end` is unused here because HapRay's
 * cache branch never reads it.
 */
function findWakeupChain(
  instantCache: Map<number, Array<[number, number]>>,
  appThreadItids: ReadonlySet<number>,
  startItid: number,
  frameStart: number,
  appPid: number | null,
  maxDepth: number = MAX_WAKEUP_DEPTH,
): WakeupChainEntry[] {
  const searchStart = frameStart - SEARCH_WINDOW_NS;
  const queue: Array<[number, number, number]> = [[startItid, 0, frameStart]];
  const ordered: WakeupChainEntry[] = [{ itid: startItid, depth: 0 }];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const [currentItid, depth, currentTs] = queue.shift() as [
      number,
      number,
      number,
    ];
    if (depth >= maxDepth) continue;
    if (visited.has(currentItid)) continue;
    visited.add(currentItid);

    const events = instantCache.get(currentItid);
    let chosen: [number, number] | null = null;
    if (events !== undefined) {
      const filtered = events.filter(
        ([, ts]) => searchStart <= ts && ts <= currentTs,
      );
      if (filtered.length > 0) {
        const latest = (candidates: Array<[number, number]>): [number, number] => {
          const sorted = [...candidates].sort((a, b) => b[1] - a[1]);
          return sorted[0];
        };
        // Python truthiness: pid 0 and an empty app-thread set both disable
        // the app-process preference.
        if (appPid !== null && appPid !== 0 && appThreadItids.size > 0) {
          const appWakers = filtered.filter(([waker]) =>
            appThreadItids.has(waker),
          );
          chosen = latest(appWakers.length > 0 ? appWakers : filtered);
        } else {
          chosen = latest(filtered);
        }
      }
    }

    if (chosen !== null) {
      const [rawWaker, wakeupTs] = chosen;
      const wakerItid = Math.trunc(rawWaker); // HapRay's `int(wakeup_from)`
      // HapRay checks the expanded list against `visited`, not against the
      // already-queued entries, so a duplicate depth entry can occur.
      if (wakerItid !== 0 && !visited.has(wakerItid)) {
        ordered.push({ itid: wakerItid, depth: depth + 1 });
        queue.push([wakerItid, depth + 1, wakeupTs]);
      }
    }
  }

  return ordered;
}

/**
 * HapRay's `thread_info_map` query, keyed by both `thread.id` and
 * `thread.itid`.
 *
 * Raw SQL keeps NULLs (`tid`, `name`, `pid`, `process.name`) because the
 * wakeup entry exposes them as `null`; `ThreadQuery` would collapse them to
 * `0`/`''`. Both keys are written per row, last write wins, in `t.id` order.
 */
function loadThreadInfoMap(
  db: QueryHandle,
  itids: number[],
): Map<number, ThreadInfoRow> {
  const map = new Map<number, ThreadInfoRow>();
  if (itids.length === 0) return map;
  const placeholders = itids.map(() => '?').join(', ');
  const rows = db.query<RawThreadInfoRow>(
    `SELECT t.id, t.itid, t.tid, t.name, p.pid, p.name AS process_name
FROM thread t
INNER JOIN process p ON t.ipid = p.ipid
WHERE t.itid IN (${placeholders}) OR t.id IN (${placeholders})
ORDER BY t.id`,
    [...itids, ...itids],
  );
  for (const row of rows) {
    const info: ThreadInfoRow = {
      id: row.id,
      itid: row.itid,
      tid: row.tid,
      name: row.name,
      pid: row.pid,
      processName: row.process_name,
    };
    if (row.id !== null) map.set(row.id, info);
    if (row.itid !== null) map.set(row.itid, info);
  }
  return map;
}

/**
 * HapRay `_query_thread_states_batch`.
 *
 * The predicate is HapRay's half-open overlap:
 * `ts < rangeEnd AND ts + COALESCE(dur, 0) > rangeStart`, ordered by
 * `itid, ts`. It is deliberately not `ThreadStateQuery.forItids`, whose
 * inclusive `ts >= start AND ts <= end` filter is a different predicate.
 */
function loadThreadStates(
  db: QueryHandle,
  itids: number[],
  range: TimeRange,
): Map<number, ThreadStates> {
  const map = new Map<number, ThreadStates>();
  if (itids.length === 0) return map;
  const placeholders = itids.map(() => '?').join(', ');
  const rows = db.query<{
    itid: number | null;
    ts: number | null;
    dur: number | null;
    state: string | null;
  }>(
    `SELECT itid, ts, COALESCE(dur, 0) AS dur, state
FROM thread_state
WHERE itid IN (${placeholders})
  AND ts < ?
  AND (ts + COALESCE(dur, 0)) > ?
ORDER BY itid, ts`,
    [...itids, range.endNs, range.startNs],
  );
  for (const row of rows) {
    const itid = num(row.itid);
    let states = map.get(itid);
    if (states === undefined) {
      states = [];
      map.set(itid, states);
    }
    states.push({ ts: num(row.ts), dur: num(row.dur), state: str(row.state) });
  }
  return map;
}

/**
 * HapRay `_build_tid_to_info_cache`, plus the `thread` row index used for
 * `threadInfo.startTs`/`endTs`.
 *
 * The join is reconstructed with the typed queries: processes indexed by
 * `ipid` in `id` order (last wins, matching the raw join's last-write rule) and
 * threads in `id` order. Thread/process names are only used for the system
 * classification here, where `''` and SQL NULL are interchangeable.
 */
function buildThreadIndexes(db: QueryHandle): {
  threadByItid: Map<number, ThreadInfo>;
  tidToInfo: Map<number, TidInfo>;
} {
  const processByIpid = new Map<number, ProcessInfo>();
  for (const process of new ProcessQuery(db).all()) {
    processByIpid.set(process.ipid, process);
  }
  const threadByItid = new Map<number, ThreadInfo>();
  const tidToInfo = new Map<number, TidInfo>();
  for (const thread of new ThreadQuery(db).all()) {
    threadByItid.set(thread.itid, thread);
    const process = processByIpid.get(thread.ipid);
    if (process !== undefined) {
      tidToInfo.set(thread.tid, {
        threadName: thread.name,
        processName: process.name,
      });
    }
  }
  return { threadByItid, tidToInfo };
}

/** Composite key for HapRay's `(process_id, thread_id|thread_name)` tuples. */
function perfKey(pid: number | null, value: number | string | null): string {
  return JSON.stringify([pid, value]);
}

/**
 * HapRay `_build_perf_thread_id_map`: `(process_id, thread_id) -> thread_id`,
 * `(process_id, stripped thread_name) -> thread_id`, and the set of valid
 * perf thread ids per process. `PerfQuery.threads` returns `[]` when
 * `perf_thread` is absent, so a missing table yields empty lookups.
 */
function buildPerfThreadMaps(
  db: QueryHandle,
  appPids: number[],
): PerfThreadMaps {
  const maps: PerfThreadMaps = {
    pidTidToPerfTid: new Map(),
    pidNameToPerfTid: new Map(),
    validPerfTidsByPid: new Map(),
  };
  for (const thread of new PerfQuery(db).threads(appPids)) {
    maps.pidTidToPerfTid.set(
      perfKey(thread.processId, thread.threadId),
      thread.threadId,
    );
    const name = thread.threadName.trim();
    if (name !== '') {
      maps.pidNameToPerfTid.set(perfKey(thread.processId, name), thread.threadId);
    }
    let valid = maps.validPerfTidsByPid.get(thread.processId);
    if (valid === undefined) {
      valid = new Set();
      maps.validPerfTidsByPid.set(thread.processId, valid);
    }
    valid.add(thread.threadId);
  }
  return maps;
}

/** HapRay's timestamp-column choice: `timestamp_trace`, else `timeStamp`. */
function perfTimestampColumn(db: QueryHandle): string {
  const columns = db
    .query<{ name: string }>('PRAGMA table_info(perf_sample)')
    .map((row) => String(row.name));
  return columns.includes('timestamp_trace') ? 'timestamp_trace' : 'timeStamp';
}

/**
 * HapRay `_build_perf_sample_cache`: every sample in the range, grouped by
 * `perf_sample.thread_id` and sorted by timestamp for binary search.
 *
 * HapRay loads this unconditionally (not just for the threads in a chain), so
 * the same global cache serves every app thread.
 */
function buildPerfSampleCache(
  db: QueryHandle,
  range: TimeRange,
): Map<number, Array<[number, number]>> {
  const column = perfTimestampColumn(db);
  // `column` is one of two fixed identifiers chosen above, never input.
  const rows = db.query<{
    thread_id: number | null;
    ts: number | null;
    event_count: number | null;
  }>(
    `SELECT thread_id, ${column} AS ts, event_count
FROM perf_sample
WHERE ${column} >= ? AND ${column} <= ?`,
    [range.startNs, range.endNs],
  );
  const cache = new Map<number, Array<[number, number]>>();
  for (const row of rows) {
    const threadId = num(row.thread_id);
    let samples = cache.get(threadId);
    if (samples === undefined) {
      samples = [];
      cache.set(threadId, samples);
    }
    samples.push([num(row.ts), num(row.event_count)]);
  }
  for (const samples of cache.values()) {
    samples.sort((a, b) => a[0] - b[0]);
  }
  return cache;
}

/** First index whose value is >= `target` (Python `bisect_left`). */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is > `target` (Python `bisect_right`). */
function upperBound(values: number[], target: number): number {
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
 * HapRay `calculate_thread_instructions`, cached branch.
 *
 * Sums `event_count` over each thread's samples whose timestamp falls in
 * `[rangeStart, rangeEnd]` (both ends inclusive, matching
 * `bisect_left`/`bisect_right`), drops a zero total exactly as HapRay does,
 * and splits the survivors by `is_system_thread`. No samples means both maps
 * are empty and every instruction count stays 0.
 */
function calculateThreadInstructions(
  byThread: Map<number, Array<[number, number]>>,
  tidToInfo: Map<number, TidInfo>,
  threadIds: number[],
  range: TimeRange,
): InstructionTotals {
  const app = new Map<number, number>();
  const system = new Map<number, number>();
  for (const threadId of threadIds) {
    const samples = byThread.get(threadId);
    if (samples === undefined || samples.length === 0) continue;
    const timestamps = samples.map(([ts]) => ts);
    const start = lowerBound(timestamps, range.startNs);
    const end = upperBound(timestamps, range.endNs);
    let total = 0;
    for (let i = start; i < end; i++) total += samples[i][1];
    // HapRay drops a thread whose in-range total is not positive.
    if (total > 0) {
      const info = tidToInfo.get(threadId);
      if (isSystemThread(info?.processName, info?.threadName)) {
        system.set(threadId, total);
      } else {
        app.set(threadId, total);
      }
    }
  }
  return { app, system };
}

/**
 * HapRay `map_itid_to_perf_thread_id`, cache branch.
 *
 * The cache is keyed by the app processes' `itid` only, so a chain member from
 * another process simply has no entry.
 */
function mapItidToPerfThreadId(
  itids: Iterable<number>,
  itidToTid: Map<number, number>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const itid of itids) {
    const tid = itidToTid.get(itid);
    if (tid !== undefined) map.set(itid, tid);
  }
  return map;
}

/**
 * Python's `a or b or c` for the perf-thread fallback chain: the first truthy
 * operand, or the last operand's value (which may be `undefined` or `0`).
 */
function pythonOr(values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return values[values.length - 1];
}

/**
 * HapRay `_query_callchains_batch` via `PerfQuery.callchains`.
 *
 * The typed query already implements the 50-distinct-chain-id and 20-chain
 * caps, `depth` ordering, and the exact `(file_id, serial_id)` then
 * `file_id`-only symbol lookup. It returns `[]` when `perf_callchain` or
 * `perf_files` is absent; the analyzer only calls it when `perf_sample` has
 * data. The extra `threadId`/`callchainId` fields are stripped so the public
 * payload is exactly `{ functions }`.
 */
function loadCallchains(
  db: QueryHandle,
  perfThreadIds: number[],
  range: TimeRange,
): Map<number, WakeupCallchains> {
  const byThread = new Map<number, WakeupCallchains>();
  if (perfThreadIds.length === 0) return byThread;
  for (const chain of new PerfQuery(db).callchains(
    perfThreadIds,
    range,
    MAX_RETURNED_CALLCHAINS,
  )) {
    let chains = byThread.get(chain.threadId);
    if (chains === undefined) {
      chains = [];
      byThread.set(chain.threadId, chains);
    }
    chains.push({
      functions: chain.functions.map((fn) => ({
        symbol: fn.symbol,
        name: fn.name,
        filePath: fn.filePath,
      })),
    });
  }
  return byThread;
}

/** An empty perf lookup, used when `perf_sample` has no rows. */
function emptyPerfThreadMaps(): PerfThreadMaps {
  return {
    pidTidToPerfTid: new Map(),
    pidNameToPerfTid: new Map(),
    validPerfTidsByPid: new Map(),
  };
}

/**
 * Port of HapRay `analyze_all_threads_wakeup_chain` for one trace database.
 *
 * Every app thread of `appPids` becomes one result, sorted by `threadId`.
 * `wakeupThreads` stays in HapRay's BFS order (the subject at depth 0 first).
 * The perf work is skipped entirely when `perf_sample` is absent or empty:
 * every instruction count is then 0 and every callchain list is empty, which
 * is exactly HapRay's behavior after `_check_perf_sample_has_data` returns
 * false. No index is created and nothing is written.
 *
 * `threadInfo.startTs`/`endTs` come from the `thread` row; the query layer's
 * `0`-means-absent convention is turned back into `null` so a missing value is
 * never exported as a trace-origin timestamp.
 */
export function analyzeThreadWakeup(
  db: QueryHandle,
  opts: { appPids: number[]; timeRange?: TimeRange; maxThreads?: number },
): ThreadWakeupResult[] {
  const appPids = opts.appPids;
  if (appPids.length === 0) return [];

  const range = resolveTimeRange(db, opts.timeRange);
  const appThreads = loadAppThreads(db, appPids);
  const selected =
    opts.maxThreads !== undefined && opts.maxThreads > 0
      ? appThreads.slice(0, opts.maxThreads)
      : appThreads;
  if (selected.length === 0) return [];

  const itidToTid = new Map<number, number>();
  const appThreadsByPid = new Map<number, Set<number>>();
  for (const thread of appThreads) {
    itidToTid.set(thread.itid, thread.tid);
    if (thread.pid !== null) {
      let itids = appThreadsByPid.get(thread.pid);
      if (itids === undefined) {
        itids = new Set();
        appThreadsByPid.set(thread.pid, itids);
      }
      itids.add(thread.itid);
    }
  }

  const perf = new PerfQuery(db);
  const perfEnabled = perf.hasSamples();
  const perfThreadMaps = perfEnabled
    ? buildPerfThreadMaps(db, appPids)
    : emptyPerfThreadMaps();
  const perfSampleCache = perfEnabled
    ? buildPerfSampleCache(db, range)
    : new Map<number, Array<[number, number]>>();
  const { threadByItid, tidToInfo } = buildThreadIndexes(db);
  const instantCache = buildInstantCache(db, range);

  const results: ThreadWakeupResult[] = [];
  for (const appThread of selected) {
    const appThreadItids =
      appThread.pid === null
        ? new Set<number>()
        : (appThreadsByPid.get(appThread.pid) ?? new Set<number>());
    const chain = findWakeupChain(
      instantCache,
      appThreadItids,
      appThread.itid,
      range.startNs,
      appThread.pid,
    );
    const relatedItids = [...new Set(chain.map((entry) => entry.itid))];

    const itidToPerf = perfEnabled
      ? mapItidToPerfThreadId(relatedItids, itidToTid)
      : new Map<number, number>();
    const perfThreadIds = [...new Set(itidToPerf.values())];
    const instructions =
      perfEnabled && perfThreadIds.length > 0
        ? calculateThreadInstructions(
            perfSampleCache,
            tidToInfo,
            perfThreadIds,
            range,
          )
        : {
            app: new Map<number, number>(),
            system: new Map<number, number>(),
          };

    const threadInstructions = new Map<number, number>();
    for (const { itid } of chain) {
      const perfTid = itidToPerf.get(itid);
      if (perfTid !== undefined) {
        // HapRay's `app.get(ptid, 0) or sys.get(ptid, 0)`: a zero app total
        // falls through to the system map, then to 0.
        threadInstructions.set(
          itid,
          instructions.app.get(perfTid) || instructions.system.get(perfTid) || 0,
        );
      }
    }
    const totalInstructions = threadInstructions.get(appThread.itid) ?? 0;

    const infoMap = loadThreadInfoMap(db, relatedItids);
    const statesByItid = loadThreadStates(db, relatedItids, range);

    const itidToPerfSampleTid = new Map<number, number>();
    for (const { itid } of chain) {
      const info = infoMap.get(itid);
      if (info === undefined) continue;
      const name = (info.name ?? '').trim();
      // HapRay's fallback order: exact (pid, tid), (pid, stripped name), the
      // itid->tid cache, then the tid itself when it is a known perf thread of
      // that process. Each step uses Python `or` truthiness.
      const perfTid = pythonOr([
        perfThreadMaps.pidTidToPerfTid.get(perfKey(info.pid, info.tid)),
        perfThreadMaps.pidNameToPerfTid.get(perfKey(info.pid, name)),
        itidToPerf.get(itid),
        info.pid !== null &&
        info.tid !== null &&
        (perfThreadMaps.validPerfTidsByPid.get(info.pid)?.has(info.tid) ?? false)
          ? info.tid
          : undefined,
      ]);
      if (perfTid !== undefined) itidToPerfSampleTid.set(itid, perfTid);
    }

    const callchainTids = chain
      .map((entry) => itidToPerfSampleTid.get(entry.itid))
      .filter((tid): tid is number => tid !== undefined);
    const callchainsByTid =
      perfEnabled && callchainTids.length > 0
        ? loadCallchains(db, callchainTids, range)
        : new Map<number, WakeupCallchains>();

    const wakeupThreads: ThreadWakeupThread[] = [];
    for (const { itid, depth } of chain) {
      const info = infoMap.get(itid);
      if (info === undefined) continue;
      const perfTid = itidToPerf.get(itid);
      const instructionCount = perfTid
        ? threadInstructions.get(itid) ?? 0
        : 0;
      const perfSampleTid = itidToPerfSampleTid.get(itid);
      wakeupThreads.push({
        itid,
        tid: info.tid,
        threadName: info.name,
        pid: info.pid,
        processName: info.processName,
        instructionCount,
        isSystemThread: isSystemThread(info.processName, info.name),
        wakeupDepth: depth,
        threadStates: statesByItid.get(itid) ?? [],
        callchains:
          perfSampleTid === undefined
            ? []
            : callchainsByTid.get(perfSampleTid) ?? [],
      });
    }

    const row = threadByItid.get(appThread.itid);
    results.push({
      threadId: appThread.tid,
      threadInfo: {
        threadName: appThread.name ?? '',
        startTs: row === undefined || row.startTs === 0 ? null : row.startTs,
        endTs: row === undefined || row.endTs === 0 ? null : row.endTs,
      },
      totalInstructions,
      wakeupThreads,
    });
  }

  results.sort((a, b) => a.threadId - b.threadId);
  return results;
}
