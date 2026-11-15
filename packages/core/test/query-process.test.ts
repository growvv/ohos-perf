import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { ProcessQuery, ThreadQuery } from '../src/query/process';
import { num } from '../src/query/rows';

let dir: string; let db: QueryHandle;

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
  switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
  end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-proc-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(PROCESS_DDL);
  d.exec(`INSERT INTO process VALUES
    (0, 17, 4999, 'com.demo', 100, 5, 3, 3, 0),
    (1, 18, 100, 'render_service', 90, 9, 4, 4, 0),
    (2, 19, 777, 'no_start', NULL, 0, 1, 0, 0)`);
  d.exec(THREAD_DDL);
  d.exec(`INSERT INTO thread VALUES
    (44, 44, 4999, 'main', 100, 200, 17, 1, 5),
    (45, 45, 5000, 'worker', 100, 200, 17, 0, 2),
    (46, 46, 5001, 'orphan', NULL, NULL, 18, 1, 0)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Builds a throwaway trace db from raw SQL, for tests that need their own schema. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  build(d);
  d.close();
  return openDb(p);
}

describe('ProcessQuery', () => {
  it('finds process by name', () => {
    expect(new ProcessQuery(db).byName('com.demo')?.pid).toBe(4999);
  });
  it('returns pids for names in given order', () => {
    expect(new ProcessQuery(db).pidsFor(['render_service', 'com.demo'])).toEqual([100, 4999]);
  });
  it('skips unknown names', () => {
    expect(new ProcessQuery(db).pidsFor(['nope'])).toEqual([]);
  });
  it('resolves duplicate names to the lowest id', () => {
    // Measured on the real trace: `sh` appears 86 times, `hidumper` 46 times.
    // Deterministic output (D5) requires a fixed tie-break, not "any row".
    const dup = withDb('dup-names.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES
        (5, 18, 300, 'sh', NULL, 0, 1, 0, 0),
        (2, 18, 200, 'sh', NULL, 0, 1, 0, 0)`);
    });
    try {
      expect(new ProcessQuery(dup).byName('sh')?.pid).toBe(200);
      expect(new ProcessQuery(dup).pidsFor(['sh'])).toEqual([200]);
    } finally {
      dup.close();
    }
  });
  it('normalises NULL numerics to 0', () => {
    // process.start_ts is NULL on all 437 real rows; 0 means absent.
    expect(new ProcessQuery(db).byName('com.demo')?.startTs).toBe(100);
    expect(new ProcessQuery(db).all().find((p) => p.name === 'no_start')?.startTs).toBe(0);
  });
});

describe('ThreadQuery', () => {
  it('filters main threads', () => {
    // Measured: exactly one is_main_thread=1 per ipid, 437 main threads over
    // 437 processes — so this is one row per process, not one row overall.
    expect(new ThreadQuery(db).mainThreads().map((t) => t.id)).toEqual([44, 46]);
  });
  it('filters by process ipid', () => {
    expect(new ThreadQuery(db).forProcess(17).map((t) => t.id)).toEqual([44, 45]);
  });
  it('maps is_main_thread to boolean', () => {
    expect(new ThreadQuery(db).all()[0].isMainThread).toBe(true);
  });
  it('sorts all() by id and normalises NULL end_ts to 0', () => {
    // thread.end_ts is NULL on all 1231 real rows.
    const all = new ThreadQuery(db).all();
    expect(all.map((t) => t.id)).toEqual([44, 45, 46]);
    expect(all[2].endTs).toBe(0);
    expect(all[2].startTs).toBe(0);
  });
  it('resolves threads by pid without confusing it for an ipid', () => {
    // Measured on the real trace: a pid is NOT an ipid. 40 of 437 processes
    // have a pid that is also a legal ipid belonging to a DIFFERENT process,
    // so `forProcess(pid)` silently returns another process's threads —
    // e.g. `hilogd` (ipid 4, pid 113) yields `sh`'s threads. `forPid` joins
    // through `process`, so it cannot make that mistake.
    const conf = withDb('pid-ipid.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES
        (4, 4, 113, 'hilogd', NULL, 0, 2, 0, 0),
        (113, 113, 500, 'sh', NULL, 0, 1, 0, 0)`);
      d.exec(THREAD_DDL);
      d.exec(`INSERT INTO thread VALUES
        (6, 6, 4001, 'hilogd.server', NULL, NULL, 4, 0, 0),
        (10, 10, 4002, 'hilogd', NULL, NULL, 4, 1, 0),
        (386, 386, 5001, 'sh', NULL, NULL, 113, 1, 0)`);
    });
    try {
      const threads = new ThreadQuery(conf);
      // ipid 113 belongs to `sh`, not to `hilogd`: the old accessor returns
      // another process's thread here, with no error.
      expect(threads.forProcess(113).map((t) => t.id)).toEqual([386]);
      // forPid(113) is `hilogd`'s pid, so it returns `hilogd`'s threads.
      expect(threads.forPid(113).map((t) => t.id)).toEqual([6, 10]);
      expect(threads.forPid(500).map((t) => t.id)).toEqual([386]);
    } finally {
      conf.close();
    }
  });
  it('returns [] for an unknown pid', () => {
    expect(new ThreadQuery(db).forPid(123456)).toEqual([]);
  });
});

describe('absent process/thread tables (truncated scene)', () => {
  // A sparse or truncated scene can carry only `callstack` + `frame_slice`.
  // App resolution calls ProcessQuery before runAnalyzers, and the wakeup
  // analysis joins `thread` unguarded, so both must degrade, never throw.
  it('returns []/undefined instead of throwing when there is no process table', () => {
    const sparse = withDb('no-process.db', (d) => {
      d.exec('CREATE TABLE callstack(id INT)');
      d.exec('CREATE TABLE frame_slice(id INT)');
    });
    try {
      const processes = new ProcessQuery(sparse);
      expect(processes.all()).toEqual([]);
      expect(processes.byName('com.demo')).toBeUndefined();
      expect(processes.byPid(4999)).toBeUndefined();
      // `byNames` in the fix brief is this name→pid batch accessor.
      expect(processes.pidsFor(['com.demo', 'render_service'])).toEqual([]);
    } finally {
      sparse.close();
    }
  });

  it('returns [] when there is no thread table', () => {
    const sparse = withDb('no-thread.db', (d) => {
      d.exec('CREATE TABLE callstack(id INT)');
      d.exec('CREATE TABLE frame_slice(id INT)');
    });
    try {
      const threads = new ThreadQuery(sparse);
      expect(threads.all()).toEqual([]);
      expect(threads.mainThreads()).toEqual([]);
      expect(threads.forProcess(17)).toEqual([]);
      // forPid joins through `process` too; neither table exists here.
      expect(threads.forPid(4999)).toEqual([]);
    } finally {
      sparse.close();
    }
  });

  it('still resolves normally when the tables exist (positive control)', () => {
    expect(new ProcessQuery(db).byName('com.demo')?.pid).toBe(4999);
    expect(new ThreadQuery(db).all()).toHaveLength(3);
  });
});

describe('rows', () => {
  it('coerces a non-numeric value to 0 instead of NaN', () => {
    // SQLite can store text in an INT-affinity column. `JSON.stringify(NaN)`
    // is `null`, so a NaN would silently become a missing value downstream;
    // `0` is the documented "absent" sentinel for numeric fields.
    expect(num('abc' as unknown as number | null)).toBe(0);
    expect(Number.isNaN(num('abc' as unknown as number | null))).toBe(false);
    expect(num('12' as unknown as number | null)).toBe(12);
  });
});
