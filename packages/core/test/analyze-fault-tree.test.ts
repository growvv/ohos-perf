import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FaultTreeAnalyzer, computeFaultTree } from '../src/analyze/fault-tree';
import type { AnalyzeContext } from '../src/analyze/types';

const START = 1_000_000_000;

let dir: string;
let db: QueryHandle;
let noPerfDir: string;
let noPerfDb: QueryHandle;

const DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT);
  CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT);
  CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
    depth INT, cookie INT, parent_id INT, argsetid INT, chainId TEXT, spanId TEXT,
    parentSpanId TEXT, flag TEXT, trace_level TEXT, trace_tag TEXT,
    custom_category TEXT, custom_args TEXT, child_callid INT);
  CREATE TABLE trace_range(start_ts INT, end_ts INT);
`;

const PERF_DDL = `
  CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT, thread_id INT,
    event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT,
    thread_state TEXT);
`;

/**
 * One app process and one render_service process.
 *
 * - the app thread carries one `H:HandleOnAreaChangeEvent` row;
 * - the render thread carries one `ProcessedNodes: 42` row exactly two seconds
 *   after `trace_range.start_ts` and one `H:Animate ... [3, 5]` row;
 * - there is no `av_codec_servic*` process and no audio thread, so every
 *   av_codec/Audio signal must stay at its zero value.
 */
function seed(d: DatabaseSync, withPerf: boolean): void {
  d.exec(DDL);
  if (withPerf) d.exec(PERF_DDL);
  d.exec(`
    INSERT INTO process VALUES
      (0, 10, 4999, 'com.demo', 0, 0, 1, 1, 0),
      (1, 20, 3000, 'render_service', 0, 0, 1, 1, 0);
    INSERT INTO thread VALUES
      (100, 100, 5000, 'com.demo', 0, 0, 10, 1, 0),
      (101, 101, 3001, 'RSUniRenderThread', 0, 0, 20, 0, 0);
    INSERT INTO callstack VALUES
      (1, ${START}, 0, 100, 'ability', 'H:HandleOnAreaChangeEvent', 0, 0, 0, 0,
       '', '', '', '', '', '', '', '', 0),
      (2, ${START + 2_000_000_000}, 0, 101, 'gfx',
       'H:RSUniRenderThread::Render() the number of total ProcessedNodes: 42|M0538',
       0, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
      (3, ${START + 1_000_000_000}, 0, 101, 'gfx',
       'H:Animate [nodeSize, totalAnimationSize] [3, 5]',
       0, 0, 0, 0, '', '', '', '', '', '', '', '', 0);
    INSERT INTO trace_range VALUES (${START}, ${START + 9_000_000_000});
  `);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-fault-tree-'));
  const path = join(dir, 't.db');
  const d = new DatabaseSync(path);
  seed(d, true);
  d.close();
  db = openDb(path);

  noPerfDir = mkdtempSync(join(tmpdir(), 'ohosperf-fault-tree-noperf-'));
  const noPerfPath = join(noPerfDir, 't.db');
  const np = new DatabaseSync(noPerfPath);
  seed(np, false);
  np.close();
  noPerfDb = openDb(noPerfPath);
});

afterAll(() => {
  db.close();
  noPerfDb.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(noPerfDir, { recursive: true, force: true });
});

const ZERO_ARKUI = {
  animator: 0,
  HandleOnAreaChangeEvent: 0,
  HandleVisibleAreaChangeEvent: 0,
  GetDefaultDisplay: 0,
  MarshRSTransactionData: 0,
};

const ZERO_AUDIO = {
  AudioWriteCB: 0,
  AudioReadCB: 0,
  AudioPlayCb: 0,
  AudioRecCb: 0,
};

const EXPECTED = {
  arkui: { ...ZERO_ARKUI, HandleOnAreaChangeEvent: 1 },
  RS: {
    ProcessedNodes: { ts: 2, count: 42 },
    DisplayNodeSkipTimes: 0,
    UnMarshRSTransactionData: 0,
    AnimateSize: { nodeSizeSum: 3, totalAnimationSizeSum: 5 },
  },
  av_codec: {
    soft_decoder: false,
    BroadcastControlInstructions: 0,
    VideoDecodingInputFrameCount: 0,
    VideoDecodingConsumptionFrame: 0,
  },
  Audio: ZERO_AUDIO,
};

describe('computeFaultTree', () => {
  it('returns HapRay\'s exact nested shape for the tiny database', () => {
    expect(computeFaultTree(db, { appPids: [4999] })).toEqual(EXPECTED);
  });

  it('returns arkui zeros for empty app pids without executing an IN () query', () => {
    const sqls: string[] = [];
    // Records every statement while delegating to the real handle.
    const spy: QueryHandle = {
      path: db.path,
      close: () => {},
      query<T>(sql: string, params?: unknown[]): T[] {
        sqls.push(sql);
        return db.query<T>(sql, params);
      },
    };

    const signals = computeFaultTree(spy, { appPids: [] });

    expect(signals).toEqual({
      ...EXPECTED,
      arkui: { ...ZERO_ARKUI },
    });
    // The five app-scoped counters must not run at all; RS still runs.
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((sql) => /\bpid\s+IN\b/i.test(sql))).toBe(false);
  });

  it('keeps audio and broadcast counters at 0 when perf_sample is absent', () => {
    const signals = computeFaultTree(noPerfDb, { appPids: [] });
    expect(signals.Audio).toEqual(ZERO_AUDIO);
    expect(signals.av_codec.BroadcastControlInstructions).toBe(0);
  });
});

function makeCtx(
  deviceId = 'emu-test',
  withDb = true,
  pids: number[] = [4999],
): AnalyzeContext {
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    ...(withDb ? { db } : {}),
    app: { packageName: 'com.demo', pids, processNames: ['com.demo'] },
    window: { startNs: START, endNs: START + 9_000_000_000 },
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

describe('FaultTreeAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new FaultTreeAnalyzer();
    expect(analyzer.id).toBe('fault-tree');
    expect(analyzer.requires).toEqual(['trace.binder']);
  });

  it('flattens the nested signals into metrics with the right units', async () => {
    const result = await new FaultTreeAnalyzer().run(makeCtx());
    const byId = new Map(result.metrics.map((m) => [m.id, m]));

    expect([...byId.keys()].sort()).toEqual(
      [
        'fault.Audio.AudioPlayCb',
        'fault.Audio.AudioReadCB',
        'fault.Audio.AudioRecCb',
        'fault.Audio.AudioWriteCB',
        'fault.RS.AnimateSize.nodeSizeSum',
        'fault.RS.AnimateSize.totalAnimationSizeSum',
        'fault.RS.DisplayNodeSkipTimes',
        'fault.RS.ProcessedNodes.count',
        'fault.RS.ProcessedNodes.ts',
        'fault.RS.UnMarshRSTransactionData',
        'fault.arkui.GetDefaultDisplay',
        'fault.arkui.HandleOnAreaChangeEvent',
        'fault.arkui.HandleVisibleAreaChangeEvent',
        'fault.arkui.MarshRSTransactionData',
        'fault.arkui.animator',
        'fault.av_codec.BroadcastControlInstructions',
        'fault.av_codec.VideoDecodingConsumptionFrame',
        'fault.av_codec.VideoDecodingInputFrameCount',
        'fault.av_codec.soft_decoder',
      ].sort(),
    );

    expect(byId.get('fault.RS.ProcessedNodes.ts')!.value).toBe(2);
    expect(byId.get('fault.RS.ProcessedNodes.ts')!.unit).toBe('none');
    expect(byId.get('fault.RS.ProcessedNodes.count')!.value).toBe(42);
    expect(byId.get('fault.RS.AnimateSize.nodeSizeSum')!.value).toBe(3);
    expect(byId.get('fault.RS.AnimateSize.totalAnimationSizeSum')!.value).toBe(5);
    expect(byId.get('fault.arkui.HandleOnAreaChangeEvent')!.value).toBe(1);
    expect(byId.get('fault.av_codec.soft_decoder')!.value).toBe(0);
    expect(byId.get('fault.av_codec.soft_decoder')!.unit).toBe('none');

    for (const m of result.metrics) {
      expect(m.fidelity).toBe('exact');
      expect(m.provenance.collector).toBe('hitrace+streamer');
      expect(m.provenance.device).toBe('emu-test');
      if (m.id !== 'fault.RS.ProcessedNodes.ts' && m.id !== 'fault.av_codec.soft_decoder') {
        expect(m.unit, m.id).toBe('count');
      }
    }
    // Only the four perf_sample-sourced counters are labelled perf_sample.
    for (const m of result.metrics) {
      const perf = m.id === 'fault.av_codec.BroadcastControlInstructions' ||
        m.id.startsWith('fault.Audio.');
      expect(m.provenance.table, m.id).toBe(perf ? 'perf_sample' : 'callstack');
    }
    expect(byId.get('fault.arkui.HandleOnAreaChangeEvent')!.provenance.rows).toBe(1);
    expect(byId.get('fault.RS.ProcessedNodes.count')!.provenance.rows).toBe(1);
    expect(byId.get('fault.RS.AnimateSize.nodeSizeSum')!.provenance.rows).toBe(1);
    expect(byId.get('fault.Audio.AudioWriteCB')!.provenance.rows).toBe(0);
  });

  it('emits one info fault_pattern per non-zero signal, sorted by id', async () => {
    const result = await new FaultTreeAnalyzer().run(makeCtx());

    expect(result.evidence).toHaveLength(4);
    for (const e of result.evidence) {
      expect(e.kind).toBe('fault_pattern');
      expect(e.severity).toBe('info');
      expect(e.window).toEqual({ startNs: START, endNs: START + 9_000_000_000 });
    }
    expect(new Set(result.evidence.map((e) => e.id)).size).toBe(4);

    const explain = result.evidence.map((e) => e.explain).sort();
    expect(explain).toEqual([
      'RS AnimateSize.nodeSizeSum: 3',
      'RS AnimateSize.totalAnimationSizeSum: 5',
      'RS ProcessedNodes: 42',
      'arkui HandleOnAreaChangeEvent: 1',
    ]);

    const area = result.evidence.find((e) => e.explain === 'arkui HandleOnAreaChangeEvent: 1')!;
    expect(area.subject.process).toBe('com.demo');
    expect(area.signals).toEqual({ category: 'arkui', count: 1 });
    expect(area.drillDown).toEqual([
      {
        label: 'Matching callstack rows',
        tool: 'callstack.matching',
        args: { pattern: '%H:HandleOnAreaChangeEvent%' },
        returns: 'CallstackEvent[]',
      },
    ]);

    const nodes = result.evidence.find((e) => e.explain === 'RS ProcessedNodes: 42')!;
    expect(nodes.subject.process).toBe('render_service');
    expect(nodes.signals).toEqual({ category: 'RS', count: 42 });
    expect(nodes.drillDown[0].args).toEqual({ pattern: '%ProcessedNodes%' });

    const animate = result.evidence.find(
      (e) => e.explain === 'RS AnimateSize.nodeSizeSum: 3',
    )!;
    expect(animate.subject.process).toBe('render_service');
    expect(animate.drillDown[0].args).toEqual({
      pattern: '%H:Animate [nodeSize, totalAnimationSize]%',
    });

    // Sorted by (kind, window.startNs, id).
    const key = (e: { kind: string; window: { startNs: number }; id: string }) =>
      `${e.kind}\u0000${String(e.window.startNs).padStart(20, '0')}\u0000${e.id}`;
    expect(result.evidence.map(key)).toEqual([...result.evidence.map(key)].sort());
  });

  it('returns one no_data evidence and no metrics without ctx.db', async () => {
    const result = await new FaultTreeAnalyzer().run(makeCtx('emu-test', false));
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [e] = result.evidence;
    expect(e.kind).toBe('no_data');
    expect(e.severity).toBe('info');
    expect(e.subject.process).toBe('com.demo');
    expect(e.explain).toMatch(/ctx\.db/);
    expect(e.explain).toMatch(/trace database/i);
  });

  it('keeps render-service metrics and one no_data when no app pid is identified', async () => {
    const result = await new FaultTreeAnalyzer().run(makeCtx('emu-test', true, []));
    const byId = new Map(result.metrics.map((m) => [m.id, m]));

    // The render-service (app-independent) metrics are still real measurements.
    expect([...byId.keys()].sort()).toEqual(
      [
        'fault.RS.AnimateSize.nodeSizeSum',
        'fault.RS.AnimateSize.totalAnimationSizeSum',
        'fault.RS.DisplayNodeSkipTimes',
        'fault.RS.ProcessedNodes.count',
        'fault.RS.ProcessedNodes.ts',
        'fault.RS.UnMarshRSTransactionData',
      ].sort(),
    );
    expect(byId.get('fault.RS.ProcessedNodes.ts')!.value).toBe(2);
    expect(byId.get('fault.RS.ProcessedNodes.count')!.value).toBe(42);
    expect(byId.get('fault.RS.AnimateSize.nodeSizeSum')!.value).toBe(3);
    expect(byId.get('fault.RS.AnimateSize.totalAnimationSizeSum')!.value).toBe(5);

    // No app-scoped counter is reported as a confident zero.
    for (const id of byId.keys()) {
      expect(id).not.toMatch(/^fault\.(arkui|av_codec|Audio)\./);
    }

    const noData = result.evidence.filter((e) => e.kind === 'no_data');
    expect(noData).toHaveLength(1);
    expect(noData[0].explain).toMatch(/no app pid/);
    expect(noData[0].explain).toMatch(/analyze --app/);
  });
});
