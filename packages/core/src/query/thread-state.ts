import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One row of `thread_state` with camelCase field names.
 *
 * `ts` and `dur` are nanoseconds. `0`/`''` mean absent, as everywhere else in
 * the query layer. The P1 schema has no `id` column on this table, so no
 * identifier is exposed; ordering uses `ts, itid, state`.
 */
export interface ThreadState {
  ts: number;
  dur: number;
  cpu: number;
  itid: number;
  tid: number;
  pid: number;
  state: string;
  argSetid: number;
}

interface ThreadStateRow {
  ts: number | null;
  dur: number | null;
  cpu: number | null;
  itid: number | null;
  tid: number | null;
  pid: number | null;
  state: string | null;
  arg_setid: number | null;
}

const SELECT_THREAD_STATES = `SELECT ts, dur, cpu, itid, tid, pid, state, arg_setid
FROM thread_state`;

function toThreadState(row: ThreadStateRow): ThreadState {
  return {
    ts: num(row.ts),
    dur: num(row.dur),
    cpu: num(row.cpu),
    itid: num(row.itid),
    tid: num(row.tid),
    pid: num(row.pid),
    state: str(row.state),
    argSetid: num(row.arg_setid),
  };
}

/**
 * Typed accessor over `thread_state`.
 *
 * Every method orders by `ts, itid, state` — the secondary keys make equal
 * timestamps deterministic even though the table has no `id`. Time ranges are
 * inclusive at both ends. `thread_state` is a core trace_streamer table, so no
 * `hasTable()` guard is used.
 */
export class ThreadStateQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All states in `[startNs, endNs]` (or the whole trace). */
  all(range?: TimeRange): ThreadState[] {
    const sql = range
      ? `${SELECT_THREAD_STATES} WHERE ts >= ? AND ts <= ? ORDER BY ts, itid, state`
      : `${SELECT_THREAD_STATES} ORDER BY ts, itid, state`;
    const params = range ? [range.startNs, range.endNs] : [];
    return this.db.query<ThreadStateRow>(sql, params).map(toThreadState);
  }

  /**
   * States of the given `itids`, ordered by `ts, itid, state`.
   *
   * An empty `itids` returns `[]` without issuing `IN ()`.
   */
  forItids(itids: number[], range?: TimeRange): ThreadState[] {
    if (itids.length === 0) return [];
    const placeholders = itids.map(() => '?').join(', ');
    const where = [`itid IN (${placeholders})`];
    const params: unknown[] = [...itids];
    if (range) {
      where.push('ts >= ?', 'ts <= ?');
      params.push(range.startNs, range.endNs);
    }
    return this.db
      .query<ThreadStateRow>(
        `${SELECT_THREAD_STATES} WHERE ${where.join(' AND ')} ORDER BY ts, itid, state`,
        params,
      )
      .map(toThreadState);
  }
}
