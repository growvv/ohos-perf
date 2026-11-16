import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { NativeHookQuery } from '../src/query/native-hook';

let dir: string;
let db: QueryHandle;
/** Handles opened per test; closed before the temp directory is removed. */
const extraHandles: QueryHandle[] = [];

const NATIVE_HOOK_DDL = `CREATE TABLE native_hook(id INT, callchain_id INT, ipid INT,
  itid INT, event_type INT, sub_type_id INT, start_ts INT, end_ts INT, dur INT,
  addr INT, heap_size INT, all_heap_size INT, current_size_dur INT,
  last_lib_id INT, last_symbol_id INT)`;

const NATIVE_FRAME_DDL = `CREATE TABLE native_hook_frame(id INT, callchain_id INT,
  depth INT, ip INT, symbol_id INT, file_id INT, offset INT, symbol_offset INT,
  vaddr INT)`;

const STATISTIC_DDL = `CREATE TABLE native_hook_statistic(id INT, callchain_id INT,
  ipid INT, ts INT, type INT, sub_type_id INT, apply_count INT, release_count INT,
  apply_size INT, release_size INT, last_lib_id INT, last_symbol_id INT)`;

const PROCESS_DDL = 'CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT)';
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-nativehook-'));
  const path = join(dir, 'trace.db');
  const d = new DatabaseSync(path);
  d.exec(NATIVE_HOOK_DDL);
  d.exec(NATIVE_FRAME_DDL);
  d.exec(STATISTIC_DDL);
  d.exec(PROCESS_DDL);
  d.exec(DATA_DICT_DDL);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo'),
    (1, 18, 5000, 'other')`);
  // Inserted out of timestamp order: the query must order by (start_ts, id).
  d.exec(`INSERT INTO native_hook VALUES
    (1, 10, 17, 100, 0, 1, 400, 0, 0, 8192, 32, 0, 0, 1, 2),
    (0, 10, 17, 100, 0, 1, 300, 0, 0, 4096, 64, 0, 0, 1, 2),
    (2, 11, 18, 200, 1, 0, 500, 0, 0, 4096, 64, 0, 0, 1, 2)`);
  d.exec(`INSERT INTO native_hook_frame VALUES
    (1, 10, 1, 8192, 2, 1, 0, 0, 0),
    (0, 10, 0, 4096, 2, 1, 0, 0, 0)`);
  d.exec('INSERT INTO native_hook_statistic VALUES (0, 10, 17, 900, 0, 1, 2, 1, 96, 32, 1, 2)');
  d.exec("INSERT INTO data_dict VALUES (1, 'libfoo.so'), (2, 'Foo()')");
  d.close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  for (const handle of extraHandles) handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A database with no native tables at all, so every accessor must degrade. */
function openBareDb(): QueryHandle {
  const path = join(dir, 'bare.db');
  new DatabaseSync(path).close();
  const handle = openDb(path);
  extraHandles.push(handle);
  return handle;
}

describe('NativeHookQuery', () => {
  it('reads app events ordered by start_ts then id, filtered by pid', () => {
    const rows = new NativeHookQuery(db).events([4999]);
    expect(rows.map((r) => r.id)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({
      callchainId: 10, ipid: 17, pid: 4999, itid: 100, eventType: 0,
      startTs: 300, addr: 4096, heapSize: 64, lastLibId: 1, lastSymbolId: 2,
    });
  });

  it('applies an inclusive range when one is given', () => {
    expect(new NativeHookQuery(db).events([4999], { startNs: 400, endNs: 400 })
      .map((r) => r.id)).toEqual([1]);
    expect(new NativeHookQuery(db).events([4999], { startNs: 0, endNs: 299 })).toEqual([]);
  });

  it('returns [] and false for every accessor when the tables are absent', () => {
    const bareHandle = openBareDb();
    const bare = new NativeHookQuery(bareHandle);
    expect(bare.hasData()).toBe(false);
    expect(bare.hasStatistics()).toBe(false);
    expect(bare.events([4999])).toEqual([]);
    expect(bare.statistics([4999])).toEqual([]);
    expect(bare.dataDict([1])).toEqual(new Map());
    expect(bare.frames([10])).toEqual(new Map());
  });

  it('resolves frames by depth and data_dict names in one read', () => {
    const query = new NativeHookQuery(db);
    const frames = query.frames([10]);
    expect(frames.get(10)!.map((f) => f.depth)).toEqual([0, 1]);
    expect(query.dataDict([1, 2])).toEqual(
      new Map([[1, 'libfoo.so'], [2, 'Foo()']]),
    );
  });

  it('reports statistics presence and rows for the app', () => {
    const query = new NativeHookQuery(db);
    expect(query.hasData()).toBe(true);
    expect(query.hasStatistics()).toBe(true);
    expect(query.statistics([4999])).toEqual([
      expect.objectContaining({ callchainId: 10, applySize: 96, releaseSize: 32 }),
    ]);
  });

  it('returns an empty map for an empty id list without querying', () => {
    expect(new NativeHookQuery(db).frames([])).toEqual(new Map());
    expect(new NativeHookQuery(db).dataDict([])).toEqual(new Map());
  });

  it('chunks id lists past the SQLite variable limit', () => {
    // A real nativehook capture has tens of thousands of callchains. One
    // `IN (?, …)` per list throws `too many SQL variables` (the limit is
    // 32 766), which aborts the analyzer and the named queries.
    const many = Array.from({ length: 40_000 }, (_, index) => 1000 + index);
    const query = new NativeHookQuery(db);
    expect(() => query.frames(many)).not.toThrow();
    expect(() => query.dataDict(many)).not.toThrow();
    expect(query.frames(many).size).toBe(0);
    expect(query.dataDict(many).size).toBe(0);
  });

  it('degrades instead of throwing when the process table is absent', () => {
    // The documented contract is that a missing table yields `[]`, never
    // `no such table`; `events`/`statistics` join `process` unguarded.
    const path = join(dir, 'no-process.db');
    const raw = new DatabaseSync(path);
    raw.exec(NATIVE_HOOK_DDL);
    raw.exec(STATISTIC_DDL);
    raw.exec(`INSERT INTO native_hook VALUES
      (0, 10, 17, 100, 0, 1, 300, 0, 0, 4096, 64, 0, 0, 1, 2)`);
    raw.exec('INSERT INTO native_hook_statistic VALUES (0, 10, 17, 900, 0, 1, 2, 1, 96, 32, 1, 2)');
    raw.close();
    const handle = openDb(path);
    extraHandles.push(handle);
    const query = new NativeHookQuery(handle);
    expect(query.events([4999])).toEqual([]);
    expect(query.statistics([4999])).toEqual([]);
  });

  it('returns each event once when a duplicated ipid maps to two process rows', () => {
    // A merged trace can carry two `process` rows with the same `ipid`. A plain
    // join then returns the event once per process row, doubling every byte.
    const path = join(dir, 'dup-ipid.db');
    const raw = new DatabaseSync(path);
    raw.exec(NATIVE_HOOK_DDL);
    raw.exec(PROCESS_DDL);
    raw.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo'),
      (1, 17, 4999, 'com.demo')`);
    raw.exec(`INSERT INTO native_hook VALUES
      (0, 10, 17, 100, 0, 1, 300, 0, 0, 4096, 64, 0, 0, 1, 2)`);
    raw.close();
    const handle = openDb(path);
    extraHandles.push(handle);
    expect(new NativeHookQuery(handle).events([4999]).map((r) => r.id)).toEqual([0]);
  });

  it('reports a NULL event type as neither alloc nor free', () => {
    // `event_type ?? 0` turns an absent type into an allocation, inflating the
    // running total with bytes whose direction is unknown.
    const path = join(dir, 'null-type.db');
    const raw = new DatabaseSync(path);
    raw.exec(NATIVE_HOOK_DDL);
    raw.exec(PROCESS_DDL);
    raw.exec("INSERT INTO process VALUES (0, 17, 4999, 'com.demo')");
    raw.exec(`INSERT INTO native_hook VALUES
      (0, 10, 17, 100, NULL, 1, 300, 0, 0, 4096, 64, 0, 0, 1, 2)`);
    raw.close();
    const handle = openDb(path);
    extraHandles.push(handle);
    expect(new NativeHookQuery(handle).events([4999])[0]!.eventType).toBeNull();
  });
});
