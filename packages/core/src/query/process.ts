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
 * A truncated or sparse scene can lack the `process` table entirely (e.g. a
 * capture holding only `callstack` and `frame_slice`). Every accessor therefore
 * checks `hasTable()` first and returns `[]`/`undefined` instead of letting
 * SQLite throw `no such table: process` — the same guard idiom as the other
 * query classes use for their optional tables.
 */
export class ProcessQuery {
  constructor(private readonly db: QueryHandle) {}

  /**
   * Every process row, ordered by `id` ascending.
   *
   * Ordering is fixed rather than left to SQLite so the result is byte-stable
   * across runs (D5). An absent table returns `[]`.
   */
  all(): ProcessInfo[] {
    if (!this.hasTable('process')) return [];
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
   *
   * Rows with `name IS NULL` map to `ProcessInfo.name === ''`, but
   * `byName('')` does **not** find them: SQL `name = ''` never matches NULL.
   * A NULL-named row is reachable only through `all()`. An absent table returns
   * `undefined`.
   */
  byName(name: string): ProcessInfo | undefined {
    if (!this.hasTable('process')) return undefined;
    const [row] = this.db.query<ProcessRow>(
      `${SELECT_PROCESS} WHERE name = ? ORDER BY id LIMIT 1`,
      [name],
    );
    return row ? toProcess(row) : undefined;
  }

  /**
   * The process row whose **`pid`** is `pid`, or `undefined` if none exists.
   *
   * Like {@link byName}, duplicate matches resolve to the lowest `id` so output
   * is deterministic (D5). This is the safe pid→ipid step: never compare a pid
   * against `thread.ipid` or another ipid column directly. An absent table
   * returns `undefined`.
   */
  byPid(pid: number): ProcessInfo | undefined {
    if (!this.hasTable('process')) return undefined;
    const [row] = this.db.query<ProcessRow>(
      `${SELECT_PROCESS} WHERE pid = ? ORDER BY id LIMIT 1`,
      [pid],
    );
    return row ? toProcess(row) : undefined;
  }

  /**
   * One `pid` per requested name, **in the order the names were given**;
   * unknown names are skipped (so the result may be shorter than `names`).
   *
   * Each name resolves with the same lowest-`id` rule as `byName`. A name
   * repeated in `names` therefore yields its pid once per occurrence, and
   * names resolving to the same `pid` are not deduplicated. An absent table
   * returns `[]`.
   */
  pidsFor(names: string[]): number[] {
    if (names.length === 0 || !this.hasTable('process')) return [];
    const pids: number[] = [];
    for (const name of names) {
      const process = this.byName(name);
      if (process) pids.push(process.pid);
    }
    return pids;
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}

/**
 * Typed accessor over `thread`.
 *
 * Every method returns `all()`'s row shape in `id` ascending order.
 * `mainThreads()` and `forProcess()` filter that set rather than issuing their
 * own SQL, so their NULL handling cannot drift from `all()`. `forPid()` joins
 * through `process` and reuses the same `toThread` mapping, so only its
 * predicate differs.
 *
 * A truncated or sparse scene can lack the `thread` table (the wakeup analysis
 * joins it unguarded), so every accessor checks `hasTable()` first and returns
 * `[]` instead of letting SQLite throw `no such table: thread`, matching the
 * other query classes' guard idiom.
 */
export class ThreadQuery {
  constructor(private readonly db: QueryHandle) {}

  /** Every thread row, ordered by `id` ascending. An absent table returns `[]`. */
  all(): ThreadInfo[] {
    if (!this.hasTable('thread')) return [];
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

  /**
   * Rows whose `ipid` belongs to the given process, ordered by `id`.
   *
   * **The argument is an `ipid`, not a `pid`.** `frame_slice.ipid` and
   * `callstack.ipid` are ipids, so this is the right accessor for frame and
   * binder analysis. If you have a `pid` — for example the value
   * `ProcessQuery.pidsFor()` returns — use {@link forPid} instead.
   *
   * Passing a pid here is not merely "not found": ipids and pids are different
   * number spaces that overlap, so a pid can name a *different* process's
   * ipid. Measured on the 249MB trace, of 437 processes 396 pids are not a
   * legal ipid (this returns `[]`), 1 pid happens to equal its own ipid, and
   * **40 silently return another process's threads**. For example `hilogd`
   * has `ipid=4, pid=113`, and ipid 113 belongs to `sh` — so
   * `forProcess(113)` returns `sh`'s thread with no error.
   */
  forProcess(ipid: number): ThreadInfo[] {
    return this.all().filter((thread) => thread.ipid === ipid);
  }

  /**
   * Rows of the process whose **`pid`** is `pid`, ordered by `id`.
   *
   * Resolves the pid through `process` (`thread.ipid = process.ipid`) rather
   * than comparing it against `thread.ipid` directly, so a pid can never be
   * mistaken for an ipid — see {@link forProcess} for the measured overlap.
   * Measured: `hilogd` (pid 113) yields its 6 threads, `ohos.sceneboard` 32,
   * `render_service` 17, `sh` 1. Pids are unique on the measured traces, so
   * the join cannot fan out; an unknown pid returns `[]`. The join reads both
   * `thread` and `process`, so an absent one of them returns `[]`.
   */
  forPid(pid: number): ThreadInfo[] {
    if (!this.hasTable('thread') || !this.hasTable('process')) return [];
    return this.db
      .query<ThreadRow>(
        `SELECT t.id, t.itid, t.tid, t.name, t.start_ts, t.end_ts, t.ipid,
                t.is_main_thread, t.switch_count
         FROM thread t JOIN process p ON t.ipid = p.ipid
         WHERE p.pid = ?
         ORDER BY t.id`,
        [pid],
      )
      .map(toThread);
  }

  private hasTable(name: string): boolean {
    const rows = this.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.length > 0;
  }
}
