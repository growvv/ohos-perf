import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CallstackQuery } from '../src/query/callstack';
import { FrameQuery } from '../src/query/frames';
import { PerfQuery } from '../src/query/perf';
import { ProcessQuery } from '../src/query/process';
import { lookupQuery, queryDefinitions, type QueryContext } from '../src/query/registry';

/*
 * `symbol.stats`: the typed statistics table, queryable rather than only an
 * artifact. It is the same population the `symbols` analyzer reports, so a
 * drill-down from an evidence item lands on the rows that produced it.
 */

let dir: string;

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
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

/**
 * App pid 9000 owns thread 500. Weight: 5 on `dladdr` (file 2 serial 1),
 * 7 on `dladdr` again, 3 on an unresolved `libjdimage.so+0x1cce24`, and 4 on
 * a different process's thread (excluded). Total app weight 15.
 */
function symbolsDb(name: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES
    (0, 500, 9000, 'main'),
    (1, 502, 9001, 'other')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 500, 5, 1, 1000, 0, 'S'),
    (1, 10, 1100, 500, 7, 1, 1100, 0, 'S'),
    (2, 11, 1200, 500, 3, 1, 1200, 0, 'S'),
    (3, 12, 1300, 502, 4, 1, 1300, 0, 'S')`);
  d.exec(PERF_CALLCHAIN_DDL);
  d.exec(`INSERT INTO perf_callchain VALUES
    (0, 10, 0, 0, 0, 0, 2, 1, 488, 0, 0),
    (1, 11, 0, 0, 0, 0, 3, 9, 9800, 0, 0),
    (2, 12, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0)`);
  d.exec(PERF_FILES_DDL);
  d.exec(`INSERT INTO perf_files VALUES
    (0, 2, 0, 'dlopen', '/system/lib/ld-musl.so'),
    (1, 2, 1, 'dladdr', '/system/lib/ld-musl.so'),
    (2, 3, 0, 'JDImageLoad', '/lib/libjdimage.so')`);
  d.exec(DATA_DICT_DDL);
  d.exec(`INSERT INTO data_dict VALUES
    (488, 'start'),
    (9800, 'libjdimage.so+0x1cce24')`);
  d.close();
  return openDb(path);
}

function ctx(db: QueryHandle): QueryContext {
  return {
    db,
    perfDb: db,
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    callstacks: new CallstackQuery(db),
    perf: new PerfQuery(db),
    app: { packageName: 'com.demo', pids: [9000], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
  } as unknown as QueryContext;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-symbol-stats-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('symbol.stats', () => {
  it('is registered with a stable description and its two range arguments', () => {
    const definition = queryDefinitions().find((d) => d.name === 'symbol.stats');
    expect(definition).toBeDefined();
    expect(definition!.args.map((a) => a.name)).toEqual(['startNs', 'endNs']);
    expect(definition!.args.every((a) => a.required)).toBe(true);
    expect(definition!.returns).toContain('symbol');
  });

  it('returns rows ordered by weight, then symbol, then file, with a share of the window', () => {
    const db = symbolsDb('rows.db');
    try {
      const rows = lookupQuery('symbol.stats')!.run(ctx(db), {
        startNs: 0, endNs: Number.MAX_SAFE_INTEGER,
      });
      expect(rows).toEqual([
        {
          symbol: 'dladdr',
          filePath: '/system/lib/ld-musl.so',
          samples: 12,
          unresolved: false,
          share: 80,
        },
        {
          symbol: 'libjdimage.so+0x1cce24',
          filePath: '/lib/libjdimage.so',
          samples: 3,
          unresolved: true,
          share: 20,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('agrees with frame.load.symbols on the resolved rows', () => {
    const db = symbolsDb('agree.db');
    try {
      const args = { startNs: 0, endNs: Number.MAX_SAFE_INTEGER };
      const stats = lookupQuery('symbol.stats')!.run(ctx(db), args) as Array<{
        symbol: string; filePath: string; samples: number; share: number; unresolved: boolean;
      }>;
      const leaves = lookupQuery('frame.load.symbols')!.run(ctx(db), args) as Array<{
        symbol: string; filePath: string; samples: number; share: number; unresolved: boolean;
      }>;
      // The only difference is the unresolved row, which `frame.load.symbols`
      // now also carries; the two must not disagree on a resolved one.
      expect(stats.filter((row) => !row.unresolved)).toEqual(leaves.filter((row) => !row.unresolved));
    } finally {
      db.close();
    }
  });

  it('rejects an unknown argument', () => {
    expect(() => lookupQuery('symbol.stats')!.parseArgs({ startNs: 0, endNs: 1, nope: 2 }))
      .toThrow(expect.objectContaining({ code: 'QUERY_BAD_ARGS' }));
  });

  it('requires both ends of the range', () => {
    expect(() => lookupQuery('symbol.stats')!.parseArgs({ startNs: 0 }))
      .toThrow(expect.objectContaining({ code: 'QUERY_BAD_ARGS' }));
  });

  it('returns [] for an app with no threads', () => {
    const db = symbolsDb('empty-app.db');
    try {
      const empty = { ...ctx(db), app: { packageName: 'com.none', pids: [1], processNames: [] } };
      expect(lookupQuery('symbol.stats')!.run(empty as QueryContext, {
        startNs: 0, endNs: Number.MAX_SAFE_INTEGER,
      })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
