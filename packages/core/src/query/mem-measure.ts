import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One `process_measure` observation, joined to its filter.
 *
 * `tsNs`/`durNs` are the stored values unchanged: measured on the Mate 60,
 * `trace_range.start_ts` equals `MIN(process_measure.ts)` exactly and a 3 s
 * capture spans ~2.0e9, so this table is already in the trace's nanosecond
 * clock. The names carry the unit so consumers never have to guess.
 *
 * `value` is the filter's raw measured value. For the `mem.*` filters the
 * unit is **KiB**, not bytes: measured against `/proc/<pid>/status`, a
 * `mem.rss` row of 664420 matched `VmRSS: 664584 kB` and `mem.vm.size`
 * 106161468 matched `VmSize: 106161468 kB` exactly. Converting to bytes is
 * the analyzer's job, because only it knows which filter it read.
 */
export interface ProcessMeasure {
  tsNs: number;
  durNs: number;
  filterId: number;
  /** Filter name, e.g. `mem.rss`; `''` means the join found no filter. */
  name: string;
  /** Process id the filter was recorded for. */
  ipid: number;
  /** Raw filter value; `mem.*` values are KiB (see the interface note). */
  value: number;
}

/** One `process_measure_filter` row. */
export interface ProcessMeasureFilter {
  id: number;
  name: string;
  ipid: number;
}

interface ProcessMeasureRow {
  ts: number | null;
  dur: number | null;
  filter_id: number | null;
  value: number | null;
  name: string | null;
  ipid: number | null;
}

interface FilterRow {
  id: number | null;
  name: string | null;
  ipid: number | null;
}

const SELECT_MEASURES = `SELECT m.ts, m.dur, m.filter_id, m.value, f.name, f.ipid
FROM process_measure m
JOIN process_measure_filter f ON f.id = m.filter_id`;

const SELECT_FILTERS = 'SELECT id, name, ipid FROM process_measure_filter ORDER BY id';

/**
 * The single row → interface boundary. Timestamps are copied unchanged: the
 * table shares the trace's nanosecond clock (measured), so no scaling belongs
 * in the query layer at all.
 */
function toProcessMeasure(row: ProcessMeasureRow): ProcessMeasure {
  return {
    tsNs: num(row.ts),
    durNs: num(row.dur),
    filterId: num(row.filter_id),
    name: str(row.name),
    ipid: num(row.ipid),
    value: num(row.value),
  };
}

function toFilter(row: FilterRow): ProcessMeasureFilter {
  return { id: num(row.id), name: str(row.name), ipid: num(row.ipid) };
}

/**
 * Typed accessor over the memory-plugin tables.
 *
 * These tables exist only when a capture ran `memory-plugin` with
 * `report_process_tree` and `report_sysmem`; an ftrace-only scene has neither,
 * and every method then returns `[]` instead of letting SQLite throw
 * `no such table`. Rows are ordered by `ts, filter_id` (with `value` as a final
 * tie-break) so equal timestamps stay deterministic (D5).
 */
export class MemMeasureQuery {
  constructor(private readonly db: QueryHandle) {}

  /** True when both tables the joined query needs are present. */
  hasTable(): boolean {
    return this.has('process_measure') && this.has('process_measure_filter');
  }

  /** Every measure in `[startNs, endNs]` (or the whole trace). */
  all(range?: TimeRange): ProcessMeasure[] {
    return this.select('', [], range);
  }

  /**
   * Measures whose filter `ipid` is one of `ipids`.
   *
   * **The argument is an `ipid`, not a `pid`.** `process_measure_filter.ipid`
   * is the trace database's internal process id: measured on the Mate 60,
   * sceneboard has `ipid=117` and `pid=6500`, so passing a pid would silently
   * return another process's rows (or none). `ProcessQuery.byPid` is the safe
   * pid→ipid step. An empty `ipids` returns `[]` without issuing `IN ()`.
   */
  forIpids(ipids: number[], range?: TimeRange): ProcessMeasure[] {
    if (ipids.length === 0) return [];
    const placeholders = ipids.map(() => '?').join(', ');
    return this.select(` WHERE f.ipid IN (${placeholders})`, ipids, range);
  }

  /** Every filter row, ordered by `id`. */
  filters(): ProcessMeasureFilter[] {
    if (!this.has('process_measure_filter')) return [];
    return this.db.query<FilterRow>(SELECT_FILTERS).map(toFilter);
  }

  private select(where: string, params: unknown[], range?: TimeRange): ProcessMeasure[] {
    if (!this.hasTable()) return [];
    const rows = this.db
      .query<ProcessMeasureRow>(
        `${SELECT_MEASURES}${where} ORDER BY m.ts, m.filter_id, m.value`,
        params,
      )
      .map(toProcessMeasure);
    if (range === undefined) return rows;
    return rows.filter((row) => row.tsNs >= range.startNs && row.tsNs <= range.endNs);
  }

  private has(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
