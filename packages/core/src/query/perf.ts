// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/** One `perf_thread` row; `threadId` joins `perf_sample.thread_id`. */
export interface PerfThread {
  id: number;
  threadId: number;
  processId: number;
  threadName: string;
}

/**
 * One `perf_sample` row with camelCase field names.
 *
 * `timestampTrace` is the trace-relative nanosecond timestamp and is the
 * column ranges are applied to (matching HapRay's preferred timestamp column).
 * `timeStamp` is kept as a separate field for callers that need the raw perf
 * timestamp.
 */
export interface PerfSampleRow {
  id: number;
  callchainId: number;
  timeStamp: number;
  threadId: number;
  eventCount: number;
  eventTypeId: number;
  timestampTrace: number;
  cpuId: number;
  threadState: string;
}

/** One resolved frame of a perf callchain. */
export interface PerfFunction {
  symbol: string;
  name: string;
  filePath: string;
}

/** A callchain for one perf thread, frames ordered by `depth`. */
export interface PerfCallchain {
  threadId: number;
  callchainId: number;
  functions: PerfFunction[];
}

interface PerfThreadRow {
  id: number | null;
  thread_id: number | null;
  process_id: number | null;
  thread_name: string | null;
}

interface PerfSampleRowDb {
  id: number | null;
  callchain_id: number | null;
  timeStamp: number | null;
  thread_id: number | null;
  event_count: number | null;
  event_type_id: number | null;
  timestamp_trace: number | null;
  cpu_id: number | null;
  thread_state: string | null;
}

interface PerfChainIdRow {
  thread_id: number | null;
  callchain_id: number | null;
}

interface PerfFrameRow {
  callchain_id: number | null;
  depth: number | null;
  file_id: number | null;
  symbol_id: number | null;
  name: string | null;
}

interface PerfFileRow {
  id: number | null;
  file_id: number | null;
  serial_id: number | null;
  symbol: string | null;
  path: string | null;
}

/** HapRay's cap on distinct chain ids collected per thread. */
const MAX_CHAIN_IDS_PER_THREAD = 50;
/** HapRay's cap on callchains returned per thread. */
const DEFAULT_CHAINS_PER_THREAD = 20;

const SELECT_PERF_THREADS = `SELECT id, thread_id, process_id, thread_name
FROM perf_thread`;

const SELECT_PERF_SAMPLES = `SELECT id, callchain_id, timeStamp, thread_id,
       event_count, event_type_id, timestamp_trace, cpu_id, thread_state
FROM perf_sample`;

function toPerfThread(row: PerfThreadRow): PerfThread {
  return {
    id: num(row.id),
    threadId: num(row.thread_id),
    processId: num(row.process_id),
    threadName: str(row.thread_name),
  };
}

function toPerfSample(row: PerfSampleRowDb): PerfSampleRow {
  return {
    id: num(row.id),
    callchainId: num(row.callchain_id),
    timeStamp: num(row.timeStamp),
    threadId: num(row.thread_id),
    eventCount: num(row.event_count),
    eventTypeId: num(row.event_type_id),
    timestampTrace: num(row.timestamp_trace),
    cpuId: num(row.cpu_id),
    threadState: str(row.thread_state),
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Typed accessor over the optional `perf_*` tables.
 *
 * These tables exist only when a perf trace was ingested; every accessor
 * therefore checks `hasTable()` first and returns `[]`/`false` instead of
 * letting SQLite throw `no such table`. The query layer is read-only and never
 * creates the indexes HapRay's `ensure_perf_trace_indexes` would add.
 */
export class PerfQuery {
  constructor(private readonly db: QueryHandle) {}

  /** True when `perf_sample` exists and contains at least one row. */
  hasSamples(): boolean {
    if (!this.hasTable('perf_sample')) return false;
    return this.db.query<{ n: number }>('SELECT 1 AS n FROM perf_sample LIMIT 1').length > 0;
  }

  /**
   * `perf_thread` rows whose `process_id` is one of `pids`, ordered by `id`.
   *
   * `process_id` is the process pid, not an ipid. An empty `pids` or an absent
   * table returns `[]`.
   */
  threads(pids: number[]): PerfThread[] {
    if (pids.length === 0 || !this.hasTable('perf_thread')) return [];
    return this.db
      .query<PerfThreadRow>(
        `${SELECT_PERF_THREADS} WHERE process_id IN (${placeholders(pids.length)}) ORDER BY id`,
        pids,
      )
      .map(toPerfThread);
  }

  /**
   * Samples of `threadIds` whose `timestamp_trace` is in `[startNs, endNs]`.
   *
   * Rows are ordered by `timestamp_trace, id`. An empty `threadIds` or an
   * absent `perf_sample` returns `[]`.
   */
  samples(threadIds: number[], range: TimeRange): PerfSampleRow[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
    return this.db
      .query<PerfSampleRowDb>(
        `${SELECT_PERF_SAMPLES}
WHERE thread_id IN (${placeholders(threadIds.length)})
  AND timestamp_trace >= ? AND timestamp_trace <= ?
ORDER BY timestamp_trace, id`,
        [...threadIds, range.startNs, range.endNs],
      )
      .map(toPerfSample);
  }

  /**
   * Callchains of `threadIds` inside `[startNs, endNs]`.
   *
   * Mirrors HapRay's `_query_callchains_batch`: per thread at most the first
   * 50 distinct `callchain_id`s (in chain-id order) are considered and at most
   * `maxChainsPerThread` (default 20) non-empty chains are returned. Frames
   * are ordered by `depth`; symbols resolve through `perf_files` by the exact
   * `(file_id, serial_id)` pair first and by `file_id` alone as the fallback.
   * A frame keeps its raw `perf_callchain.name` and an empty path when neither
   * lookup matches.
   *
   * If `perf_callchain` or `perf_files` is absent there is nothing to return,
   * so the result is `[]` (HapRay does the same).
   */
  callchains(
    threadIds: number[],
    range: TimeRange,
    maxChainsPerThread = DEFAULT_CHAINS_PER_THREAD,
  ): PerfCallchain[] {
    if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];

    const uniqueThreadIds = [...new Set(threadIds)];
    const chainRows = this.db.query<PerfChainIdRow>(
      `SELECT thread_id, callchain_id
FROM perf_sample
WHERE thread_id IN (${placeholders(uniqueThreadIds.length)})
  AND timestamp_trace >= ? AND timestamp_trace <= ?
  AND callchain_id IS NOT NULL
ORDER BY thread_id, callchain_id`,
      [...uniqueThreadIds, range.startNs, range.endNs],
    );

    const chainIdsByThread = new Map<number, number[]>();
    for (const threadId of uniqueThreadIds) chainIdsByThread.set(threadId, []);
    for (const row of chainRows) {
      const list = chainIdsByThread.get(num(row.thread_id));
      const callchainId = num(row.callchain_id);
      if (!list || list.length >= MAX_CHAIN_IDS_PER_THREAD) continue;
      if (!list.includes(callchainId)) list.push(callchainId);
    }

    const allChainIds = [
      ...new Set(uniqueThreadIds.flatMap((id) => chainIdsByThread.get(id) ?? [])),
    ].sort((a, b) => a - b);
    if (allChainIds.length === 0) return [];
    if (!this.hasTable('perf_callchain') || !this.hasTable('perf_files')) return [];

    const frames = this.db.query<PerfFrameRow>(
      `SELECT callchain_id, depth, file_id, symbol_id, name
FROM perf_callchain
WHERE callchain_id IN (${placeholders(allChainIds.length)})
ORDER BY callchain_id, depth, id`,
      allChainIds,
    );
    const framesByChain = new Map<number, PerfFrameRow[]>();
    for (const frame of frames) {
      const list = framesByChain.get(num(frame.callchain_id));
      if (list) list.push(frame);
      else framesByChain.set(num(frame.callchain_id), [frame]);
    }

    const fileIds = [
      ...new Set(
        frames
          .filter((frame) => frame.file_id != null)
          .map((frame) => num(frame.file_id)),
      ),
    ].sort((a, b) => a - b);
    const files = fileIds.length
      ? this.db.query<PerfFileRow>(
          `SELECT id, file_id, serial_id, symbol, path
FROM perf_files
WHERE file_id IN (${placeholders(fileIds.length)})
ORDER BY id`,
          fileIds,
        )
      : [];

    const exactSymbols = new Map<string, PerfFunction>();
    const fileSymbols = new Map<number, PerfFunction>();
    for (const file of files) {
      const resolved: PerfFunction = {
        symbol: str(file.symbol).trim(),
        name: str(file.symbol).trim(),
        filePath: str(file.path).trim(),
      };
      const fileId = num(file.file_id);
      if (!fileSymbols.has(fileId)) fileSymbols.set(fileId, resolved);
      const key = `${fileId}:${num(file.serial_id)}`;
      if (!exactSymbols.has(key)) exactSymbols.set(key, resolved);
    }

    const chains: PerfCallchain[] = [];
    const limit = Math.max(0, maxChainsPerThread);
    for (const threadId of uniqueThreadIds) {
      const chainIds = (chainIdsByThread.get(threadId) ?? []).slice(0, limit);
      for (const callchainId of chainIds) {
        const chainFrames = framesByChain.get(callchainId) ?? [];
        if (chainFrames.length === 0) continue;
        const functions: PerfFunction[] = [];
        for (const frame of chainFrames) {
          const rawSymbol = str(frame.name).trim();
          let functionName = rawSymbol;
          let filePath = '';
          if (frame.file_id != null && frame.symbol_id != null) {
            const resolved =
              exactSymbols.get(`${num(frame.file_id)}:${num(frame.symbol_id)}`) ??
              fileSymbols.get(num(frame.file_id));
            if (resolved) {
              functionName = resolved.symbol;
              filePath = resolved.filePath;
            }
          }
          functions.push({ symbol: functionName, name: functionName, filePath });
        }
        chains.push({ threadId, callchainId, functions });
      }
    }
    return chains;
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
