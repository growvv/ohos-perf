import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CallstackQuery } from '../src/query/callstack';
import { PerfQuery } from '../src/query/perf';

let dir: string;
let callstackDb: QueryHandle;
let perfDb: QueryHandle;

const CALLSTACK_DDL = `CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
  cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT,
  chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
  trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT)`;
const ARGS_DDL = 'CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT)';
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
  thread_name TEXT)`;
const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
  thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT,
  thread_state TEXT)`;
const PERF_CALLCHAIN_DDL = `CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT,
  ip INT, vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
  source_file_id INT, line_number INT)`;
const PERF_FILES_DDL = `CREATE TABLE perf_files(id INT, file_id INT, serial_id INT,
  symbol TEXT, path TEXT)`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-callstack-'));

  const cp = join(dir, 'callstack.db');
  const cd = new DatabaseSync(cp);
  cd.exec(CALLSTACK_DDL);
  cd.exec(`INSERT INTO callstack VALUES
    (0, 100, 5, 44, 'App', 'H:ProcessedNodes', 1, 9, 1, 5,
     'c1', 's1', 'p1', 'f', 'tl', 'tt', 'cc', 'ca', 3),
    (1, 200, NULL, 45, NULL, 'binder transaction', NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (2, 300, 7, 46, 'App', 'H:Animate [nodeSize]', 2, 0, 0, 7,
     '', '', '', '', '', '', '', '', 0)`);
  cd.exec(DATA_DICT_DDL);
  cd.exec(`INSERT INTO data_dict VALUES
    (1, 'transaction id'), (2, 'code'), (3, 'calling tid'), (4, 'extra'),
    (10, '0x10 Java Layer Dependent'), (11, 'hello'), (12, 'unused')`);
  cd.exec(ARGS_DDL);
  cd.exec(`INSERT INTO args VALUES
    (0, 1, 0, 123, 5),
    (1, 2, 1, 10, 5),
    (2, 3, 0, 10, 5),
    (3, 99, 0, 7, 5),
    (4, 4, 1, 77, 5),
    (5, 1, 0, 99, 7)`);
  cd.close();
  callstackDb = openDb(cp);

  const pp = join(dir, 'perf.db');
  const pd = new DatabaseSync(pp);
  pd.exec(PERF_THREAD_DDL);
  pd.exec(`INSERT INTO perf_thread VALUES
    (0, 100, 500, 'main'),
    (1, 101, 500, 'worker'),
    (2, 102, 600, 'other'),
    (3, 103, 600, NULL)`);
  pd.exec(PERF_SAMPLE_DDL);
  pd.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
    (1, 10, 1100, 100, 7, 1, 1100, 0, 'S'),
    (2, 11, 900, 101, 3, 1, 900, 1, 'S'),
    (3, NULL, 2000, 100, NULL, NULL, 2000, NULL, NULL),
    (4, NULL, 1200, 100, 9, 1, 1200, 0, 'S'),
    (5, 13, 5000, 102, 4, 1, 5000, 0, 'S'),
    (6, 13, 1200, 100, 2, 1, 1200, 0, 'S')`);
  pd.exec(PERF_CALLCHAIN_DDL);
  // Frames are inserted out of depth order; depth must be restored by SQL.
  pd.exec(`INSERT INTO perf_callchain VALUES
    (2, 10, 1, 0, 0, 0, 101, 99, 'raw1', 0, 0),
    (1, 10, 0, 0, 0, 0, 100, 7, 'raw0', 0, 0),
    (4, 10, 3, 0, 0, 0, 102, NULL, 'raw3', 0, 0),
    (3, 10, 2, 0, 0, 0, NULL, NULL, 'raw2', 0, 0),
    (5, 11, 0, 0, 0, 0, 101, 2, NULL, 0, 0),
    (6, 13, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0)`);
  pd.exec(PERF_FILES_DDL);
  pd.exec(`INSERT INTO perf_files VALUES
    (0, 100, 7, 'Foo()', '/lib/libfoo.so'),
    (1, 101, 1, 'Bar()', '/lib/libbar.so'),
    (2, 101, 2, 'Other()', '/lib/libbar2.so')`);
  pd.close();
  perfDb = openDb(pp);
});

afterAll(() => {
  callstackDb.close();
  perfDb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a throwaway trace db from raw SQL, for tests that need their own schema. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  build(d);
  d.close();
  return openDb(p);
}

describe('CallstackQuery', () => {
  it('maps camelCase fields and orders by ts, id', () => {
    const rows = new CallstackQuery(callstackDb).all();
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(rows[0]).toEqual({
      id: 0, ts: 100, dur: 5, callid: 44, cat: 'App',
      name: 'H:ProcessedNodes', depth: 1, cookie: 9, parentId: 1,
      argsetid: 5, chainId: 'c1', spanId: 's1', parentSpanId: 'p1',
      flag: 'f', traceLevel: 'tl', traceTag: 'tt', customCategory: 'cc',
      customArgs: 'ca', childCallid: 3,
    });
  });

  it('normalises NULL numerics to 0 and NULL text to empty string', () => {
    const row = new CallstackQuery(callstackDb).all().find((r) => r.id === 1);
    expect(row).toEqual({
      id: 1, ts: 200, dur: 0, callid: 45, cat: '', name: 'binder transaction',
      depth: 0, cookie: 0, parentId: 0, argsetid: 0, chainId: '', spanId: '',
      parentSpanId: '', flag: '', traceLevel: '', traceTag: '',
      customCategory: '', customArgs: '', childCallid: 0,
    });
  });

  it('applies an inclusive time range', () => {
    const q = new CallstackQuery(callstackDb);
    expect(q.all({ startNs: 100, endNs: 200 }).map((r) => r.id)).toEqual([0, 1]);
    expect(q.all({ startNs: 201, endNs: 299 })).toEqual([]);
  });

  it('matches a bound LIKE pattern and never interprets it as SQL', () => {
    const q = new CallstackQuery(callstackDb);
    expect(q.matching('%Processed%').map((r) => r.id)).toEqual([0]);
    expect(q.matching('binder%').map((r) => r.id)).toEqual([1]);
    // If the pattern were concatenated into SQL this would return every row.
    expect(q.matching("' OR 1=1 --")).toEqual([]);
  });

  it('applies range and limit to matching()', () => {
    const q = new CallstackQuery(callstackDb);
    expect(q.matching('%', { range: { startNs: 200, endNs: 200 } }).map((r) => r.id))
      .toEqual([1]);
    expect(q.matching('%', { limit: 1 }).map((r) => r.id)).toEqual([0]);
    expect(q.matching('%', { limit: 0 })).toEqual([]);
  });

  it('groups args per callstack row and resolves keys/values through data_dict', () => {
    const events = new CallstackQuery(callstackDb).withArgs();
    expect(events.map((e) => e.id)).toEqual([0, 1, 2]);
    // The key is always resolved through data_dict; value 10 is a dict id only
    // for `code` (datatype 1), while `calling tid` (datatype 0) stays numeric.
    // Key 99 has no data_dict row and is dropped, mirroring HapRay.
    expect(events[0].args).toEqual({
      'transaction id': 123,
      code: '0x10 Java Layer Dependent',
      'calling tid': 10,
      extra: 77,
    });
    expect(events[1].args).toEqual({});
    expect(events[2].args).toEqual({ 'transaction id': 99 });
  });

  it('applies a time range to withArgs() without losing the row shape', () => {
    const rows = new CallstackQuery(callstackDb).withArgs({ startNs: 300, endNs: 300 });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);
    expect(rows[0].name).toBe('H:Animate [nodeSize]');
    expect(rows[0].args).toEqual({ 'transaction id': 99 });
  });
});

describe('PerfQuery', () => {
  it('returns false/[] when the optional perf tables are absent', () => {
    const empty = withDb('perf-empty.db', () => {});
    try {
      const q = new PerfQuery(empty);
      expect(q.hasSamples()).toBe(false);
      expect(q.threads([500])).toEqual([]);
      expect(q.samples([100], { startNs: 0, endNs: 10_000 })).toEqual([]);
      expect(q.callchains([100], { startNs: 0, endNs: 10_000 })).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it('hasSamples() is true only when perf_sample has rows', () => {
    const emptySamples = withDb('perf-nosamples.db', (d) => {
      d.exec(PERF_SAMPLE_DDL);
    });
    try {
      expect(new PerfQuery(emptySamples).hasSamples()).toBe(false);
    } finally {
      emptySamples.close();
    }
    expect(new PerfQuery(perfDb).hasSamples()).toBe(true);
  });

  it('filters perf threads by process id, ordered by id', () => {
    const q = new PerfQuery(perfDb);
    expect(q.threads([500]).map((t) => t.id)).toEqual([0, 1]);
    expect(q.threads([600]).map((t) => t.id)).toEqual([2, 3]);
    expect(q.threads([500, 600]).map((t) => t.id)).toEqual([0, 1, 2, 3]);
    expect(q.threads([])).toEqual([]);
    expect(q.threads([600])[1]).toEqual({
      id: 3, threadId: 103, processId: 600, threadName: '',
    });
  });

  it('reads samples in an inclusive range, ordered by trace timestamp and id', () => {
    const q = new PerfQuery(perfDb);
    expect(q.samples([100], { startNs: 900, endNs: 1500 }).map((s) => s.id))
      .toEqual([0, 1, 4, 6]);
    expect(q.samples([100, 101], { startNs: 800, endNs: 1100 }).map((s) => s.id))
      .toEqual([2, 0, 1]);
    expect(q.samples([], { startNs: 0, endNs: 10_000 })).toEqual([]);
  });

  it('maps perf_sample columns and normalises NULLs', () => {
    const q = new PerfQuery(perfDb);
    expect(q.samples([100], { startNs: 1000, endNs: 1000 })[0]).toEqual({
      id: 0,
      callchainId: 10,
      timeStamp: 1000,
      threadId: 100,
      eventCount: 5,
      eventTypeId: 1,
      timestampTrace: 1000,
      cpuId: 0,
      threadState: 'S',
    });
    expect(q.samples([100], { startNs: 2000, endNs: 2000 })[0]).toEqual({
      id: 3,
      callchainId: 0,
      timeStamp: 2000,
      threadId: 100,
      eventCount: 0,
      eventTypeId: 0,
      timestampTrace: 2000,
      cpuId: 0,
      threadState: '',
    });
  });

  it('resolves callchains per thread, in depth order and chain-id order', () => {
    const chains = new PerfQuery(perfDb).callchains([100, 101], { startNs: 900, endNs: 1500 });
    expect(chains.map((c) => [c.threadId, c.callchainId])).toEqual([
      [100, 10],
      [100, 13],
      [101, 11],
    ]);
    expect(chains[0].functions).toEqual([
      { symbol: 'Foo()', name: 'Foo()', filePath: '/lib/libfoo.so' },
      { symbol: 'Bar()', name: 'Bar()', filePath: '/lib/libbar.so' },
      { symbol: 'raw2', name: 'raw2', filePath: '' },
      { symbol: 'raw3', name: 'raw3', filePath: '' },
    ]);
    // Exact (file_id, serial_id) lookup beats the file-only fallback.
    expect(chains[2].functions).toEqual([
      { symbol: 'Other()', name: 'Other()', filePath: '/lib/libbar2.so' },
    ]);
    // A frame with no file/symbol keeps an empty symbol rather than dropping.
    expect(chains[1].functions).toEqual([{ symbol: '', name: '', filePath: '' }]);
  });

  it('caps chains per thread with maxChainsPerThread', () => {
    const q = new PerfQuery(perfDb);
    expect(q.callchains([100, 101], { startNs: 900, endNs: 1500 }, 1).map((c) => c.callchainId))
      .toEqual([10, 11]);
  });

  it('returns [] when perf_callchain or perf_files is missing', () => {
    const noCallchain = withDb('perf-nocallchain.db', (d) => {
      d.exec(PERF_SAMPLE_DDL);
      d.exec(PERF_FILES_DDL);
      d.exec("INSERT INTO perf_sample VALUES (0, 10, 100, 100, 5, 1, 100, 0, 'S')");
    });
    const noFiles = withDb('perf-nofiles.db', (d) => {
      d.exec(PERF_SAMPLE_DDL);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec("INSERT INTO perf_sample VALUES (0, 10, 100, 100, 5, 1, 100, 0, 'S')");
      d.exec("INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 1, 1, 'raw', 0, 0)");
    });
    try {
      expect(new PerfQuery(noCallchain).callchains([100], { startNs: 0, endNs: 1000 })).toEqual([]);
      expect(new PerfQuery(noFiles).callchains([100], { startNs: 0, endNs: 1000 })).toEqual([]);
    } finally {
      noCallchain.close();
      noFiles.close();
    }
  });

  it('considers at most 50 chain ids per thread and returns 20 by default', () => {
    const many = withDb('perf-many.db', (d) => {
      d.exec(PERF_SAMPLE_DDL);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec(PERF_FILES_DDL);
      for (let i = 0; i < 55; i++) {
        const cid = 1000 + i;
        d.exec(`INSERT INTO perf_sample VALUES (${i}, ${cid}, ${1000 + i}, 900, 1, 1, ${1000 + i}, 0, 'S')`);
        d.exec(`INSERT INTO perf_callchain VALUES (${i}, ${cid}, 0, 0, 0, 0, NULL, NULL, 'f${cid}', 0, 0)`);
      }
    });
    try {
      const q = new PerfQuery(many);
      const range = { startNs: 0, endNs: 10_000 };
      const byDefault = q.callchains([900], range);
      expect(byDefault).toHaveLength(20);
      expect(byDefault[19].callchainId).toBe(1019);
      const all = q.callchains([900], range, 100);
      expect(all).toHaveLength(50);
      expect(all[49].callchainId).toBe(1049);
    } finally {
      many.close();
    }
  });
});

describe('real trace smoke', () => {
  const EMU_BIG = 'spike/out/emu_big.db';

  it.skipIf(!existsSync(EMU_BIG))('counts callstack rows in emu_big', () => {
    const real = openDb(EMU_BIG);
    try {
      expect(new CallstackQuery(real).all()).toHaveLength(35415);
    } finally {
      real.close();
    }
  });
});
