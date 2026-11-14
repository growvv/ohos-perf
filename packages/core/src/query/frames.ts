import type { QueryHandle } from '../db/driver';
import type { TimeRange } from '../types';
import { num, str } from './rows';

/**
 * Frame status as stored in `frame_slice.flag`.
 *
 * `0` normal, `1` stuttered (rendered late), `2` empty (nothing to draw),
 * `3` RS-App abnormal.
 *
 * Note `3` is **not** a `FrameStats` bucket: `stats()` counts flag-3 rows in
 * `total` but in none of `stuttered`/`empty`/`normal`, so
 * `stuttered + empty + normal` can be less than `total` (10 of 177 rows on the
 * measured 249MB trace). Do not compute a stutter rate as `stuttered / total`
 * without deciding what to do with flag 3.
 */
export type FrameFlag = 0 | 1 | 2 | 3;
/** 0 = actual (rendered) frame, 1 = expected frame. */
export type FrameType = 0 | 1;

/**
 * One row of `frame_slice` with camelCase field names.
 *
 * `ts` and `dur` are nanoseconds. `flag` is never null on a `Frame`: every
 * accessor inherits `all()`'s `WHERE flag IS NOT NULL`, because a row without
 * a flag is incomplete data (on the real 249MB trace, 161 of 169 expect frames
 * have a NULL flag and are therefore invisible here — matching HapRay).
 */
export interface Frame {
  id: number;
  ts: number;
  dur: number;
  vsync: number;
  ipid: number;
  itid: number;
  callstackId: number;
  flag: FrameFlag;
  type: FrameType;
  typeDesc: string;
  src: string;
  dst: number;
  depth: number;
  frameNo: number;
}

export interface FrameStats {
  total: number;
  actual: number;
  expect: number;
  stuttered: number;
  empty: number;
  normal: number;
}

/** A `frame_maps` row; both ends are `frame_slice.id` values. */
interface FrameMapRow {
  id: number;
  src_row: number | null;
  dst_row: number | null;
}

interface FrameSliceRow {
  id: number | null;
  ts: number | null;
  vsync: number | null;
  ipid: number | null;
  itid: number | null;
  callstack_id: number | null;
  dur: number | null;
  src: string | null;
  dst: number | null;
  type: number | null;
  type_desc: string | null;
  flag: number | null;
  depth: number | null;
  frame_no: number | null;
}

const SELECT_FRAMES = `SELECT id, ts, vsync, ipid, itid, callstack_id, dur, src, dst,
       type, type_desc, flag, depth, frame_no
FROM frame_slice
WHERE flag IS NOT NULL`;

function toFrame(row: FrameSliceRow): Frame {
  return {
    id: num(row.id),
    ts: num(row.ts),
    vsync: num(row.vsync),
    ipid: num(row.ipid),
    itid: num(row.itid),
    callstackId: num(row.callstack_id),
    dur: num(row.dur),
    src: str(row.src),
    dst: num(row.dst),
    type: num(row.type) as FrameType,
    typeDesc: str(row.type_desc),
    flag: num(row.flag) as FrameFlag,
    depth: num(row.depth),
    frameNo: num(row.frame_no),
  };
}

/**
 * Typed accessor over `frame_slice`.
 *
 * Every method shares one predicate — `flag IS NOT NULL` — and one ordering,
 * `ts` ascending. Accessors filter that base set rather than issuing their own
 * SQL, so the flag/type semantics cannot drift between them.
 */
export class FrameQuery {
  constructor(private readonly db: QueryHandle) {}

  /** All complete frames, optionally restricted to `[startNs, endNs]` inclusive. */
  all(range?: TimeRange): Frame[] {
    const sql = range
      ? `${SELECT_FRAMES} AND ts >= ? AND ts <= ? ORDER BY ts`
      : `${SELECT_FRAMES} ORDER BY ts`;
    const params = range ? [range.startNs, range.endNs] : [];
    return this.db
      .query<FrameSliceRow>(sql, params)
      .map(toFrame);
  }

  actual(range?: TimeRange): Frame[] {
    return this.all(range).filter((f) => f.type === 0);
  }

  expect(range?: TimeRange): Frame[] {
    return this.all(range).filter((f) => f.type === 1);
  }

  /** flag = 1 (rendered but late). */
  stuttered(range?: TimeRange): Frame[] {
    return this.all(range).filter((f) => f.flag === 1);
  }

  /** flag = 2 (nothing needed to be drawn). */
  empty(range?: TimeRange): Frame[] {
    return this.all(range).filter((f) => f.flag === 2);
  }

  /**
   * Mappings from `frame_maps`, ordered by `src.ts`.
   *
   * `src_row` / `dst_row` reference `frame_slice.id`. On the measured trace,
   * `frame_maps` links **same-type frames across processes** — an app /
   * sceneboard frame (`ipid=17` or `35`) and a render_service frame
   * (`ipid=26`) — NOT an actual frame to its expectation. Both ends therefore
   * share a `type` (50 type-0 and 50 type-1 mappings on the 249MB trace), and
   * neither field implies "expected". The two ends also live in different
   * `vsync` domains (e.g. app 3975 vs render_service 6130), so `vsync` is not
   * a join key either.
   *
   * Both ends are resolved through the same `flag IS NOT NULL` set `all()`
   * returns. A mapping is **dropped** when either end cannot become a `Frame`:
   * its row is missing, or its flag is NULL — no `Frame` can represent a
   * NULL-flag row. This is not an edge case: roughly half the measured
   * mappings (50 of 100) point at NULL-flag expect frames and are dropped.
   *
   * Returns `[]` when `frame_maps` is absent or empty; never throws for that.
   * The result is sorted by `src.ts` ascending; `Array#sort` is stable and the
   * mappings are read `ORDER BY id`, so equal `ts` values keep mapping order.
   */
  mapped(): Array<{ src: Frame; dst: Frame }> {
    if (!this.hasTable('frame_maps')) return [];

    const byId = new Map<number, Frame>();
    for (const frame of this.all()) byId.set(frame.id, frame);

    const mappings = this.db.query<FrameMapRow>(
      'SELECT id, src_row, dst_row FROM frame_maps ORDER BY id',
    );

    const mapped: Array<{ src: Frame; dst: Frame }> = [];
    for (const mapping of mappings) {
      const src = mapping.src_row == null ? undefined : byId.get(mapping.src_row);
      const dst = mapping.dst_row == null ? undefined : byId.get(mapping.dst_row);
      if (!src || !dst) continue;
      mapped.push({ src, dst });
    }

    return mapped.sort((a, b) => a.src.ts - b.src.ts);
  }

  /**
   * Counts over the same set `all()` returns, mirroring HapRay's
   * `get_frame_statistics` (which calls `get_frames_data` and therefore also
   * drops NULL-flag rows).
   */
  stats(range?: TimeRange): FrameStats {
    const frames = this.all(range);
    const stats: FrameStats = {
      total: frames.length,
      actual: 0,
      expect: 0,
      stuttered: 0,
      empty: 0,
      normal: 0,
    };
    for (const frame of frames) {
      if (frame.type === 0) stats.actual++;
      else if (frame.type === 1) stats.expect++;
      if (frame.flag === 1) stats.stuttered++;
      else if (frame.flag === 2) stats.empty++;
      else if (frame.flag === 0) stats.normal++;
    }
    return stats;
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
