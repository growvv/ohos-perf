import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { BinderAnalyzer, computeBinderAnalysis } from '../src/analyze/binder';
import type { AnalyzeContext } from '../src/analyze/types';

const START = 1_000_000_000;
const MS = 1_000_000;

let dir: string;
let db: QueryHandle;
let singleDir: string;
let singleDb: QueryHandle;

const DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT);
  CREATE TABLE thread(id INT, tid INT, name TEXT, ipid INT);
  CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
    argsetid INT);
  CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT);
  CREATE TABLE data_dict(id INT, data TEXT);
`;

/**
 * Two completed transactions (1 and 2), five transaction groups in total.
 *
 * - txn 1: `H:binder transaction` + `H:binder reply` -> 2 ms; both sides carry
 *   a code, pinning caller-arg precedence in the interface aggregation;
 * - txn 2: `H:binder transaction async` + `H:binder async rcv` -> 1 ms; the
 *   interface code exists only on the callee args, so the callee fallback is
 *   exercised too;
 * - txn 3: request-only orphan whose `callid` is unknown, kept only through the
 *   `calling tid` filter;
 * - a request with no `transaction id`: loaded but never paired;
 * - txn 4: one event containing both `binder reply` and `binder transaction`,
 *   so response-wins puts it in `responseTs`, never `requestTs`;
 * - txn 5: reply with an unknown `callid`, kept only because its
 *   `destination process` is an app pid, which also drives the callee fallback.
 */
function seed(d: DatabaseSync): void {
  d.exec(DDL);
  d.exec(`
    INSERT INTO process VALUES
      (0, 100, 5000, 'com.demo'),
      (1, 200, 6000, 'render_service');
    INSERT INTO thread VALUES
      (10, 5000, 'main', 100),
      (20, 6001, 'RSThread', 200);
    INSERT INTO data_dict VALUES
      (1, 'transaction id'), (2, 'calling tid'), (3, 'code'),
      (4, 'destination process'), (5, 'destination thread'),
      (100, '0x0 Java Layer Dependent'), (101, '0x1 Other'),
      (102, '0x2 Callee Code');
    INSERT INTO args VALUES
      (1, 1, 0, 1, 1), (2, 2, 0, 5000, 1), (3, 3, 1, 100, 1),
      (4, 1, 0, 1, 2), (5, 4, 0, 5000, 2), (17, 3, 1, 102, 2),
      (6, 1, 0, 2, 3), (7, 2, 0, 5000, 3),
      (8, 1, 0, 2, 4), (9, 4, 0, 5000, 4), (10, 3, 1, 101, 4),
      (11, 1, 0, 3, 5), (12, 2, 0, 5000, 5),
      (13, 2, 0, 5000, 6),
      (14, 1, 0, 4, 7),
      (15, 1, 0, 5, 8), (16, 4, 0, 5000, 8);
    INSERT INTO callstack VALUES
      (1, ${START}, 0, 10, 'binder', 'H:binder transaction', 1),
      (2, ${START + 2 * MS}, 0, 20, 'binder', 'H:binder reply', 2),
      (3, ${START + 3 * MS}, 0, 10, 'binder', 'H:binder transaction async', 3),
      (4, ${START + 4 * MS}, 0, 20, 'binder', 'H:binder async rcv', 4),
      (5, ${START + 5 * MS}, 0, 999, 'binder', 'H:binder transaction', 5),
      (6, ${START + 6 * MS}, 0, 10, 'binder', 'H:binder transaction', 6),
      (7, ${START + 7 * MS}, 0, 10, 'binder',
       'H:binder reply after binder transaction', 7),
      (8, ${START + 8 * MS}, 0, 999, 'binder', 'H:binder reply', 8);
  `);
}

/**
 * One completed pair only: with a single request timestamp the process stat's
 * `qps`/`avgIntervalMs` must stay `null`, which pins the evidence rule that a
 * null rate is omitted from `signals` rather than emitted.
 */
function seedSinglePair(d: DatabaseSync): void {
  d.exec(DDL);
  d.exec(`
    INSERT INTO process VALUES
      (0, 100, 5000, 'com.demo'),
      (1, 200, 6000, 'render_service');
    INSERT INTO thread VALUES
      (10, 5000, 'main', 100),
      (20, 6001, 'RSThread', 200);
    INSERT INTO data_dict VALUES
      (1, 'transaction id'), (2, 'calling tid'), (4, 'destination process');
    INSERT INTO args VALUES
      (1, 1, 0, 7, 1), (2, 2, 0, 5000, 1),
      (3, 1, 0, 7, 2), (4, 4, 0, 5000, 2);
    INSERT INTO callstack VALUES
      (1, ${START}, 0, 10, 'binder', 'H:binder transaction', 1),
      (2, ${START + MS}, 0, 20, 'binder', 'H:binder reply', 2);
  `);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-binder-main-'));
  const path = join(dir, 't.db');
  const d = new DatabaseSync(path);
  seed(d);
  d.close();
  db = openDb(path);

  singleDir = mkdtempSync(join(tmpdir(), 'ohosperf-binder-single-'));
  const singlePath = join(singleDir, 't.db');
  const s = new DatabaseSync(singlePath);
  seedSinglePair(s);
  s.close();
  singleDb = openDb(singlePath);
});

afterAll(() => {
  db.close();
  singleDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(singleDir, { recursive: true, force: true });
});

const NULL_ENDPOINT = {
  pid: null,
  tid: null,
  procName: null,
  threadName: null,
};

function makeCtx(
  opts: {
    deviceId?: string;
    withDb?: boolean;
    pids?: number[];
    handle?: QueryHandle;
  } = {},
): AnalyzeContext {
  const {
    deviceId = 'emu-binder',
    withDb = true,
    pids = [5000],
    handle = db,
  } = opts;
  return {
    frames: new FrameQuery(handle),
    processes: new ProcessQuery(handle),
    ...(withDb ? { db: handle } : {}),
    app: { packageName: 'com.demo', pids, processNames: ['com.demo'] },
    window: { startNs: START, endNs: START + 9 * MS },
    caps: new CapabilityMatrix([
      {
        id: 'trace.binder',
        available: true,
        fidelity: 'exact',
        probe: { command: 'probe', stdout: '', stderr: '', code: 0 },
      },
    ]),
    deviceId,
  };
}

describe('computeBinderAnalysis', () => {
  it('pairs requests with responses and keeps unpaired transactions latency-free', () => {
    const analysis = computeBinderAnalysis(db, { appPids: [5000] });
    const byTxn = new Map(
      analysis.transactions.map((tx) => [String(tx.transactionId), tx]),
    );

    // Null requestTs sorts first, then the three request-bearing transactions.
    expect(analysis.transactions.map((tx) => tx.transactionId)).toEqual([4, 5, 1, 2, 3]);

    expect(byTxn.get('1')).toEqual({
      transactionId: 1,
      caller: { pid: 5000, tid: 5000, procName: 'com.demo', threadName: 'main' },
      callee: {
        pid: 6000,
        tid: 6001,
        procName: 'render_service',
        threadName: 'RSThread',
      },
      requestTs: START,
      responseTs: START + 2 * MS,
      latencyMs: 2,
    });

    // The async keywords classify the same as the plain names.
    expect(byTxn.get('2')).toMatchObject({
      caller: { pid: 5000, tid: 5000, procName: 'com.demo', threadName: 'main' },
      callee: { pid: 6000, tid: 6001, procName: 'render_service' },
      requestTs: START + 3 * MS,
      responseTs: START + 4 * MS,
      latencyMs: 1,
    });

    // Orphan request: resolved through `calling tid`, no response.
    expect(byTxn.get('3')).toEqual({
      transactionId: 3,
      caller: { pid: 5000, tid: 5000, procName: 'com.demo', threadName: 'main' },
      callee: NULL_ENDPOINT,
      requestTs: START + 5 * MS,
      responseTs: null,
      latencyMs: null,
    });

    // Response wins when the name contains both keyword sets.
    expect(byTxn.get('4')).toMatchObject({
      caller: NULL_ENDPOINT,
      callee: { pid: 5000, tid: 5000, procName: 'com.demo', threadName: 'main' },
      requestTs: null,
      responseTs: START + 7 * MS,
      latencyMs: null,
    });

    // Kept only through `destination process`; the fallback names the callee.
    expect(byTxn.get('5')).toEqual({
      transactionId: 5,
      caller: NULL_ENDPOINT,
      callee: {
        pid: 5000,
        tid: null,
        procName: 'com.demo',
        threadName: null,
      },
      requestTs: null,
      responseTs: START + 8 * MS,
      latencyMs: null,
    });

    // The event without a `transaction id` never becomes a transaction.
    expect(analysis.transactions).toHaveLength(5);
  });

  it('aggregates only completed pairs, with no orphan in any count or mean', () => {
    const analysis = computeBinderAnalysis(db, { appPids: [5000] });

    expect(analysis.processStats).toHaveLength(1);
    const process = analysis.processStats[0];
    expect(process).toMatchObject({
      callerProc: 'com.demo',
      calleeProc: 'render_service',
      count: 2,
      avgLatency: 1.5,
      minLatency: 1,
      maxLatency: 2,
      avgIntervalMs: 3,
    });
    // Request timestamps are START and START+3ms: 2 / 0.003 s.
    expect(process.qps).toBeCloseTo(2 / 0.003, 9);

    expect(analysis.threadStats).toHaveLength(1);
    expect(analysis.threadStats[0]).toMatchObject({
      callerProc: 'com.demo',
      callerTid: 5000,
      callerThreadName: 'main',
      calleeProc: 'render_service',
      calleeTid: 6001,
      calleeThreadName: 'RSThread',
      count: 2,
      avgLatency: 1.5,
      minLatency: 1,
      maxLatency: 2,
      avgIntervalMs: 3,
    });
    expect(analysis.threadStats[0].qps).toBeCloseTo(2 / 0.003, 9);

    // txn 1 has a caller code (0x0) and a different callee code (0x2): the
    // caller wins. txn 2 has only a callee code. Integer codes render as
    // lowercase hex.
    expect(analysis.interfaceStats).toEqual([
      {
        code: '0x0',
        count: 1,
        avgLatency: 2,
        minLatency: 2,
        maxLatency: 2,
        qps: null,
        avgIntervalMs: null,
        topCallerProc: 'com.demo',
        topCalleeProc: 'render_service',
        callerProcVariety: 1,
        calleeProcVariety: 1,
      },
      {
        code: '0x1',
        count: 1,
        avgLatency: 1,
        minLatency: 1,
        maxLatency: 1,
        qps: null,
        avgIntervalMs: null,
        topCallerProc: 'com.demo',
        topCalleeProc: 'render_service',
        callerProcVariety: 1,
        calleeProcVariety: 1,
      },
    ]);
  });

  it('returns empty arrays for empty app pids without throwing', () => {
    expect(computeBinderAnalysis(db, { appPids: [] })).toEqual({
      transactions: [],
      processStats: [],
      threadStats: [],
      interfaceStats: [],
    });
  });

  it('never reports latency when every kept transaction is an orphan', () => {
    // Only render_service thread ids are relevant, so both replies stay but
    // their requests are filtered out.
    const analysis = computeBinderAnalysis(db, { appPids: [6000] });
    expect(analysis.transactions.map((tx) => tx.transactionId)).toEqual([1, 2]);
    expect(analysis.transactions.every((tx) => tx.latencyMs === null)).toBe(true);
    expect(analysis.processStats).toEqual([]);
    expect(analysis.threadStats).toEqual([]);
    expect(analysis.interfaceStats).toEqual([]);
  });
});

describe('BinderAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new BinderAnalyzer();
    expect(analyzer.id).toBe('binder');
    expect(analyzer.requires).toEqual(['trace.binder']);
  });

  it('emits the six binder metrics when at least one pair completed', async () => {
    const result = await new BinderAnalyzer().run(makeCtx());
    const byId = new Map(result.metrics.map((m) => [m.id, m]));

    expect([...byId.keys()]).toEqual([
      'binder.interfaces.count',
      'binder.latency.avg',
      'binder.latency.max',
      'binder.process.pairs',
      'binder.thread.pairs',
      'binder.transactions.count',
    ]);

    expect(byId.get('binder.transactions.count')).toMatchObject({
      value: 5,
      unit: 'count',
    });
    expect(byId.get('binder.latency.avg')).toMatchObject({ value: 1.5, unit: 'ms' });
    expect(byId.get('binder.latency.max')).toMatchObject({ value: 2, unit: 'ms' });
    expect(byId.get('binder.process.pairs')).toMatchObject({ value: 1, unit: 'count' });
    expect(byId.get('binder.thread.pairs')).toMatchObject({ value: 1, unit: 'count' });
    expect(byId.get('binder.interfaces.count')).toMatchObject({ value: 2, unit: 'count' });

    for (const m of result.metrics) {
      expect(m.fidelity).toBe('exact');
      expect(m.provenance).toEqual({
        collector: 'hitrace+streamer',
        table: 'callstack',
        device: 'emu-binder',
      });
    }
  });

  it('emits one binder_hotspot for the hottest process pair', async () => {
    const result = await new BinderAnalyzer().run(makeCtx());
    expect(result.evidence).toHaveLength(1);

    const [hotspot] = result.evidence;
    expect(hotspot.kind).toBe('binder_hotspot');
    expect(hotspot.severity).toBe('info');
    expect(hotspot.subject).toEqual({ process: 'com.demo' });
    expect(hotspot.window).toEqual({ startNs: START, endNs: START + 9 * MS });
    expect(hotspot.signals).toMatchObject({
      calleeProc: 'render_service',
      count: 2,
      avgLatencyMs: 1.5,
      maxLatencyMs: 2,
    });
    expect(hotspot.signals.qps).toBeCloseTo(2 / 0.003, 9);
    // Evidence signals are never null: undefined measurements are omitted.
    expect(Object.values(hotspot.signals)).not.toContain(null);
    expect(hotspot.drillDown).toEqual([
      {
        label: 'Binder process pair',
        tool: 'binder.processStats',
        args: { callerProc: 'com.demo', calleeProc: 'render_service' },
        returns: 'BinderProcessStat',
      },
    ]);
    // The pair key is hash material only; it is not part of the object.
    expect('key' in hotspot).toBe(false);
  });

  it('omits a null qps signal instead of emitting null or zero', async () => {
    // One completed pair means one request timestamp, so the stat's qps is
    // genuinely null; the evidence must drop the key instead of carrying it.
    const analysis = computeBinderAnalysis(singleDb, { appPids: [5000] });
    expect(analysis.processStats).toHaveLength(1);
    expect(analysis.processStats[0].qps).toBeNull();
    expect(analysis.processStats[0].avgIntervalMs).toBeNull();

    const result = await new BinderAnalyzer().run(makeCtx({ handle: singleDb }));
    expect(result.evidence).toHaveLength(1);
    const [hotspot] = result.evidence;
    expect(hotspot.kind).toBe('binder_hotspot');
    expect(hotspot.signals).toEqual({
      calleeProc: 'render_service',
      count: 1,
      avgLatencyMs: 1,
      maxLatencyMs: 1,
    });
    expect('qps' in hotspot.signals).toBe(false);
    expect(Object.values(hotspot.signals)).not.toContain(null);
  });

  it('returns one no_data evidence and no metrics without ctx.db', async () => {
    const result = await new BinderAnalyzer().run(makeCtx({ withDb: false }));
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [e] = result.evidence;
    expect(e.kind).toBe('no_data');
    expect(e.severity).toBe('info');
    expect(e.subject.process).toBe('com.demo');
    expect(e.explain).toMatch(/ctx\.db/);
    expect(e.explain).toMatch(/binder/i);
  });

  it('emits only the orphan count plus no_data when nothing can be paired', async () => {
    const result = await new BinderAnalyzer().run(makeCtx({ pids: [6000] }));
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]).toMatchObject({
      id: 'binder.transactions.count',
      value: 2,
      unit: 'count',
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('no_data');
    expect(result.evidence[0].explain).toMatch(/pair/i);
  });

  it('returns zero metrics and one no_data naming the app pid when it is unidentified', async () => {
    const result = await new BinderAnalyzer().run(makeCtx({ pids: [] }));
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [e] = result.evidence;
    expect(e.kind).toBe('no_data');
    expect(e.explain).toMatch(/no app pid/);
    expect(e.explain).toMatch(/binder analysis skipped/i);
  });
});
