import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix, type CapabilityState } from '../src/device/capability';
import { OhosPerfError } from '../src/errors';
import {
  DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, lookupQuery, queryDefinitions,
  resolveQueryLimit, runNamedQuery, type QueryContext,
} from '../src/query/registry';

const START = 1_000_000_000;
const MS = 1_000_000;

let dir: string;
let db: QueryHandle;
let ctx: QueryContext;

const DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT);
  CREATE TABLE thread(id INT, tid INT, name TEXT, ipid INT);
  CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
    depth INT, cookie INT, parent_id INT, argsetid INT,
    chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
    trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT);
  CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT);
  CREATE TABLE data_dict(id INT, data TEXT);
  CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT);
`;

function seed(d: DatabaseSync): void {
  d.exec(DDL);
  d.exec(`
    INSERT INTO process VALUES (0, 100, 5000, 'com.demo'), (1, 200, 6000, 'render_service');
    INSERT INTO thread VALUES (10, 5000, 'main', 100), (20, 6001, 'RSThread', 200);
    INSERT INTO data_dict VALUES
      (1, 'transaction id'), (2, 'calling tid'), (3, 'code'),
      (4, 'destination process');
    INSERT INTO args VALUES
      (1, 1, 0, 1, 1), (2, 2, 0, 5000, 1), (3, 3, 1, 100, 1),
      (4, 1, 0, 1, 2), (5, 4, 0, 5000, 2), (6, 3, 1, 102, 2);
    INSERT INTO callstack VALUES
      (1, ${START}, 0, 10, 'binder', 'H:binder transaction', 0, 0, 0, 1,
       '', '', '', '', '', '', '', '', 0),
      (2, ${START + 2 * MS}, 0, 20, 'binder', 'H:binder reply', 0, 0, 0, 2,
       '', '', '', '', '', '', '', '', 0),
      (3, 150, 0, 10, 'graphic', 'H:VsyncCallBackListener', 0, 0, 0, 0,
       '', '', '', '', '', '', '', '', 0),
      (4, 250, 0, 20, 'graphic', 'H:Other', 0, 0, 0, 0,
       '', '', '', '', '', '', '', '', 0);
    INSERT INTO frame_slice VALUES
      (1, 100, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 1, 0, 1),
      (2, 200, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 0, 0, 2),
      (3, 300, 0, 17, 44, 0, 10, '', 0, 1, 'expect', 0, 0, 3);
  `);
}

function state(id: CapabilityState['id'], available: boolean): CapabilityState {
  return {
    id,
    available,
    collector: available ? 'hitrace' : undefined,
    fidelity: 'exact',
    ...(available ? {} : { reason: 'not supported' }),
    probe: { command: '', stdout: '', stderr: '', code: 0 },
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as OhosPerfError).code;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-registry-'));
  const path = join(dir, 't.db');
  const raw = new DatabaseSync(path);
  seed(raw);
  raw.close();
  db = openDb(path);
  ctx = {
    db,
    app: { packageName: 'com.demo', pids: [5000], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([state('trace.frames', true), state('perf.pmu', false)]),
  };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('queryDefinitions', () => {
  it('lists the seven registered names in sorted order', () => {
    expect(queryDefinitions().map((d) => d.name)).toEqual([
      'binder.processStats', 'callstack.matching', 'callstack.range', 'caps.get',
      'frames.all', 'frames.get', 'threads.pattern',
    ]);
  });

  it('pins the limit constants', () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(100);
    expect(MAX_QUERY_LIMIT).toBe(1000);
  });

  it('lookupQuery returns undefined for an unknown name', () => {
    expect(lookupQuery('nope')).toBeUndefined();
  });
});

describe('runNamedQuery', () => {
  it('returns one frame by id', () => {
    expect(runNamedQuery(ctx, 'frames.get', { id: 2 })).toEqual({
      query: 'frames.get',
      rows: [expect.objectContaining({ id: 2, frameNo: 2 })],
      total: 1,
      truncated: false,
    });
  });

  it('returns no rows for an absent frame id', () => {
    expect(runNamedQuery(ctx, 'frames.get', { id: 99 })).toEqual({
      query: 'frames.get', rows: [], total: 0, truncated: false,
    });
  });

  it('filters frames to the requested window, ordered by ts', () => {
    const r = runNamedQuery(ctx, 'frames.all', { window: { startNs: 150, endNs: 250 } });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([2]);
    expect(r.total).toBe(1);
  });

  it('counts every row before applying the limit', () => {
    const window = { startNs: 0, endNs: 1000 };
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 2 })).toMatchObject({
      total: 3, truncated: true,
    });
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 2 }).rows).toHaveLength(2);
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 3 }).truncated).toBe(false);
  });

  it('returns callstack rows inside a time range', () => {
    const r = runNamedQuery(ctx, 'callstack.range', { startNs: 100, endNs: 200 });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([3]);
  });

  it('matches callstack names through a bound LIKE pattern', () => {
    const r = runNamedQuery(ctx, 'callstack.matching', { pattern: 'H:binder%' });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([1, 2]);
  });

  it('reports capability states in the requested order, synthesizing unknown ids', () => {
    const r = runNamedQuery(ctx, 'caps.get', { ids: ['perf.pmu', 'trace.frames', 'ui.tree'] });
    expect(r.rows.map((row) => (row as CapabilityState).id))
      .toEqual(['perf.pmu', 'trace.frames', 'ui.tree']);
    expect((r.rows[2] as CapabilityState).reason).toBe('capability not probed');
    expect((r.rows[2] as CapabilityState).available).toBe(false);
  });

  it('returns the binder statistics for one process pair', () => {
    const r = runNamedQuery(ctx, 'binder.processStats',
      { callerProc: 'com.demo', calleeProc: 'render_service' });
    expect(r.rows).toEqual([{
      callerProc: 'com.demo', calleeProc: 'render_service', count: 1,
      avgLatency: 2, minLatency: 2, maxLatency: 2, qps: null, avgIntervalMs: null,
    }]);
  });

  it('returns no binder statistics without app pids', () => {
    const r = runNamedQuery({ ...ctx, app: { ...ctx.app, pids: [] } }, 'binder.processStats', {});
    expect(r.rows).toEqual([]);
  });

  it('returns no thread patterns without app pids', () => {
    const r = runNamedQuery({ ...ctx, app: { ...ctx.app, pids: [] } }, 'threads.pattern',
      { threadName: 'Worker' });
    expect(r.rows).toEqual([]);
  });

  it('is byte-identical across two runs', () => {
    const args = { window: { startNs: 0, endNs: 1000 } };
    expect(JSON.stringify(runNamedQuery(ctx, 'frames.all', args, { limit: 2 })))
      .toBe(JSON.stringify(runNamedQuery(ctx, 'frames.all', args, { limit: 2 })));
  });

  it('names the available queries for an unknown name', () => {
    expect(codeOf(() => runNamedQuery(ctx, 'nope', {}))).toBe('QUERY_UNKNOWN');
    try {
      runNamedQuery(ctx, 'nope', {});
    } catch (err) {
      expect((err as OhosPerfError).message).toContain('available:');
      expect((err as OhosPerfError).message).toContain('frames.get');
    }
  });

  it('rejects wrong argument types with QUERY_BAD_ARGS', () => {
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', {}))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', { id: '2' }))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.all', { window: { startNs: 1 } })))
      .toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'caps.get', { ids: 'x' }))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', { id: 1, extra: true })))
      .toBe('QUERY_BAD_ARGS');
  });

  it('rejects an out-of-range limit with QUERY_BAD_LIMIT', () => {
    for (const limit of [0, -1, 1.5, MAX_QUERY_LIMIT + 1]) {
      expect(() => resolveQueryLimit(limit)).toThrowError(/between 1 and 1000/);
      expect(codeOf(() => resolveQueryLimit(limit))).toBe('QUERY_BAD_LIMIT');
    }
    expect(resolveQueryLimit(undefined)).toBe(DEFAULT_QUERY_LIMIT);
    expect(resolveQueryLimit(MAX_QUERY_LIMIT)).toBe(MAX_QUERY_LIMIT);
  });
});
