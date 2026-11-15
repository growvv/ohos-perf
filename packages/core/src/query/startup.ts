import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * One `app_startup` row with camelCase field names.
 *
 * `startTime`/`endTime` are nanoseconds. `startName` is kept as the raw
 * integer column (the table stores an id there); `0`/`''` mean absent.
 */
export interface StartupRecord {
  id: number;
  callId: number;
  ipid: number;
  tid: number;
  startTime: number;
  endTime: number;
  startName: number;
  packedName: string;
}

interface StartupRow {
  id: number | null;
  call_id: number | null;
  ipid: number | null;
  tid: number | null;
  start_time: number | null;
  end_time: number | null;
  start_name: number | null;
  packed_name: string | null;
}

const SELECT_STARTUP = `SELECT id, call_id, ipid, tid, start_time, end_time,
       start_name, packed_name
FROM app_startup`;

function toStartupRecord(row: StartupRow): StartupRecord {
  return {
    id: num(row.id),
    callId: num(row.call_id),
    ipid: num(row.ipid),
    tid: num(row.tid),
    startTime: num(row.start_time),
    endTime: num(row.end_time),
    startName: num(row.start_name),
    packedName: str(row.packed_name),
  };
}

/**
 * Typed accessor over the optional `app_startup` table.
 *
 * The table is absent in traces that did not capture startup events, so every
 * accessor returns `[]` in that case instead of throwing. Ordering is
 * `start_time, id`; ranges are inclusive and apply to `start_time`.
 */
export class StartupQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All startup rows in `[startNs, endNs]` (or the whole trace). */
  all(range?: TimeRange): StartupRecord[] {
    if (!this.hasTable('app_startup')) return [];
    const sql = range
      ? `${SELECT_STARTUP} WHERE start_time >= ? AND start_time <= ? ORDER BY start_time, id`
      : `${SELECT_STARTUP} ORDER BY start_time, id`;
    const params = range ? [range.startNs, range.endNs] : [];
    return this.db.query<StartupRow>(sql, params).map(toStartupRecord);
  }

  /**
   * Rows whose `ipid` is one of `ipids`, ordered by `start_time, id`.
   *
   * The argument is an `ipid`, not a `pid`; use `ProcessQuery` to resolve a
   * pid first. An empty list or an absent table returns `[]`.
   */
  forIpids(ipids: number[]): StartupRecord[] {
    if (ipids.length === 0 || !this.hasTable('app_startup')) return [];
    const placeholders = ipids.map(() => '?').join(', ');
    return this.db
      .query<StartupRow>(
        `${SELECT_STARTUP} WHERE ipid IN (${placeholders}) ORDER BY start_time, id`,
        ipids,
      )
      .map(toStartupRecord);
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
