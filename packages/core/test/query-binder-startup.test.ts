import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { BinderQuery } from '../src/query/binder';
import { StartupQuery } from '../src/query/startup';
import { ProcessQuery } from '../src/query/process';

let dir: string;
let binderDb: QueryHandle;

const CALLSTACK_DDL = `CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
  cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT,
  chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
  trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT)`;
const ARGS_DDL = 'CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT)';
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';
const STARTUP_DDL = `CREATE TABLE app_startup(id INT, call_id INT, ipid INT, tid INT,
  start_time INT, end_time INT, start_name INT, packed_name TEXT)`;
const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-binder-'));
  const p = join(dir, 'binder.db');
  const d = new DatabaseSync(p);
  d.exec(CALLSTACK_DDL);
  d.exec(`INSERT INTO callstack VALUES
    (0, 300, 10, 44, 'binder', 'binder transaction', 0, 0, 0, 5,
     '', '', '', '', '', '', '', '', 0),
    (1, 100, NULL, NULL, NULL, 'binder reply', NULL, NULL, NULL, 6,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    (2, 200, 20, 46, 'App', 'H:ProcessedNodes', 0, 0, 0, 8,
     '', '', '', '', '', '', '', '', 0),
    (3, 50, 5, 47, 'binder', 'binder async rcv', 0, 0, 0, 7,
     '', '', '', '', '', '', '', '', 0),
    (4, 400, NULL, 48, 'binder', 'binder transaction', NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`);
  d.exec(DATA_DICT_DDL);
  d.exec(`INSERT INTO data_dict VALUES
    (1, 'transaction id'), (2, 'code'), (3, 'calling tid'),
    (10, '0x10 Java Layer Dependent'), (11, 'hello world'),
    (12, '0xZZ bad code'), (13, 'ignored')`);
  d.exec(ARGS_DDL);
  d.exec(`INSERT INTO args VALUES
    (0, 1, 0, 100, 5),
    (1, 2, 1, 10, 5),
    (2, 3, 1, 11, 5),
    (3, 2, 0, 10, 6),
    (4, 99, 0, 1, 6),
    (5, 2, 1, 12, 7)`);
  d.close();
  binderDb = openDb(p);
});

afterAll(() => { binderDb.close(); rmSync(dir, { recursive: true, force: true }); });

/** Builds a throwaway trace db from raw SQL, for tests that need their own schema. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  build(d);
  d.close();
  return openDb(p);
}

describe('BinderQuery.events', () => {
  it('returns only binder callstacks, ordered by id', () => {
    const events = new BinderQuery(binderDb).events();
    expect(events.map((e) => e.id)).toEqual([0, 1, 3, 4]);
    expect(events.map((e) => e.name)).toEqual([
      'binder transaction', 'binder reply', 'binder async rcv', 'binder transaction',
    ]);
  });

  it('resolves args through data_dict and parses code as hex', () => {
    const event = new BinderQuery(binderDb).events()[0];
    expect(event).toEqual({
      id: 0,
      ts: 300,
      dur: 10,
      name: 'binder transaction',
      cat: 'binder',
      callid: 44,
      args: {
        'transaction id': 100,
        code: 16,
        'calling tid': 'hello world',
      },
    });
  });

  it('resolves a value through data_dict only when datatype = 1', () => {
    // Event 1 has `code` with datatype 0 and value 10: it must stay 10.
    expect(new BinderQuery(binderDb).events()[1].args).toEqual({ code: 10 });
  });

  it('keeps the raw code string when the hex prefix does not parse', () => {
    expect(new BinderQuery(binderDb).events()[2].args).toEqual({ code: '0xZZ bad code' });
  });

  it('drops keys absent from data_dict and normalises a NULL argset', () => {
    const events = new BinderQuery(binderDb).events();
    // Key 99 has no data_dict row, so event 1 keeps only `code` (pinned above).
    expect(events[3].args).toEqual({});
    expect(events[3].dur).toBe(0);
    expect(events[3].cat).toBe('binder');
  });
});

describe('StartupQuery', () => {
  let startup: QueryHandle;

  beforeAll(() => {
    startup = withDb('startup.db', (d) => {
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 5, 44, 2000, 2500, 7, 'packed'),
        (1, 2, 5, 45, 1000, 1500, NULL, NULL),
        (2, 3, 6, 46, 3000, 3500, 9, 'other')`);
    });
  });

  afterAll(() => { startup.close(); });

  it('maps camelCase fields, ordered by start_time then id', () => {
    const rows = new StartupQuery(startup).all();
    expect(rows.map((r) => r.id)).toEqual([1, 0, 2]);
    expect(rows[1]).toEqual({
      id: 0, callId: 1, ipid: 5, tid: 44, startTime: 2000, endTime: 2500,
      startName: 7, packedName: 'packed',
    });
    expect(rows[0]).toEqual({
      id: 1, callId: 2, ipid: 5, tid: 45, startTime: 1000, endTime: 1500,
      startName: 0, packedName: '',
    });
  });

  it('applies an inclusive start_time range', () => {
    expect(new StartupQuery(startup).all({ startNs: 1000, endNs: 2000 }).map((r) => r.id))
      .toEqual([1, 0]);
    expect(new StartupQuery(startup).all({ startNs: 2001, endNs: 2999 })).toEqual([]);
  });

  it('filters by ipid and handles an empty list', () => {
    const q = new StartupQuery(startup);
    expect(q.forIpids([5]).map((r) => r.id)).toEqual([1, 0]);
    expect(q.forIpids([6]).map((r) => r.id)).toEqual([2]);
    expect(q.forIpids([])).toEqual([]);
  });

  it('returns [] when app_startup is absent', () => {
    const absent = withDb('startup-absent.db', () => {});
    try {
      expect(new StartupQuery(absent).all()).toEqual([]);
      expect(new StartupQuery(absent).forIpids([5])).toEqual([]);
    } finally {
      absent.close();
    }
  });
});

describe('ProcessQuery.byPid', () => {
  it('resolves duplicate pids to the lowest id and returns undefined for unknown', () => {
    const procs = withDb('process-pid.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES
        (5, 18, 300, 'later', NULL, 0, 1, 0, 0),
        (2, 19, 300, 'first', NULL, 0, 1, 0, 0),
        (3, 20, 400, 'other', NULL, 0, 1, 0, 0)`);
    });
    try {
      const q = new ProcessQuery(procs);
      expect(q.byPid(300)?.name).toBe('first');
      expect(q.byPid(300)?.id).toBe(2);
      expect(q.byPid(400)?.name).toBe('other');
      expect(q.byPid(999)).toBeUndefined();
    } finally {
      procs.close();
    }
  });
});

describe('real trace smoke', () => {
  const EMU_BIG = 'spike/out/emu_big.db';

  it.skipIf(!existsSync(EMU_BIG))('counts binder events in emu_big', () => {
    const real = openDb(EMU_BIG);
    try {
      expect(new BinderQuery(real).events()).toHaveLength(3583);
    } finally {
      real.close();
    }
  });
});
