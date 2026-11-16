import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { runNamedQuery, type QueryContext } from '../src/query/registry';
import type { NativeTimelineBucket } from '../src/analyze/native-memory';

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

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-nativemem-'));
  const path = join(dir, 'trace.db');
  const d = new DatabaseSync(path);
  d.exec(NATIVE_HOOK_DDL);
  d.exec(NATIVE_FRAME_DDL);
  d.exec(PROCESS_DDL);
  d.exec(THREAD_DDL);
  d.exec(DATA_DICT_DDL);
  d.exec("INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)");
  d.exec("INSERT INTO thread VALUES (0, 100, 500, 'main', 0, 0, 17, 1, 0)");
  // alloc 100, alloc 50, free 50, alloc 20 → peak 150 at 2000, end 120.
  d.exec(`INSERT INTO native_hook VALUES
    (0, 10, 17, 100, 0, 0, 1000000, 0, 0, 4096, 100, 0, 0, 1, 2),
    (1, 10, 17, 100, 0, 0, 2000000, 0, 0, 8192, 50, 0, 0, 1, 3),
    (2, 10, 17, 100, 1, 0, 3000000, 0, 0, 8192, 50, 0, 0, 1, 3),
    (3, 10, 17, 100, 0, 0, 4000000, 0, 0, 4096, 20, 0, 0, 1, 2)`);
  d.exec(`INSERT INTO native_hook_frame VALUES
    (0, 10, 0, 4096, 2, 1, 0, 0, 0),
    (1, 10, 1, 8192, 3, 1, 0, 0, 0)`);
  d.exec(`INSERT INTO data_dict VALUES
    (1, '/system/lib64/libfoo.so'), (2, 'foo()'), (3, 'bar()')`);
  d.close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  for (const handle of extraHandles) handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A database with no native tables at all. */
function openBareDb(): QueryHandle {
  const path = join(dir, 'bare.db');
  new DatabaseSync(path).close();
  const handle = openDb(path);
  extraHandles.push(handle);
  return handle;
}

function ctx(target: QueryHandle): QueryContext {
  return {
    db: target,
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
  };
}

describe('mem.native.unreleased', () => {
  it('lists unreleased rows at the end by default and at a point when asked', () => {
    const end = runNamedQuery(ctx(db), 'mem.native.unreleased', {});
    expect(end.rows[0]).toMatchObject({
      callchainId: 10,
      pid: 4999,
      process: 'com.demo',
      tid: 100,
      thread: 'main',
      file: '/system/lib64/libfoo.so',
      symbol: 'bar()',
      size: 120,
      count: 2,
      firstRelativeNs: 0,
      categoryName: 'SYS_SDK',
    });
    expect(runNamedQuery(ctx(db), 'mem.native.unreleased', { point: 'peak' }).rows[0])
      .toMatchObject({ size: 150, count: 2 });
  });

  it('rejects an unknown point and an unknown argument', () => {
    expect(() => runNamedQuery(ctx(db), 'mem.native.unreleased', { point: 'middle' }))
      .toThrow(/point/);
    expect(() => runNamedQuery(ctx(db), 'mem.native.unreleased', { point: 'end', x: 1 }))
      .toThrow(/unknown argument/);
  });
});

describe('mem.native.callchain', () => {
  it('returns one callchain with its frames resolved from data_dict', () => {
    const r = runNamedQuery(ctx(db), 'mem.native.callchain', { callchainId: 10 });
    expect(r.rows).toEqual([
      { callchainId: 10, depth: 0, ip: 4096, symbol: 'foo()', file: '/system/lib64/libfoo.so' },
      { callchainId: 10, depth: 1, ip: 8192, symbol: 'bar()', file: '/system/lib64/libfoo.so' },
    ]);
  });

  it('requires a callchain id', () => {
    expect(() => runNamedQuery(ctx(db), 'mem.native.callchain', {}))
      .toThrow(/callchainId/);
  });
});

describe('mem.native.timeline', () => {
  it('buckets the capture at the requested width', () => {
    const rows = runNamedQuery(ctx(db), 'mem.native.timeline', { bucketMs: 1 })
      .rows as NativeTimelineBucket[];
    expect(rows.map((row) => [row.startNs, row.allocBytes, row.freeBytes, row.totalBytes]))
      .toEqual([
        [1_000_000, 100, 0, 100],
        [2_000_000, 50, 0, 150],
        [3_000_000, 0, 50, 100],
        [4_000_000, 20, 0, 120],
      ]);
    expect(rows.filter((row) => row.isPeak).map((row) => row.startNs)).toEqual([2_000_000]);
    expect(rows[0].endNs).toBe(2_000_000);
  });

  it('rejects a bucket width below one millisecond', () => {
    expect(() => runNamedQuery(ctx(db), 'mem.native.timeline', { bucketMs: 0 }))
      .toThrow(/bucketMs/);
  });
});

describe('mem.native.categories', () => {
  it('aggregates the end-point rows by category and sub-category', () => {
    expect(runNamedQuery(ctx(db), 'mem.native.categories', {}).rows[0])
      .toMatchObject({ category: 4, categoryName: 'SYS_SDK', size: 120, count: 2 });
  });
});

describe('absent native tables', () => {
  it('returns [] from every query instead of throwing', () => {
    const bare = ctx(openBareDb());
    expect(runNamedQuery(bare, 'mem.native.unreleased', {}).rows).toEqual([]);
    expect(runNamedQuery(bare, 'mem.native.callchain', { callchainId: 1 }).rows).toEqual([]);
    expect(runNamedQuery(bare, 'mem.native.timeline', {}).rows).toEqual([]);
    expect(runNamedQuery(bare, 'mem.native.categories', {}).rows).toEqual([]);
  });
});
