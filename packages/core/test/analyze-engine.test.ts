import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import {
  CapabilityMatrix,
  type CapabilityId,
  type CapabilityState,
} from '../src/device/capability';
import { BinderAnalyzer } from '../src/analyze/binder';
import { FaultTreeAnalyzer } from '../src/analyze/fault-tree';
import { FrameAnalyzer } from '../src/analyze/frames';
import { defaultAnalyzers, runAnalyzers } from '../src/analyze/engine';
import { resolveAppIdentity } from '../src/analyze/context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from '../src/analyze/types';
import { metric } from '../src/report/metric';
import type { Metric } from '../src/report/metric';

let dir: string;
let db: QueryHandle;

const PROBE = { command: 'probe', stdout: '', stderr: '', code: 0 };

function state(
  id: CapabilityId,
  available: boolean,
  reason?: string,
): CapabilityState {
  return {
    id,
    available,
    fidelity: 'exact',
    ...(reason === undefined ? {} : { reason }),
    probe: PROBE,
  };
}

/**
 * The engine test uses three capabilities: one available, and two unavailable
 * with distinct device reasons (`mem.native_hook`, `perf.pmu`).
 */
function matrix(): CapabilityMatrix {
  return new CapabilityMatrix([
    state('trace.frames', true),
    state('mem.native_hook', false, 'hiprofiler not present on device'),
    state('perf.pmu', false, 'no hardware PMU events reported'),
  ]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-engine-'));
  const path = join(dir, 't.db');
  const d = new DatabaseSync(path);
  d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 1, 1, 0, 0)`);
  d.close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(): AnalyzeContext {
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    // The window is shared by the two degraded evidences; only the analyzer id
    // key makes their ids distinct.
    window: { startNs: 1000, endNs: 2000 },
    caps: matrix(),
    deviceId: 'emu',
  };
}

function m(id: string, value: number): Metric {
  return metric({
    id,
    value,
    unit: 'count',
    provenance: { collector: 'test', device: 'emu' },
    fidelity: 'exact',
  });
}

function availableAnalyzer(
  id: string,
  metrics: Metric[],
  evidence: AnalyzeResult['evidence'] = [],
): Analyzer {
  return {
    id,
    requires: ['trace.frames'],
    async run(): Promise<AnalyzeResult> {
      return { metrics, evidence };
    },
  };
}

/** A degraded analyzer must never be called, so `run` fails the test if it is. */
function skippedAnalyzer(id: string, requires: CapabilityId[]): Analyzer {
  return {
    id,
    requires,
    async run(): Promise<AnalyzeResult> {
      throw new Error(`degraded analyzer ${id} must not run`);
    },
  };
}

describe('runAnalyzers', () => {
  it('degrades unavailable analyzers and reports the device reason', async () => {
    const result = await runAnalyzers(
      [
        skippedAnalyzer('pmu', ['perf.pmu']),
        availableAnalyzer('available', [m('z.metric', 2), m('a.metric', 1)]),
        skippedAnalyzer('native', ['mem.native_hook']),
      ],
      makeCtx(),
    );

    const native = result.metrics.find((x) => x.id === 'native.degraded')!;
    expect(native).toMatchObject({
      value: 0,
      unit: 'count',
      fidelity: 'proxy',
      degraded: { fallback: 'analyzer skipped' },
      provenance: { collector: 'capability-matrix', device: 'emu' },
    });
    expect(native.degraded!.reason).toContain('mem.native_hook');
    expect(native.degraded!.reason).toContain('hiprofiler not present on device');

    const pmu = result.metrics.find((x) => x.id === 'pmu.degraded')!;
    expect(pmu).toMatchObject({ value: 0, unit: 'count', fidelity: 'proxy' });
    expect(pmu.degraded!.reason).toContain('perf.pmu');
    expect(pmu.degraded!.reason).toContain('no hardware PMU events reported');
  });

  it('keeps the two degraded evidence ids distinct with the analyzer key', async () => {
    const result = await runAnalyzers(
      [skippedAnalyzer('native', ['mem.native_hook']), skippedAnalyzer('pmu', ['perf.pmu'])],
      makeCtx(),
    );

    const degraded = result.evidence.filter((e) => e.kind === 'degraded_capability');
    expect(degraded).toHaveLength(2);
    expect(new Set(degraded.map((e) => e.id)).size).toBe(2);

    const native = degraded.find((e) => e.signals.missing === 'mem.native_hook')!;
    expect(native.subject.process).toBe('com.demo');
    expect(native.window).toEqual({ startNs: 1000, endNs: 2000 });
    expect(native.severity).toBe('warn');
    expect(native.drillDown).toEqual([
      {
        label: 'Capability matrix',
        tool: 'caps.get',
        args: { ids: ['mem.native_hook'] },
        returns: 'CapabilityState[]',
        estRows: 1,
      },
    ]);
    // The per-analyzer key is hash material only; it is not part of the object.
    expect('key' in native).toBe(false);
  });

  it('merges metrics from every available analyzer and sorts by id', async () => {
    const result = await runAnalyzers(
      [
        availableAnalyzer('z-analyzer', [m('z.metric', 2)]),
        availableAnalyzer('a-analyzer', [m('b.metric', 3), m('a.metric', 1)]),
      ],
      makeCtx(),
    );
    expect(result.metrics.map((x) => x.id)).toEqual(['a.metric', 'b.metric', 'z.metric']);
  });

  it('throws DUPLICATE_METRIC_ID when two analyzers emit the same id', async () => {
    await expect(
      runAnalyzers(
        [
          availableAnalyzer('one', [m('shared.metric', 1)]),
          availableAnalyzer('two', [m('shared.metric', 2)]),
        ],
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'OhosPerfError',
      message: 'DUPLICATE_METRIC_ID',
      code: 'DUPLICATE_METRIC_ID',
    });
  });

  it('does not mutate the context, analyzer objects, or their results', async () => {
    const first = m('z.metric', 2);
    const second = m('a.metric', 1);
    const analyzerMetrics = [first, second];
    const available = availableAnalyzer('available', analyzerMetrics);
    const native = skippedAnalyzer('native', ['mem.native_hook']);
    const analyzers = Object.freeze([native, available]);
    const ctx = makeCtx();
    const before = JSON.stringify({ app: ctx.app, window: ctx.window, deviceId: ctx.deviceId });

    Object.freeze(available);
    Object.freeze(native);
    Object.freeze(ctx);
    // Sorting a frozen array in place would throw: the engine must copy it.
    Object.freeze(analyzerMetrics);

    const result = await runAnalyzers(analyzers, ctx);

    expect(analyzers.map((a) => a.id)).toEqual(['native', 'available']);
    expect(JSON.stringify({ app: ctx.app, window: ctx.window, deviceId: ctx.deviceId })).toBe(before);
    expect(result.metrics.map((x) => x.id)).toEqual(['a.metric', 'native.degraded', 'z.metric']);
    expect(analyzerMetrics.map((x) => x.id)).toEqual(['z.metric', 'a.metric']);
  });
});

describe('resolveAppIdentity', () => {
  it('resolves an installed package to its pid', () => {
    expect(resolveAppIdentity(new ProcessQuery(db), 'com.demo')).toEqual({
      packageName: 'com.demo',
      pids: [4999],
      processNames: ['com.demo'],
    });
  });

  it('returns no pids for a package that is not in the trace', () => {
    expect(resolveAppIdentity(new ProcessQuery(db), 'com.missing')).toEqual({
      packageName: 'com.missing',
      pids: [],
      processNames: ['com.missing'],
    });
  });
});

describe('defaultAnalyzers', () => {
  it('returns the frame, fault-tree, and binder analyzers in append order', () => {
    const analyzers = defaultAnalyzers();
    expect(analyzers.map((a) => a.id)).toEqual(['frames', 'fault-tree', 'binder']);
    expect(analyzers[0]).toBeInstanceOf(FrameAnalyzer);
    expect(analyzers[1]).toBeInstanceOf(FaultTreeAnalyzer);
    expect(analyzers[2]).toBeInstanceOf(BinderAnalyzer);
    expect(defaultAnalyzers()).not.toBe(analyzers);
  });
});
