import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import type { Frame } from '../src/query/frames';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { computeVsyncAnomalies, VsyncAnalyzer } from '../src/analyze/vsync';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

let dir: string;
let db: QueryHandle;

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT,
  type_desc TEXT, flag INT, depth INT, frame_no INT)`;

/** A frame with every column this analyzer reads; other fields are filler. */
function frame(id: number, ts: number, vsync: number, type: 0 | 1, ipid = 17): Frame {
  return {
    id, ts, dur: 16_000_000, vsync, ipid, itid: 44, callstackId: 0, flag: 0,
    type, typeDesc: type === 0 ? 'actual' : 'expect', src: '', dst: 0, depth: 0, frameNo: 0,
  };
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'render.vsync', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(target: QueryHandle): AnalyzeContext {
  return {
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
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
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-vsync-'));
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `rows` into a fresh trace database and returns its handle. */
function dbWith(name: string, rows: Frame[]): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  d.exec(FRAME_DDL);
  d.exec('CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT, ' +
    'switch_count INT, thread_count INT, slice_count INT, mem_count INT)');
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0),
    (1, 18, 5000, 'ohos.sceneboard', 0, 0, 1, 0, 0)`);
  const insert = d.prepare(`INSERT INTO frame_slice VALUES
    (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, 0, 0, 0)`);
  for (const f of rows) {
    insert.run(f.id, f.ts, f.vsync, f.ipid, f.itid, f.callstackId, f.dur, f.type, f.typeDesc);
  }
  d.close();
  return openDb(p);
}

describe('computeVsyncAnomalies', () => {
  it('detects a run of three or more short intervals as one high-frequency period', () => {
    // 4ms gaps = 250Hz; 4 intervals; duration 16ms.
    const frames = [0, 4e6, 8e6, 12e6, 16e6, 32e6].map((d, i) =>
      frame(i, 1e9 + d, 100 + i, 0));
    const a = computeVsyncAnomalies(frames);
    expect(a.periods).toHaveLength(1);
    expect(a.periods[0]).toMatchObject({
      kind: 'high_frequency', intervalCount: 4, severity: 'high',
    });
    expect(a.periods[0].avgFrequencyHz).toBeCloseTo(250, 0);
  });

  it('ignores a run of two anomalous intervals', () => {
    const frames = [0, 4e6, 8e6, 24e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
    expect(computeVsyncAnomalies(frames).periods).toEqual([]);
  });

  it('classifies severity at the 150/200 Hz boundaries', () => {
    // 160Hz (6.25ms) x 3 intervals = 18.75ms, under 50ms -> medium.
    const medium = [0, 6.25e6, 12.5e6, 18.75e6].map((d, i) =>
      frame(i, 1e9 + d, 100 + i, 0));
    expect(computeVsyncAnomalies(medium).periods[0].severity).toBe('medium');
    // 210Hz (about 4.762ms) x 3 -> high.
    const high = [0, 4.762e6, 9.524e6, 14.286e6].map((d, i) =>
      frame(i, 1e9 + d, 100 + i, 0));
    expect(computeVsyncAnomalies(high).periods[0].severity).toBe('high');
  });

  it('detects a long-interval run as a low-frequency period', () => {
    // 100ms gaps = 10Hz, 3 intervals -> high severity (below 15Hz).
    const frames = [0, 100e6, 200e6, 300e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
    const a = computeVsyncAnomalies(frames);
    expect(a.periods).toHaveLength(1);
    expect(a.periods[0]).toMatchObject({ kind: 'low_frequency', severity: 'high' });
  });

  it('counts vsync groups with no actual or no expect frame as mismatches', () => {
    // Group 100 has both types; 101 has only actual; 102 has only expect.
    const frames = [
      frame(0, 1e9, 100, 0), frame(1, 1.016e9, 100, 1),
      frame(2, 1.032e9, 101, 0),
      frame(3, 1.048e9, 102, 1),
    ];
    const a = computeVsyncAnomalies(frames);
    expect(a.signals).toBe(3);
    expect(a.mismatches).toBe(2);
    expect(a.anomalyRate).toBeCloseTo(66.67, 2);
  });

  it('returns an empty analysis for no frames', () => {
    expect(computeVsyncAnomalies([])).toEqual({
      signals: 0, mismatches: 0, periods: [], anomalyRate: 0,
    });
  });
});

describe('VsyncAnalyzer', () => {
  it('rounds the anomaly rate with Python’s half-even round(x, 2)', () => {
    // 1 mismatch over 160 signals is exactly 0.625%. Python's `round(0.625, 2)`
    // is 0.62 (half-even on the exact double); `Math.round(x*100)/100` gives
    // 0.63. HapRay reports 0.62.
    const frames: Frame[] = [];
    let id = 0;
    // 159 vsync groups with both an actual and an expect frame, then one group
    // with only an actual: 160 signals and exactly one mismatch.
    for (let i = 0; i < 160; i++) {
      const ts = 1e9 + i * 16_666_667;
      frames.push(frame(id++, ts, i + 1, 0));
      if (i < 159) frames.push(frame(id++, ts, i + 1, 1));
    }
    // The single unmet side is the 160th group, which has no expect frame.
    const analysis = computeVsyncAnomalies(frames);
    expect(analysis.signals).toBe(160);
    expect(analysis.mismatches).toBe(1);
    expect(analysis.periods).toHaveLength(0);
    expect(analysis.anomalyRate).toBe(0.62);
  });

  it('analyzes only the app’s frames, not every process’s', async () => {
    // The app emits a 4ms burst; sceneboard emits a slow 100ms cadence. If the
    // analyzer mixed them, the intervals would straddle both and no period
    // would be detected at all.
    const frames = [
      ...[0, 4e6, 8e6, 12e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0, 17)),
      ...[0, 100e6, 200e6, 300e6].map((d, i) => frame(10 + i, 1e9 + d, 200 + i, 0, 18)),
    ];
    db = dbWith('app.db', frames);
    const r = await new VsyncAnalyzer().run(ctxWith(db));
    expect(metric(r, 'vsync.signals.count').value).toBe(4);
    expect(metric(r, 'vsync.periods.count').value).toBe(1);
  });

  it('emits one evidence item per period with a drill-down over its window', async () => {
    const frames = [0, 4e6, 8e6, 12e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
    db?.close();
    db = dbWith('one.db', frames);
    const r = await new VsyncAnalyzer().run(ctxWith(db));
    const items = r.evidence.filter((e) => e.kind === 'vsync_anomaly');
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('critical');
    expect(items[0].signals).toMatchObject({ kind: 'high_frequency', intervalCount: 3 });
    expect(items[0].drillDown.map((d) => d.tool)).toEqual(['frames.all']);
    expect(items[0].window).toEqual({ startNs: 1e9, endNs: 1e9 + 12e6 });
  });

  it('emits no_data and no metrics when the app rendered no frames', async () => {
    db?.close();
    db = dbWith('empty.db', []);
    const r = await new VsyncAnalyzer().run(ctxWith(db));
    expect(r.metrics).toEqual([]);
    expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
  });
});
