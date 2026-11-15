import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One row of `sched_slice` with camelCase field names.
 *
 * `ts`, `dur` and `tsEnd` are nanoseconds. Null numerics become `0` and null
 * text becomes `''` through `num`/`str`; `0` therefore means absent.
 */
export interface SchedSlice {
  id: number;
  ts: number;
  dur: number;
  tsEnd: number;
  cpu: number;
  itid: number;
  ipid: number;
  endState: string;
  priority: number;
  argSetid: number;
}

/**
 * One wakeup row of `instant` with camelCase field names.
 *
 * `InstantQuery.wakeups()` keeps only `sched_wakeup`/`sched_waking` rows whose
 * `ref_type` is `itid` and whose `ref` and `wakeup_from` are both present, so
 * those two fields are non-null in practice; they are still normalised to `0`
 * like every other numeric column. `instant` has no `id` column.
 */
export interface WakeupEvent {
  ts: number;
  name: string;
  ref: number;
  wakeupFrom: number;
  refType: string;
  value: number;
}

interface SchedRow {
  id: number | null;
  ts: number | null;
  dur: number | null;
  ts_end: number | null;
  cpu: number | null;
  itid: number | null;
  ipid: number | null;
  end_state: string | null;
  priority: number | null;
  arg_setid: number | null;
}

interface InstantRow {
  ts: number | null;
  name: string | null;
  ref: number | null;
  wakeup_from: number | null;
  ref_type: string | null;
  value: number | null;
}

const SELECT_SCHED = `SELECT id, ts, dur, ts_end, cpu, itid, ipid, end_state,
       priority, arg_setid
FROM sched_slice`;

const SELECT_INSTANT = `SELECT ts, name, ref, wakeup_from, ref_type, value
FROM instant`;

function toSchedSlice(row: SchedRow): SchedSlice {
  return {
    id: num(row.id),
    ts: num(row.ts),
    dur: num(row.dur),
    tsEnd: num(row.ts_end),
    cpu: num(row.cpu),
    itid: num(row.itid),
    ipid: num(row.ipid),
    endState: str(row.end_state),
    priority: num(row.priority),
    argSetid: num(row.arg_setid),
  };
}

function toWakeupEvent(row: InstantRow): WakeupEvent {
  return {
    ts: num(row.ts),
    name: str(row.name),
    ref: num(row.ref),
    wakeupFrom: num(row.wakeup_from),
    refType: str(row.ref_type),
    value: num(row.value),
  };
}

/**
 * Typed accessor over `sched_slice`.
 *
 * Ordering is always `ts, id` so equal timestamps keep a stable, documented
 * order. Time ranges are inclusive at both ends. `sched_slice` is a core
 * trace_streamer table, so no `hasTable()` guard is used.
 */
export class SchedQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All slices in `[startNs, endNs]` (or the whole trace), ordered by `ts, id`. */
  all(range?: TimeRange): SchedSlice[] {
    const sql = range
      ? `${SELECT_SCHED} WHERE ts >= ? AND ts <= ? ORDER BY ts, id`
      : `${SELECT_SCHED} ORDER BY ts, id`;
    const params = range ? [range.startNs, range.endNs] : [];
    return this.db.query<SchedRow>(sql, params).map(toSchedSlice);
  }

  /**
   * Slices belonging to any of `itids`, ordered by `ts, id`.
   *
   * An empty `itids` returns `[]` without issuing `IN ()`, which SQLite
   * rejects.
   */
  forItids(itids: number[], range?: TimeRange): SchedSlice[] {
    if (itids.length === 0) return [];
    const placeholders = itids.map(() => '?').join(', ');
    const where = [`itid IN (${placeholders})`];
    const params: unknown[] = [...itids];
    if (range) {
      where.push('ts >= ?', 'ts <= ?');
      params.push(range.startNs, range.endNs);
    }
    return this.db
      .query<SchedRow>(`${SELECT_SCHED} WHERE ${where.join(' AND ')} ORDER BY ts, id`, params)
      .map(toSchedSlice);
  }
}

/**
 * Typed accessor over `instant`, limited to scheduler wakeup events.
 *
 * The predicate is fixed: `sched_wakeup`/`sched_waking`, `ref_type = 'itid'`,
 * and both `ref` and `wakeup_from` present. `instant` has no `id` column, so
 * the stable ordering is `ts, ref, wakeup_from`.
 */
export class InstantQuery {
  constructor(private readonly db: QueryHandle) {}

  /**
   * Wakeup events whose `ts` is in `[startNs, endNs]`, ordered by
   * `ts, ref, wakeup_from`.
   */
  wakeups(range: TimeRange): WakeupEvent[] {
    return this.db
      .query<InstantRow>(
        `${SELECT_INSTANT}
WHERE name IN ('sched_wakeup', 'sched_waking')
  AND ref_type = 'itid'
  AND wakeup_from IS NOT NULL
  AND ref IS NOT NULL
  AND ts >= ? AND ts <= ?
ORDER BY ts, ref, wakeup_from`,
        [range.startNs, range.endNs],
      )
      .map(toWakeupEvent);
  }
}
