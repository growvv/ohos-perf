import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { ProcessQuery, ThreadQuery } from '../src/query/process';

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
});
