import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One `process_measure` observation, joined to its filter.
 *
 * `tsNs`/`durNs` are not the stored values: `process_measure` stores
 * **microseconds** since boot, and the query multiplies them by 1000 so every
 * consumer works in the trace database's nanosecond clock. Comparing the raw
 * stored value against a trace `ts` would put every row outside the window.
 */
export interface ProcessMeasure {
  tsNs: number;
  durNs: number;
  filterId: number;
  /** Filter name, e.g. `mem.rss`; `''` means the join found no filter. */
  name: string;
  /** Process id the filter was recorded for. */
  ipid: number;
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

/** `process_measure` timestamps are microseconds; trace `ts` values are ns. */
const NS_PER_US = 1000;

const SELECT_MEASURES = `SELECT m.ts, m.dur, m.filter_id, m.value, f.name, f.ipid
FROM process_measure m
JOIN process_measure_filter f ON f.id = m.filter_id`;

const SELECT_FILTERS = 'SELECT id, name, ipid FROM process_measure_filter ORDER BY id';

/**
 * The single µs → ns boundary: every timestamp conversion in this class goes
 * through {@link toProcessMeasure}, and range filtering compares the converted
 * value (never the raw column) against the caller's nanosecond bounds.
 */
function toProcessMeasure(row: ProcessMeasureRow): ProcessMeasure {
  return {
    tsNs: num(row.ts) * NS_PER_US,
    durNs: num(row.dur) * NS_PER_US,
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
   * Measures whose filter `ipid` is one of `pids`.
   *
   * An empty `pids` returns `[]` without issuing `IN ()`.
   */
  forPids(pids: number[], range?: TimeRange): ProcessMeasure[] {
    if (pids.length === 0) return [];
    const placeholders = pids.map(() => '?').join(', ');
    return this.select(` WHERE f.ipid IN (${placeholders})`, pids, range);
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
    // The bound is ns and tsNs is the converted value; comparing the raw µs
    // column would include rows a thousand-fold outside the requested window.
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
