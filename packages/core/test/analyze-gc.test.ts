import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { CallstackQuery } from '../src/query/callstack';
import { FrameQuery } from '../src/query/frames';
import { PerfQuery } from '../src/query/perf';
import { ProcessQuery } from '../src/query/process';
import { GcAnalyzer } from '../src/analyze/gc';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

let dir: string;
let db: QueryHandle;
let emptyPerf: QueryHandle;

const CALLSTACK_DDL = `CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT,
  cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT,
  chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
  trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT)`;
const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT,
  type_desc TEXT, flag INT, depth INT, frame_no INT)`;
const PERF_DDL = [
  'CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT, thread_name TEXT)',
  `CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT, thread_id INT,
    event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT, thread_state TEXT)`,
  `CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT, ip INT,
    vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
    source_file_id INT, line_number INT)`,
  'CREATE TABLE perf_files(id INT, file_id INT, serial_id INT, symbol TEXT, path TEXT)',
];

const PARTIAL = 'H:PartialGC::RunPhases0;GCReason12;MarkReason0;M47';
const FULL = 'H:FullGC::RunPhases0;GCReason1;M47';

/** One `callstack` row, with the columns this test cares about filled in. */
function gcRow(id: number, ts: number, name: string, callid: number): string {
  return `(${id}, ${ts}, 1000, ${callid}, 'App', '${name}', 1, 0, 0, 0,
    '', '', '', '', '', '', '', '', 0)`;
}

/** A capability matrix where every capability this analyzer needs is present. */
function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'trace.ark', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxFor(
  target: QueryHandle,
  opts: { pids?: number[]; perf?: QueryHandle; packageName?: string } = {},
): AnalyzeContext {
  const packageName = opts.packageName ?? 'com.demo';
  return {
    db: target,
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    callstacks: new CallstackQuery(target),
    perf: new PerfQuery(opts.perf ?? target),
    app: { packageName, pids: opts.pids ?? [4999], processNames: [packageName] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: fullCaps(),
    deviceId: 'offline',
  };
}

function metric(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-gc-'));
  const p = join(dir, 'trace.db');
  const d = new DatabaseSync(p);
  d.exec(CALLSTACK_DDL);
  d.exec(FRAME_DDL);
  d.exec('CREATE TABLE thread(id INT, itid INT, ipid INT, name TEXT)');
  d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
    start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0),
    (1, 18, 5000, 'other.app', 0, 0, 1, 0, 0)`);
  d.exec(`INSERT INTO thread VALUES (44, 44, 17, 'main'), (45, 45, 18, 'w')`);
  // App (ipid 17, callid 44): 2 PartialGC + 1 FullGC. Other (ipid 18): 1.
  // The span runs 1e9..3e9 = 2s, so 3 invocations is 1.5/s and not > 10.
  d.exec(`INSERT INTO callstack VALUES
    ${gcRow(0, 1_000_000_000, PARTIAL, 44)},
    ${gcRow(1, 1_500_000_000, PARTIAL, 44)},
    ${gcRow(2, 2_000_000_000, FULL, 44)},
    ${gcRow(3, 3_000_000_000, PARTIAL, 45)}`);
  d.close();
  db = openDb(p);

  const ep = join(dir, 'empty-perf.db');
  const ed = new DatabaseSync(ep);
  for (const sql of PERF_DDL) ed.exec(sql);
  ed.close();
  emptyPerf = openDb(ep);
});

afterAll(() => {
  db.close();
  emptyPerf.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GcAnalyzer', () => {
  it('counts each GC type for the app only, over the whole callstack span', async () => {
    const r = await new GcAnalyzer().run(ctxFor(db));
    expect(metric(r, 'gc.partial.count').value).toBe(2);
    expect(metric(r, 'gc.full.count').value).toBe(1);
    expect(metric(r, 'gc.invocations.count').value).toBe(3);
    expect(metric(r, 'gc.rate').value).toBeCloseTo(1.5, 6);
    expect(r.evidence.filter((e) => e.kind === 'gc_pressure')[0].severity).toBe('info');
  });

  it('divides by the whole callstack span, not the app’s own window', async () => {
    // The app's three GCs all sit inside 1e9..2e9, but the other process's row
    // at 3e9 defines the table span. A rate over the app's own 1s would be 3.0.
    const r = await new GcAnalyzer().run(ctxFor(db));
    expect(metric(r, 'gc.rate').value).toBeCloseTo(1.5, 6);
  });

  it('reports GC pressure when the app both exceeds 10 invocations and 1/s', async () => {
    const p = join(dir, 'many-gc.db');
    const d = new DatabaseSync(p);
    d.exec(CALLSTACK_DDL);
    d.exec('CREATE TABLE thread(id INT, itid INT, ipid INT, name TEXT)');
    d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
      start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
    d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
    d.exec(`INSERT INTO thread VALUES (44, 44, 17, 'main')`);
    // 12 PartialGC spread over 2s: 12 > 10 and 12 > 2.
    const rows = Array.from({ length: 12 }, (_, i) =>
      gcRow(i, 1_000_000_000 + i * 150_000_000, PARTIAL, 44)).join(',');
    d.exec(`INSERT INTO callstack VALUES ${rows},
      ${gcRow(12, 3_000_000_000, PARTIAL, 44)}`);
    d.close();
    const many = openDb(p);
    try {
      const r = await new GcAnalyzer().run(ctxFor(many));
      expect(metric(r, 'gc.invocations.count').value).toBe(13);
      expect(r.evidence.filter((e) => e.kind === 'gc_pressure')[0].severity).toBe('warn');
    } finally {
      many.close();
    }
  });

  it('reports GC pressure when the GC thread carries more than 15% of app samples', async () => {
    // HapRay's second clause: `perf_percentage > 0.15` sets `GCStatus` to
    // "Too many GC" regardless of the invocation count. Two invocations over a
    // 2 s span are well under the count rule, so only the share can fire it.
    const p = join(dir, 'share.db');
    const d = new DatabaseSync(p);
    d.exec(CALLSTACK_DDL);
    d.exec('CREATE TABLE thread(id INT, itid INT, ipid INT, name TEXT)');
    d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
      start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
    d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
    d.exec(`INSERT INTO thread VALUES (44, 44, 17, 'main')`);
    d.exec(`INSERT INTO callstack VALUES
      ${gcRow(0, 1_000_000_000, PARTIAL, 44)},
      ${gcRow(1, 3_000_000_000, PARTIAL, 44)}`);
    d.close();
    const trace = openDb(p);

    const pp = join(dir, 'share-perf.db');
    const pd = new DatabaseSync(pp);
    for (const sql of PERF_DDL) pd.exec(sql);
    pd.exec(`INSERT INTO perf_thread VALUES (0, 500, 4999, 'main'),
      (1, 501, 4999, 'OS_GC_Thread')`);
    // GC thread holds 30 of the app's 100 samples: 30%, above the 15% rule.
    pd.exec(`INSERT INTO perf_sample VALUES
      (0, NULL, 1000, 501, 30, 1, 1000, 0, 'S'),
      (1, NULL, 1100, 500, 70, 1, 1100, 0, 'S')`);
    pd.close();
    const perf = openDb(pp);
    try {
      const r = await new GcAnalyzer().run(ctxFor(trace, { perf }));
      const item = r.evidence.find((e) => e.kind === 'gc_pressure')!;
      expect(item.severity).toBe('warn');
      expect(item.explain).toContain('perf share');
      expect(metric(r, 'gc.perf.share').value).toBeCloseTo(30, 6);
    } finally {
      perf.close();
      trace.close();
    }
  });

  it('omits gc.rate when the callstack span is zero instead of reporting an exact 0', async () => {
    // One callstack row makes `max(ts) - min(ts)` zero, so the rate has no
    // denominator. `empty-frame` omits its rate in the same situation.
    const p = join(dir, 'single-row.db');
    const d = new DatabaseSync(p);
    d.exec(CALLSTACK_DDL);
    d.exec('CREATE TABLE thread(id INT, itid INT, ipid INT, name TEXT)');
    d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
      start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
    d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
    d.exec(`INSERT INTO thread VALUES (44, 44, 17, 'main')`);
    d.exec(`INSERT INTO callstack VALUES ${gcRow(0, 1_000_000_000, PARTIAL, 44)}`);
    d.close();
    const single = openDb(p);
    try {
      const r = await new GcAnalyzer().run(ctxFor(single));
      expect(metric(r, 'gc.invocations.count').value).toBe(1);
      expect(r.metrics.map((m) => m.id)).not.toContain('gc.rate');
    } finally {
      single.close();
    }
  });

  it('degrades the perf share instead of reporting 0% when there are no samples', async () => {
    const r = await new GcAnalyzer().run(ctxFor(db, { perf: emptyPerf }));
    expect(r.metrics.map((m) => m.id)).not.toContain('gc.perf.share');
    expect(metric(r, 'gc.perf.degraded').fidelity).toBe('proxy');
    expect(metric(r, 'gc.perf.degraded').degraded?.reason).toContain('perf_sample');
  });

  it('degrades rather than reporting zeros when the app has no pid', async () => {
    // `com.absent` is in neither the pid list nor the fixture's process rows;
    // `com.demo` is in the fixture, so a name the trace does not hold is what
    // "no app process" means now.
    const r = await new GcAnalyzer().run(ctxFor(db, { pids: [], packageName: 'com.absent' }));
    expect(r.metrics.map((m) => m.id)).toEqual(['gc.degraded']);
  });

  it('carries one drill-down per GC type that resolves through callstack.matching', async () => {
    const r = await new GcAnalyzer().run(ctxFor(db));
    const item = r.evidence.find((e) => e.kind === 'gc_pressure')!;
    expect(item.drillDown.map((d) => d.tool)).toEqual([
      'callstack.matching', 'callstack.matching', 'callstack.matching', 'callstack.matching',
    ]);
    expect(item.drillDown.map((d) => d.args.pattern)).toEqual([
      '%H:FullGC::RunPhases%', '%H:PartialGC::RunPhases%',
      '%H:SharedFullGC::RunPhases%', '%H:SharedGC::RunPhases%',
    ]);
  });
});
