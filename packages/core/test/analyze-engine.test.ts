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
import { EmptyFrameAnalyzer } from '../src/analyze/empty-frame';
import { FaultTreeAnalyzer } from '../src/analyze/fault-tree';
import { FrameLoadAnalyzer } from '../src/analyze/frame-load';
import { FrameAnalyzer } from '../src/analyze/frames';
import { ComponentReuseAnalyzer } from '../src/analyze/components';
import { FlamegraphAnalyzer } from '../src/analyze/flamegraph';
import { SymbolsAnalyzer } from '../src/analyze/symbols';
import { GcAnalyzer } from '../src/analyze/gc';
import { MemoryAnalyzer } from '../src/analyze/memory';
import { MemoryMeasureAnalyzer } from '../src/analyze/mem-measure';
import { NativeMemoryAnalyzer } from '../src/analyze/native-memory';
import { StartupAnalyzer } from '../src/analyze/startup';
import { RenderAnalyzer } from '../src/analyze/render';
import { RsSkipAnalyzer } from '../src/analyze/rs-skip';
import { ThreadAnalyzer } from '../src/analyze/threads-score';
import { VsyncAnalyzer } from '../src/analyze/vsync';
import { HilogAnalyzer } from '../src/analyze/hilog';
import { UiAnalyzer } from '../src/analyze/ui';
import {
  defaultAnalyzers,
  runAnalyzerSections,
  runAnalyzers,
} from '../src/analyze/engine';
import { resolveAppIdentity } from '../src/analyze/context';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from '../src/analyze/types';
import { metric } from '../src/report/metric';
import type { Metric } from '../src/report/metric';
import { evidence } from '../src/report/evidence';

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

/**
 * A `no_data` item with a fixed identity; only the optional `key` varies, so
 * two items with no key collide on id and two with distinct keys do not.
 */
function noData(key?: string) {
  return evidence({
    kind: 'no_data',
    severity: 'info',
    subject: { process: 'com.demo' },
    window: { startNs: 1000, endNs: 2000 },
    signals: {},
    explain: 'no data',
    drillDown: [],
    ...(key === undefined ? {} : { key }),
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

describe('runAnalyzerSections', () => {
  it('reports one section per analyzer, marking a skipped analyzer degraded', async () => {
    const analyzers = [skippedAnalyzer('native', ['mem.native_hook']), availableAnalyzer('ok', [m('a.metric', 1)])];
    const run = await runAnalyzerSections(analyzers, makeCtx());

    expect(run.sections.map((section) => [section.analyzerId, section.status])).toEqual([
      ['native', 'degraded'],
      ['ok', 'measured'],
    ]);
    const degraded = run.sections[0];
    expect(degraded?.result.metrics.map((x) => x.id)).toEqual(['native.degraded']);
    expect(degraded?.result.evidence.map((x) => x.kind)).toEqual(['degraded_capability']);
    expect(run.result).toEqual(await runAnalyzers(analyzers, makeCtx()));
  });
});

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

  it('throws DUPLICATE_EVIDENCE_ID when two analyzers emit the same evidence id', async () => {
    // Both items share kind, subject and window and carry no key, so the id
    // hash collides. A consumer keyed on `id` would silently drop one.
    await expect(
      runAnalyzers(
        [
          availableAnalyzer('one', [], [noData()]),
          availableAnalyzer('two', [], [noData()]),
        ],
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      name: 'OhosPerfError',
      message: 'DUPLICATE_EVIDENCE_ID',
      code: 'DUPLICATE_EVIDENCE_ID',
    });
  });

  it('keeps both evidence items when they differ only by key', async () => {
    const result = await runAnalyzers(
      [
        availableAnalyzer('one', [], [noData('one')]),
        availableAnalyzer('two', [], [noData('two')]),
      ],
      makeCtx(),
    );
    expect(result.evidence).toHaveLength(2);
    expect(new Set(result.evidence.map((e) => e.id)).size).toBe(2);
  });

  it('keeps the no_data items of a bare library context distinct', async () => {
    // The reported I3 defect: with all capabilities satisfied but no ctx.db
    // or ctx.procfs, frames/fault-tree/binder/threads/memory each emitted a
    // no_data item with the SAME id (same subject and window, no key).
    const full = new CapabilityMatrix([
      state('trace.frames', true),
      state('trace.binder', true),
      state('trace.sched', true),
      state('trace.thread_state', true),
      state('mem.procfs', true),
    ]);
    const bare: AnalyzeContext = {
      ...makeCtx(),
      caps: full,
      db: undefined,
      procfs: undefined,
      frames: { all: () => [] } as unknown as FrameQuery,
    };
    const result = await runAnalyzers(defaultAnalyzers(), bare);
    const noDataItems = result.evidence.filter((e) => e.kind === 'no_data');
    expect(noDataItems.length).toBeGreaterThanOrEqual(4);
    expect(new Set(noDataItems.map((e) => e.id)).size).toBe(noDataItems.length);
    expect('key' in noDataItems[0]).toBe(false);
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
  it('returns every analyzer in append order', () => {
    const analyzers = defaultAnalyzers();
    expect(analyzers.map((a) => a.id)).toEqual([
      'frames',
      'frame-load',
      'fault-tree',
      'binder',
      'threads',
      'memory',
      'mem-measure',
      'native-memory',
      'startup',
      'render',
      'gc',
      'vsync',
      'empty-frame',
      'rs-skip',
      'symbols',
      'flamegraph',
      'components',
      'hilog',
      'ui',
      'redundant-file',
    ]);
    expect(analyzers[0]).toBeInstanceOf(FrameAnalyzer);
    expect(analyzers[1]).toBeInstanceOf(FrameLoadAnalyzer);
    expect(analyzers[2]).toBeInstanceOf(FaultTreeAnalyzer);
    expect(analyzers[3]).toBeInstanceOf(BinderAnalyzer);
    expect(analyzers[4]).toBeInstanceOf(ThreadAnalyzer);
    expect(analyzers[5]).toBeInstanceOf(MemoryAnalyzer);
    expect(analyzers[6]).toBeInstanceOf(MemoryMeasureAnalyzer);
    expect(analyzers[7]).toBeInstanceOf(NativeMemoryAnalyzer);
    expect(analyzers[8]).toBeInstanceOf(StartupAnalyzer);
    expect(analyzers[9]).toBeInstanceOf(RenderAnalyzer);
    expect(analyzers[10]).toBeInstanceOf(GcAnalyzer);
    expect(analyzers[11]).toBeInstanceOf(VsyncAnalyzer);
    expect(analyzers[12]).toBeInstanceOf(EmptyFrameAnalyzer);
    expect(analyzers[13]).toBeInstanceOf(RsSkipAnalyzer);
    expect(analyzers[14]).toBeInstanceOf(SymbolsAnalyzer);
    expect(analyzers[15]).toBeInstanceOf(FlamegraphAnalyzer);
    expect(analyzers[16]).toBeInstanceOf(ComponentReuseAnalyzer);
    expect(analyzers[17]).toBeInstanceOf(HilogAnalyzer);
    expect(analyzers[18]).toBeInstanceOf(UiAnalyzer);
    expect(defaultAnalyzers()).not.toBe(analyzers);
  });
});
