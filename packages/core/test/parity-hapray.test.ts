import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { computeFaultTree } from '../src/analyze/fault-tree';
import {
  computeBinderAnalysis,
  type BinderInterfaceStat,
  type BinderProcessStat,
  type BinderThreadStat,
} from '../src/analyze/binder';

/**
 * HapRay parity on the recorded traces.
 *
 * The traces live in the gitignored `spike/out/` directory, so each case skips
 * visibly when the file is absent; when present it must run. The golden files
 * are the `step1` payload produced by HapRay rev `9386e4e` (see
 * `scripts/parity/README.md`), not values authored here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures/hapray');
const SPIKE_OUT = join(here, '../../../spike/out');

const EMU_DB = join(SPIKE_OUT, 'emu_big.db');
const REAL_DB = join(SPIKE_OUT, 'real_device.db');

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** Runs `fn` with a read-only handle and always closes it. */
function withDb<T>(path: string, fn: (db: QueryHandle) => T): T {
  const db = openDb(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The snake_case `ipc_binder_analyzer.py` payload as HapRay writes it. */
interface GoldenProcessStat {
  caller_proc: string;
  callee_proc: string;
  count: number;
  avg_latency: number;
  min_latency: number;
  max_latency: number;
  qps: number | null;
  avg_interval_ms: number | null;
}

interface GoldenThreadStat {
  caller_proc: string;
  caller_tid: number | null;
  caller_thread_name: string | null;
  callee_proc: string;
  callee_tid: number | null;
  callee_thread_name: string | null;
  count: number;
  avg_latency: number;
  min_latency: number;
  max_latency: number;
  qps: number | null;
  avg_interval_ms: number | null;
}

interface GoldenInterfaceStat {
  code: string;
  count: number;
  avg_latency: number;
  min_latency: number;
  max_latency: number;
  qps: number | null;
  avg_interval_ms: number | null;
  top_caller_proc: string;
  top_callee_proc: string;
  caller_proc_variety: number;
  callee_proc_variety: number;
}

interface BinderGolden {
  process_stats: GoldenProcessStat[];
  thread_stats: GoldenThreadStat[];
  interface_stats: GoldenInterfaceStat[];
}

/**
 * Numbers that HapRay derives from floating-point means are compared with
 * `toBeCloseTo`; counts, strings, and null are exact. The maps are keyed by
 * each row's identity fields, so HapRay's unstable tie order is irrelevant.
 */
function expectClose(
  actual: number | null,
  expected: number | null,
  label: string,
): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  expect(actual as number, label).toBeCloseTo(expected, 6);
}

function processKey(stat: { callerProc: string; calleeProc: string }): string {
  return JSON.stringify([stat.callerProc, stat.calleeProc]);
}

function threadKey(stat: {
  callerProc: string;
  callerTid: number | null;
  callerThreadName: string | null;
  calleeProc: string;
  calleeTid: number | null;
  calleeThreadName: string | null;
}): string {
  return JSON.stringify([
    stat.callerProc,
    stat.callerTid,
    stat.callerThreadName,
    stat.calleeProc,
    stat.calleeTid,
    stat.calleeThreadName,
  ]);
}

function compareProcessStats(
  actual: BinderProcessStat[],
  golden: GoldenProcessStat[],
): void {
  const actualMap = new Map(actual.map((stat) => [processKey(stat), stat]));
  const goldenMap = new Map(golden.map((stat) => [
    processKey({ callerProc: stat.caller_proc, calleeProc: stat.callee_proc }),
    stat,
  ]));
  expect([...actualMap.keys()].sort()).toEqual([...goldenMap.keys()].sort());

  for (const [key, want] of goldenMap) {
    const got = actualMap.get(key);
    expect(got, key).toBeDefined();
    if (got === undefined) continue;
    expect(got.callerProc, `${key} callerProc`).toBe(want.caller_proc);
    expect(got.calleeProc, `${key} calleeProc`).toBe(want.callee_proc);
    expect(got.count, `${key} count`).toBe(want.count);
    expectClose(got.avgLatency, want.avg_latency, `${key} avgLatency`);
    expectClose(got.minLatency, want.min_latency, `${key} minLatency`);
    expectClose(got.maxLatency, want.max_latency, `${key} maxLatency`);
    expectClose(got.qps, want.qps, `${key} qps`);
    expectClose(got.avgIntervalMs, want.avg_interval_ms, `${key} avgIntervalMs`);
  }
}

function compareThreadStats(
  actual: BinderThreadStat[],
  golden: GoldenThreadStat[],
): void {
  const actualMap = new Map(actual.map((stat) => [threadKey(stat), stat]));
  const goldenMap = new Map(golden.map((stat) => [
    threadKey({
      callerProc: stat.caller_proc,
      callerTid: stat.caller_tid,
      callerThreadName: stat.caller_thread_name,
      calleeProc: stat.callee_proc,
      calleeTid: stat.callee_tid,
      calleeThreadName: stat.callee_thread_name,
    }),
    stat,
  ]));
  expect([...actualMap.keys()].sort()).toEqual([...goldenMap.keys()].sort());

  for (const [key, want] of goldenMap) {
    const got = actualMap.get(key);
    expect(got, key).toBeDefined();
    if (got === undefined) continue;
    expect(got.callerProc, `${key} callerProc`).toBe(want.caller_proc);
    expect(got.callerTid, `${key} callerTid`).toBe(want.caller_tid);
    expect(got.callerThreadName, `${key} callerThreadName`)
      .toBe(want.caller_thread_name);
    expect(got.calleeProc, `${key} calleeProc`).toBe(want.callee_proc);
    expect(got.calleeTid, `${key} calleeTid`).toBe(want.callee_tid);
    expect(got.calleeThreadName, `${key} calleeThreadName`)
      .toBe(want.callee_thread_name);
    expect(got.count, `${key} count`).toBe(want.count);
    expectClose(got.avgLatency, want.avg_latency, `${key} avgLatency`);
    expectClose(got.minLatency, want.min_latency, `${key} minLatency`);
    expectClose(got.maxLatency, want.max_latency, `${key} maxLatency`);
    expectClose(got.qps, want.qps, `${key} qps`);
    expectClose(got.avgIntervalMs, want.avg_interval_ms, `${key} avgIntervalMs`);
  }
}

function compareInterfaceStats(
  actual: BinderInterfaceStat[],
  golden: GoldenInterfaceStat[],
): void {
  const actualMap = new Map(actual.map((stat) => [stat.code, stat]));
  const goldenMap = new Map(golden.map((stat) => [stat.code, stat]));
  expect([...actualMap.keys()].sort()).toEqual([...goldenMap.keys()].sort());

  for (const [key, want] of goldenMap) {
    const got = actualMap.get(key);
    expect(got, key).toBeDefined();
    if (got === undefined) continue;
    expect(got.code, `${key} code`).toBe(want.code);
    expect(got.count, `${key} count`).toBe(want.count);
    expectClose(got.avgLatency, want.avg_latency, `${key} avgLatency`);
    expectClose(got.minLatency, want.min_latency, `${key} minLatency`);
    expectClose(got.maxLatency, want.max_latency, `${key} maxLatency`);
    expectClose(got.qps, want.qps, `${key} qps`);
    expectClose(got.avgIntervalMs, want.avg_interval_ms, `${key} avgIntervalMs`);
    expect(got.topCallerProc, `${key} topCallerProc`).toBe(want.top_caller_proc);
    expect(got.topCalleeProc, `${key} topCalleeProc`).toBe(want.top_callee_proc);
    expect(got.callerProcVariety, `${key} callerProcVariety`)
      .toBe(want.caller_proc_variety);
    expect(got.calleeProcVariety, `${key} calleeProcVariety`)
      .toBe(want.callee_proc_variety);
  }
}

describe('HapRay parity', () => {
  describe('fault tree', () => {
    it.skipIf(!existsSync(EMU_DB))(
      'emu_big matches the FaultTreeAnalyzer golden',
      () => {
        const actual = withDb(EMU_DB, (db) =>
          computeFaultTree(db, { appPids: [16702] }),
        );
        expect(actual).toEqual(readGolden('fault-tree.emu_big.json'));

        // Pinned values so a same-shape regression cannot hide behind the
        // deep-equal (the golden is regenerated rarely).
        expect(actual.arkui.HandleOnAreaChangeEvent).toBe(51);
        expect(actual.arkui.MarshRSTransactionData).toBe(56);
        expect(actual.RS.UnMarshRSTransactionData).toBe(63);
        expect(actual.RS.ProcessedNodes).toEqual({ ts: 28.604984, count: 34 });
        expect(actual.RS.AnimateSize).toEqual({
          nodeSizeSum: 67,
          totalAnimationSizeSum: 67,
        });
      },
    );

    it.skipIf(!existsSync(REAL_DB))(
      'real_device matches the FaultTreeAnalyzer golden',
      () => {
        const actual = withDb(REAL_DB, (db) =>
          computeFaultTree(db, { appPids: [6115] }),
        );
        expect(actual).toEqual(readGolden('fault-tree.real_device.json'));

        expect(actual.arkui.GetDefaultDisplay).toBe(4);
        expect(actual.RS.ProcessedNodes).toEqual({ ts: 0.04111198, count: 84 });
        expect(actual.RS.DisplayNodeSkipTimes).toBe(4);
        expect(actual.RS.UnMarshRSTransactionData).toBe(1);
        expect(actual.RS.AnimateSize).toEqual({
          nodeSizeSum: 79,
          totalAnimationSizeSum: 87,
        });
      },
    );
  });

  describe('binder', () => {
    it.skipIf(!existsSync(EMU_DB))(
      'emu_big matches the binder golden',
      () => {
        const actual = withDb(EMU_DB, (db) =>
          computeBinderAnalysis(db, { appPids: [16702] }),
        );
        const golden = readGolden<BinderGolden>('binder.emu_big.json');

        compareProcessStats(actual.processStats, golden.process_stats);
        compareThreadStats(actual.threadStats, golden.thread_stats);
        compareInterfaceStats(actual.interfaceStats, golden.interface_stats);

        // Pinned totals and the hottest pair so a same-shape regression cannot
        // hide behind the map comparison.
        expect(actual.processStats).toHaveLength(6);
        expect(actual.threadStats).toHaveLength(28);
        expect(actual.interfaceStats).toHaveLength(4);
        const hot = actual.processStats.find(
          (stat) =>
            stat.callerProc === 'pbench.baseline' &&
            stat.calleeProc === 'render_service',
        );
        expect(hot).toBeDefined();
        expect(hot?.count).toBe(106);
        expect(hot?.avgLatency).toBeCloseTo(0.843066037735849, 6);
      },
    );

    it.skipIf(!existsSync(REAL_DB))(
      'real_device returns empty binder stats like the golden',
      () => {
        // HapRay's real-device step1 payload is `{}`: no step had binder data.
        expect(readGolden('binder.real_device.json')).toEqual({});
        const actual = withDb(REAL_DB, (db) =>
          computeBinderAnalysis(db, { appPids: [6115] }),
        );
        expect(actual.transactions).toEqual([]);
        expect(actual.processStats).toEqual([]);
        expect(actual.threadStats).toEqual([]);
        expect(actual.interfaceStats).toEqual([]);
      },
    );
  });
});
