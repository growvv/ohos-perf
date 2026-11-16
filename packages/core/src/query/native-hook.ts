// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One `native_hook` row with camelCase field names.
 *
 * `event_type` is alloc for `'AllocEvent'`/`'MmapEvent'`/`0`, free for
 * `'FreeEvent'`/`'MunmapEvent'`/`1`, and anything else is neither. `null` means
 * the column itself was NULL, which is not an allocation: the direction is
 * unknown, so it stays `null` and the pairing layer counts it as `other`.
 * `heapSize` is a magnitude: the stored sign carries no meaning, the pairing
 * layer applies the direction. `allHeapSize` and `currentSizeDur` are read for
 * callers but are never interpreted — their semantics are undocumented upstream.
 */
export interface NativeHookEvent {
  id: number;
  callchainId: number;
  ipid: number;
  /** `process.pid` resolved through `ipid`; the number space an app is known by. */
  pid: number;
  itid: number;
  eventType: number | string | null;
  subTypeId: number;
  startTs: number;
  endTs: number;
  dur: number;
  /** Heap address; `0` means the column was NULL, so the block cannot be freed. */
  addr: number;
  heapSize: number;
  allHeapSize: number;
  currentSizeDur: number;
  lastLibId: number;
  lastSymbolId: number;
}

/** One frame of a native callchain, ordered by `depth`. */
export interface NativeHookFrame {
  id: number;
  callchainId: number;
  depth: number;
  ip: number;
  symbolId: number;
  fileId: number;
  offset: number;
  symbolOffset: number;
  vaddr: number;
}

/**
 * One `native_hook_statistic` row: a pre-aggregated alloc/free pair per
 * callchain, with no per-allocation timestamp, thread or address.
 */
export interface NativeHookStatistic {
  id: number;
  callchainId: number;
  ipid: number;
  ts: number;
  type: number | string;
  subTypeId: number;
  applyCount: number;
  releaseCount: number;
  applySize: number;
  releaseSize: number;
  lastLibId: number;
  lastSymbolId: number;
}

interface NativeHookEventRow {
  id: number | null;
  callchain_id: number | null;
  ipid: number | null;
  pid: number | null;
  itid: number | null;
  event_type: number | string | null;
  sub_type_id: number | null;
  start_ts: number | null;
  end_ts: number | null;
  dur: number | null;
  addr: number | null;
  heap_size: number | null;
  all_heap_size: number | null;
  current_size_dur: number | null;
  last_lib_id: number | null;
  last_symbol_id: number | null;
}

interface NativeHookFrameRow {
  id: number | null;
  callchain_id: number | null;
  depth: number | null;
  ip: number | null;
  symbol_id: number | null;
  file_id: number | null;
  offset: number | null;
  symbol_offset: number | null;
  vaddr: number | null;
}

interface NativeHookStatisticRow {
  id: number | null;
  callchain_id: number | null;
  ipid: number | null;
  ts: number | null;
  type: number | string | null;
  sub_type_id: number | null;
  apply_count: number | null;
  release_count: number | null;
  apply_size: number | null;
  release_size: number | null;
  last_lib_id: number | null;
  last_symbol_id: number | null;
}

/**
 * SQLite's bound-variable limit is 32 766; upstream chunks `data_dict` lookups
 * at 500 for the same reason. Chunking keeps a real capture (tens of thousands
 * of callchains) from aborting the analyzer with `too many SQL variables`.
 */
const ID_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += ID_CHUNK) {
    out.push(values.slice(index, index + ID_CHUNK));
  }
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function toEvent(row: NativeHookEventRow): NativeHookEvent {
  return {
    id: num(row.id),
    callchainId: num(row.callchain_id),
    ipid: num(row.ipid),
    pid: num(row.pid),
    itid: num(row.itid),
    // `?? 0` would turn an absent type into an allocation and inflate the
    // total; an unknown direction is `other`, and `null` is how that travels.
    eventType: row.event_type ?? null,
    subTypeId: num(row.sub_type_id),
    startTs: num(row.start_ts),
    endTs: num(row.end_ts),
    dur: num(row.dur),
    addr: num(row.addr),
    heapSize: num(row.heap_size),
    allHeapSize: num(row.all_heap_size),
    currentSizeDur: num(row.current_size_dur),
    lastLibId: num(row.last_lib_id),
    lastSymbolId: num(row.last_symbol_id),
  };
}

function toFrame(row: NativeHookFrameRow): NativeHookFrame {
  return {
    id: num(row.id),
    callchainId: num(row.callchain_id),
    depth: num(row.depth),
    ip: num(row.ip),
    symbolId: num(row.symbol_id),
    fileId: num(row.file_id),
    offset: num(row.offset),
    symbolOffset: num(row.symbol_offset),
    vaddr: num(row.vaddr),
  };
}

function toStatistic(row: NativeHookStatisticRow): NativeHookStatistic {
  return {
    id: num(row.id),
    callchainId: num(row.callchain_id),
    ipid: num(row.ipid),
    ts: num(row.ts),
    type: row.type ?? 0,
    subTypeId: num(row.sub_type_id),
    applyCount: num(row.apply_count),
    releaseCount: num(row.release_count),
    applySize: num(row.apply_size),
    releaseSize: num(row.release_size),
    lastLibId: num(row.last_lib_id),
    lastSymbolId: num(row.last_symbol_id),
  };
}

/**
 * Typed, batched access to the `native_hook*` tables.
 *
 * The tables exist only when a capture ran `hiprofiler` with the `nativehook`
 * plugin, so every accessor checks `sqlite_master` first and returns
 * `[]`/`false`/an empty map instead of letting SQLite throw `no such table`.
 * That is what lets the analyzer report a degraded proxy with a reason rather
 * than crash on a plain hitrace capture.
 *
 * `events` joins `process` on `ipid` and filters on `process.pid`, which is the
 * same number space the rest of the package resolves an app to.
 */
export class NativeHookQuery {
  constructor(private readonly db: QueryHandle) {}

  /** True when `native_hook` exists and holds at least one row. */
  hasData(): boolean {
    if (!this.hasTable('native_hook')) return false;
    return this.db.query<{ n: number }>('SELECT 1 AS n FROM native_hook LIMIT 1').length > 0;
  }

  /** True when `native_hook_statistic` exists and holds at least one row. */
  hasStatistics(): boolean {
    if (!this.hasTable('native_hook_statistic')) return false;
    return this.db.query<{ n: number }>(
      'SELECT 1 AS n FROM native_hook_statistic LIMIT 1',
    ).length > 0;
  }

  /**
   * App events ordered by `(start_ts, id)`, optionally inside an inclusive
   * `range` on `start_ts`.
   *
   * The `(start_ts, id)` tie-break is ours; upstream orders by timestamp alone,
   * which makes a capture with equal timestamps depend on row order.
   *
   * `DISTINCT` on the event columns collapses the duplicate rows a repeated
   * `process.ipid` would produce: a merged trace can carry two `process` rows
   * with the same ipid, and a plain join then returns each event once per row,
   * doubling every byte. `p.pid` is selected from the same ipid group, so the
   * duplicate rows are identical.
   */
  events(pids: readonly number[], range?: TimeRange): NativeHookEvent[] {
    if (pids.length === 0 || !this.hasTable('native_hook')) return [];
    // The join is unguarded SQL, so a trace with `native_hook` but no
    // `process` table must degrade here rather than throw `no such table`.
    if (!this.hasTable('process')) return [];
    const conditions = [`p.pid IN (${placeholders(pids.length)})`];
    const params: unknown[] = [...pids];
    if (range !== undefined) {
      conditions.push('nh.start_ts >= ? AND nh.start_ts <= ?');
      params.push(range.startNs, range.endNs);
    }
    return this.db
      .query<NativeHookEventRow>(
        `SELECT DISTINCT nh.id, nh.callchain_id, nh.ipid, p.pid AS pid, nh.itid,
       nh.event_type, nh.sub_type_id, nh.start_ts, nh.end_ts, nh.dur, nh.addr,
       nh.heap_size, nh.all_heap_size, nh.current_size_dur, nh.last_lib_id,
       nh.last_symbol_id
FROM native_hook nh
JOIN process p ON nh.ipid = p.ipid
WHERE ${conditions.join(' AND ')}
ORDER BY nh.start_ts, nh.id`,
        params,
      )
      .map(toEvent);
  }

  /** Frames of `callchainIds`, ordered by `(callchain_id, depth, id)`. */
  frames(callchainIds: readonly number[]): Map<number, NativeHookFrame[]> {
    const grouped = new Map<number, NativeHookFrame[]>();
    if (callchainIds.length === 0 || !this.hasTable('native_hook_frame')) return grouped;
    const unique = [...new Set(callchainIds)];
    for (const chunk of chunks(unique)) {
      const rows = this.db
        .query<NativeHookFrameRow>(
          `SELECT id, callchain_id, depth, ip, symbol_id, file_id, offset,
       symbol_offset, vaddr
FROM native_hook_frame
WHERE callchain_id IN (${placeholders(chunk.length)})
ORDER BY callchain_id, depth, id`,
          chunk,
        )
        .map(toFrame);
      for (const row of rows) {
        const list = grouped.get(row.callchainId);
        if (list === undefined) grouped.set(row.callchainId, [row]);
        else list.push(row);
      }
    }
    return grouped;
  }

  /**
   * Statistics rows for the app, ordered by `(ts, id)`.
   *
   * `DISTINCT` and the `process` guard mirror {@link events} for the same two
   * reasons: a repeated ipid must not multiply rows, and a missing join table
   * must degrade rather than throw.
   */
  statistics(pids: readonly number[]): NativeHookStatistic[] {
    if (pids.length === 0 || !this.hasTable('native_hook_statistic')) return [];
    if (!this.hasTable('process')) return [];
    return this.db
      .query<NativeHookStatisticRow>(
        `SELECT DISTINCT s.id, s.callchain_id, s.ipid, s.ts, s.type, s.sub_type_id,
       s.apply_count, s.release_count, s.apply_size, s.release_size,
       s.last_lib_id, s.last_symbol_id
FROM native_hook_statistic s
JOIN process p ON s.ipid = p.ipid
WHERE p.pid IN (${placeholders(pids.length)})
ORDER BY s.ts, s.id`,
        [...pids],
      )
      .map(toStatistic);
  }

  /** `data_dict` text for `ids`; ids absent from the table are simply missing. */
  dataDict(ids: readonly number[]): Map<number, string> {
    const resolved = new Map<number, string>();
    if (ids.length === 0 || !this.hasTable('data_dict')) return resolved;
    const unique = [...new Set(ids)];
    for (const chunk of chunks(unique)) {
      const rows = this.db.query<{ id: number | null; data: string | null }>(
        `SELECT id, data FROM data_dict WHERE id IN (${placeholders(chunk.length)}) ORDER BY id`,
        chunk,
      );
      for (const row of rows) resolved.set(num(row.id), str(row.data));
    }
    return resolved;
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
