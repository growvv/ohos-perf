import type { QueryHandle } from '../db/driver';
import { num, str } from './rows';

/**
 * One row of `process` with camelCase field names.
 *
 * `startTs` is nanoseconds, but **`0` means absent, not time zero**: on the
 * measured 249MB trace `process.start_ts` is NULL on all 437 rows, so a
 * consumer must not read `startTs === 0` as "started at the trace origin".
 * The same NULL-to-0 rule applies to every other numeric field.
 *
 * `name` is `''` when the column is NULL (60 of the 437 real rows). Duplicate
 * non-empty names are common (`sh` ×86, `hidumper` ×46), so a `ProcessInfo`
 * identifies one row, not one logical process; see `ProcessQuery.byName`.
 */
export interface ProcessInfo {
  id: number;
  ipid: number;
  pid: number;
  name: string;
  startTs: number;
  switchCount: number;
  threadCount: number;
  sliceCount: number;
  memCount: number;
}

/**
 * One row of `thread` with camelCase field names.
 *
 * `startTs` and `endTs` are nanoseconds, but **`0` means absent, not time
 * zero**: on the measured 249MB trace `thread.end_ts` is NULL on all 1231
 * rows, and `startTs` can be NULL too. A consumer must not read
 * `endTs === 0` as "ended at the trace origin".
 */
export interface ThreadInfo {
  id: number;
  itid: number;
  tid: number;
  name: string;
  startTs: number;
  endTs: number;
  ipid: number;
  isMainThread: boolean;
  switchCount: number;
}

interface ProcessRow {
  id: number | null;
  ipid: number | null;
  pid: number | null;
  name: string | null;
  start_ts: number | null;
  switch_count: number | null;
  thread_count: number | null;
  slice_count: number | null;
  mem_count: number | null;
}

interface ThreadRow {
  id: number | null;
  itid: number | null;
  tid: number | null;
  name: string | null;
  start_ts: number | null;
  end_ts: number | null;
  ipid: number | null;
  is_main_thread: number | null;
  switch_count: number | null;
}

const SELECT_PROCESS = `SELECT id, ipid, pid, name, start_ts, switch_count,
       thread_count, slice_count, mem_count
FROM process`;

const SELECT_THREAD = `SELECT id, itid, tid, name, start_ts, end_ts, ipid,
       is_main_thread, switch_count
FROM thread`;

function toProcess(row: ProcessRow): ProcessInfo {
  return {
    id: num(row.id),
    ipid: num(row.ipid),
    pid: num(row.pid),
    name: str(row.name),
    startTs: num(row.start_ts),
    switchCount: num(row.switch_count),
    threadCount: num(row.thread_count),
    sliceCount: num(row.slice_count),
    memCount: num(row.mem_count),
  };
}

function toThread(row: ThreadRow): ThreadInfo {
  return {
    id: num(row.id),
    itid: num(row.itid),
    tid: num(row.tid),
    name: str(row.name),
    startTs: num(row.start_ts),
    endTs: num(row.end_ts),
    ipid: num(row.ipid),
    isMainThread: num(row.is_main_thread) === 1,
    switchCount: num(row.switch_count),
  };
}

/**
 * Typed accessor over `process`.
 *
 * `process` is a core trace_streamer table present in every 88-table output,
 * so no `hasTable()` guard is used (matching `FrameQuery.all()`).
 */
export class ProcessQuery {
  constructor(private readonly db: QueryHandle) {}

  /**
   * Every process row, ordered by `id` ascending.
   *
   * Ordering is fixed rather than left to SQLite so the result is byte-stable
   * across runs (D5).
   */
  all(): ProcessInfo[] {
    return this.db.query<ProcessRow>(`${SELECT_PROCESS} ORDER BY id`).map(toProcess);
  }

  /**
   * The process row named `name`, or `undefined` if none exists.
   *
   * **Duplicate names resolve to the lowest `id`.** The measured trace has
   * heavy duplication (`sh` ×86, `hidumper` ×46, `ls` ×38, `head` ×36) and
   * "return any matching row" would make output depend on row order, which
   * violates the determinism requirement (D5). `ORDER BY id LIMIT 1` fixes the
   * tie-break.
   */
  byName(name: string): ProcessInfo | undefined {
    const [row] = this.db.query<ProcessRow>(
      `${SELECT_PROCESS} WHERE name = ? ORDER BY id LIMIT 1`,
      [name],
    );
    return row ? toProcess(row) : undefined;
  }

  /**
   * One `pid` per requested name, **in the order the names were given**;
   * unknown names are skipped (so the result may be shorter than `names`).
   *
   * Each name resolves with the same lowest-`id` rule as `byName`. A name
   * repeated in `names` therefore yields its pid once per occurrence, and
   * names resolving to the same `pid` are not deduplicated.
   */
  pidsFor(names: string[]): number[] {
    const pids: number[] = [];
    for (const name of names) {
      const process = this.byName(name);
      if (process) pids.push(process.pid);
    }
    return pids;
  }
}

/**
 * Typed accessor over `thread`.
 *
 * Every method shares `all()`'s set and `id` ascending order; `mainThreads()`
 * and `forProcess()` filter that set rather than issuing their own SQL, so
 * their ordering and NULL handling cannot drift from `all()`.
 *
 * `thread` is a core trace_streamer table, so no `hasTable()` guard is used.
 */
export class ThreadQuery {
  constructor(private readonly db: QueryHandle) {}

  /** Every thread row, ordered by `id` ascending. */
  all(): ThreadInfo[] {
    return this.db.query<ThreadRow>(`${SELECT_THREAD} ORDER BY id`).map(toThread);
  }

  /**
   * Rows with `is_main_thread = 1`.
   *
   * This is one row per process, not one row overall: the measured trace has
   * 437 main threads over 437 processes.
   */
  mainThreads(): ThreadInfo[] {
    return this.all().filter((thread) => thread.isMainThread);
  }

  /** Rows whose `ipid` belongs to the given process, ordered by `id`. */
  forProcess(ipid: number): ThreadInfo[] {
    return this.all().filter((thread) => thread.ipid === ipid);
  }
}
