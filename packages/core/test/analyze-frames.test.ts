import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameAnalyzer } from '../src/analyze/frames';

let dir: string; let db: QueryHandle;

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
  callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
  flag INT, depth INT, frame_no INT)`;
const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
  switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
  end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-an-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  // 10 帧：7 正常 / 1 卡顿 / 2 空帧，跨 1 秒 → fps≈10
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const flag = i === 3 ? 1 : (i >= 8 ? 2 : 0);
    rows.push(`(${i}, ${1_000_000_000 + i * 100_000_000}, ${i}, 17, 44, 94, 16000000,
      '', 0, 0, 'actural', ${flag}, 0, ${i})`);
  }
  d.exec(`INSERT INTO frame_slice VALUES ${rows.join(',')}`);
  d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 100, 0, 1, 1, 0)`);
  d.exec(`CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Builds a throwaway trace db from raw SQL, for tests that need their own schema. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  build(d);
  d.close();
  return openDb(p);
}

function ctx() {
  const caps = new CapabilityMatrix([
    { id: 'trace.frames', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'which hitrace', stdout: '/bin/hitrace', stderr: '', code: 0 } },
  ]);
  return {
    frames: new FrameQuery(db), processes: new ProcessQuery(db),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 2_000_000_000 },
    caps, deviceId: 'emu',
  };
}

describe('FrameAnalyzer', () => {
  it('reports jank rate over rendered frames', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.jank.rate')!;
    // 修正 1：1 卡顿 / 8 渲染帧（10 actual 减去 2 空帧）= 12.5%
    // 若误用 actual 作分母会得到 10%，此断言会失败。
    expect(m.value).toBeCloseTo(12.5, 5);
    expect(m.unit).toBe('%');
    expect(m.fidelity).toBe('exact');
  });

  it('reports empty frame rate over actual frames', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.empty.rate')!;
    expect(m.value).toBeCloseTo(20, 5);   // 2 空帧 / 10 actual
  });

  it('carries provenance with table and device', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.count')!;
    expect(m.provenance.table).toBe('frame_slice');
    expect(m.provenance.device).toBe('emu');
  });

  it('emits no_data evidence when no frames in window', async () => {
    const c = ctx();
    c.window = { startNs: 9_000_000_000, endNs: 9_100_000_000 };
    const r = await new FrameAnalyzer().run(c);
    const e = r.evidence.find((x) => x.kind === 'no_data')!;
    expect(e).toBeDefined();
    expect(e.explain).toContain('no frames');
    expect(e.drillDown[0].tool).toBe('frames.all');
  });

  it('emits one evidence per stuttered frame with drilldown', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const jank = r.evidence.filter((x) => x.kind === 'jank');
    expect(jank).toHaveLength(1);
    expect(jank[0].subject.frameNo).toBe(3);
    expect(jank[0].drillDown.map((d) => d.tool)).toContain('frames.get');
  });

  it('is deterministic across runs', async () => {
    const a = await new FrameAnalyzer().run(ctx());
    const b = await new FrameAnalyzer().run(ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gives every stuttered frame a distinct evidence id', async () => {
    // 修正 2：真实 trace 上 frame_no 恒为 0、进程名只有两种，若 window 用整段
    // 分析窗口，60 条 jank 证据会塌成 2 个 id。用帧自身窗口必须得到 60 个。
    const many = withDb('many-jank.db', (d) => {
      d.exec(FRAME_DDL);
      const rows = [];
      for (let i = 0; i < 30; i++) {
        // 30ms spacing, not the brief's 50ms: ctx()'s window ends at 2e9, and
        // 30 frames at 50ms from 1e9 would reach 2.45e9, so all(window) would
        // return only 21 of them and the length assertion below could not pass.
        rows.push(`(${i}, ${1_000_000_000 + i * 30_000_000}, ${i}, 17, 44, 94, 20000000,
          '', 0, 0, 'actural', 1, 0, 0)`);   // frame_no 恒为 0，与真实数据一致
      }
      d.exec(`INSERT INTO frame_slice VALUES ${rows.join(',')}`);
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', NULL, 0, 1, 1, 0)`);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(many) };
      const r = await new FrameAnalyzer().run(c);
      const jank = r.evidence.filter((x) => x.kind === 'jank');
      expect(jank).toHaveLength(30);
      expect(new Set(jank.map((e) => e.id)).size).toBe(30);
    } finally {
      many.close();
    }
  });

  it('never emits NaN or Infinity', async () => {
    // 分母为 0 时不得产生 NaN（JSON.stringify 会把 NaN 变成 null，静默污染输出）
    const empty = withDb('no-rendered.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 0, 17, 44, 94, 100000, '', 0, 0, 'actural', 2, 0, 0)`);  // 只有一个空帧
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(empty) };
      const r = await new FrameAnalyzer().run(c);
      for (const m of r.metrics) {
        expect(Number.isFinite(m.value as number)).toBe(true);
      }
    } finally {
      empty.close();
    }
  });

  it('reports jank time relative to the first frame, not device uptime', async () => {
    // Frames start at 1_000_000_000ns and the stutter is at 1_300_000_000ns.
    // 6382537.7ms-style absolute uptime is meaningless across captures; the
    // explain string must carry the offset into the analyzed span.
    const r = await new FrameAnalyzer().run(ctx());
    const jank = r.evidence.filter((x) => x.kind === 'jank');
    expect(jank).toHaveLength(1);
    expect(jank[0].explain).toContain('at 300.0ms');
    expect(jank[0].explain).not.toContain('1300.0ms');
    expect(jank[0].signals.offsetMs).toBeCloseTo(300, 5);
    // The window stays in the database's own (absolute) time base: it feeds
    // the evidence id and the drill-down args.
    expect(jank[0].window.startNs).toBe(1_300_000_000);
    expect(jank[0].window.endNs).toBe(1_300_000_000 + 16_000_000);
  });

  it('emits no_data evidence when the window contains only expect frames', async () => {
    // Six zero metrics alone cannot be told apart from a broken analyzer. The
    // expect frames prove the query worked, so the no_data explain must say so.
    const expectOnly = withDb('expect-only.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 0, 17, 44, 94, 100000, '', 0, 1, 'expect', 0, 0, 0),
        (1, 200, 0, 17, 44, 94, 100000, '', 0, 1, 'expect', 0, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(expectOnly) };
      const r = await new FrameAnalyzer().run(c);
      // The six metrics are honest zeros, and all finite.
      expect(r.metrics.find((m) => m.id === 'frame.count')!.value).toBe(0);
      expect(r.metrics).toHaveLength(17);
      for (const m of r.metrics) {
        expect(Number.isFinite(m.value as number)).toBe(true);
      }
      const noData = r.evidence.filter((e) => e.kind === 'no_data');
      expect(noData).toHaveLength(1);
      expect(noData[0].explain).toMatch(/expect/i);
      expect(noData[0].signals.expectFrames).toBe(2);

      // A zero with no denominator is not a measurement: a gate that reads
      // `frame.jank.rate` as exact 0 would pass a budget on data the run
      // never had. Each derived rate says so on the metric itself.
      for (const id of ['frame.jank.rate', 'frame.empty.rate', 'frame.avg.duration', 'frame.fps']) {
        const m = r.metrics.find((x) => x.id === id)!;
        expect(m.fidelity, id).toBe('proxy');
        expect(m.degraded?.reason, id).toMatch(/no .*(rendered|actual) frames/i);
      }
      // Counts are real counts even when the answer is zero.
      expect(r.metrics.find((m) => m.id === 'frame.count')!.fidelity).toBe('exact');
    } finally {
      expectOnly.close();
    }
  });

  it('averages duration over rendered frames, not actual frames', async () => {
    // The base fixture cannot tell the two apart (all frames have dur=16ms).
    // Here rendered mean is 20ms and actual mean is (20+20+100)/3 = 46.67ms,
    // so using `actual` would fail this assertion.
    const mixed = withDb('avg-rendered.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 0, 17, 44, 94, 20000000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 200, 0, 17, 44, 94, 20000000, '', 0, 0, 'actural', 0, 0, 0),
        (2, 300, 0, 17, 44, 94, 100000000, '', 0, 0, 'actural', 2, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(mixed) };
      const r = await new FrameAnalyzer().run(c);
      expect(r.metrics.find((m) => m.id === 'frame.avg.duration')!.value)
        .toBeCloseTo(20, 5);
    } finally {
      mixed.close();
    }
  });

  it('computes fps over the frame span, not the analysis window', async () => {
    // 11 frames span exactly 1s inside a 10s window: correct fps is 11,
    // while using ctx.window would give 1.1.
    const narrow = withDb('fps-span.db', (d) => {
      d.exec(FRAME_DDL);
      const rows = [];
      for (let i = 0; i <= 10; i++) {
        rows.push(`(${i}, ${1_000_000_000 + i * 100_000_000}, ${i}, 17, 44, 94, 0,
          '', 0, 0, 'actural', 0, 0, 0)`);
      }
      d.exec(`INSERT INTO frame_slice VALUES ${rows.join(',')}`);
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = {
        ...ctx(), frames: new FrameQuery(narrow),
        window: { startNs: 0, endNs: 10_000_000_000 },
      };
      const r = await new FrameAnalyzer().run(c);
      expect(r.metrics.find((m) => m.id === 'frame.fps')!.value).toBeCloseTo(11, 5);
    } finally {
      narrow.close();
    }
  });

  it('reports 1-second fps window statistics', async () => {
    // 11 frames 100ms apart: window 1 holds 10 (10 fps), window 2 holds the
    // frame exactly at the boundary (1 fps).
    const narrow = withDb('fps-windows.db', (d) => {
      d.exec(FRAME_DDL);
      const rows = [];
      for (let i = 0; i <= 10; i++) {
        rows.push(`(${i}, ${1_000_000_000 + i * 100_000_000}, ${i}, 17, 44, 94, 0,
          '', 0, 0, 'actural', 0, 0, 0)`);
      }
      d.exec(`INSERT INTO frame_slice VALUES ${rows.join(',')}`);
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(narrow),
        window: { startNs: 0, endNs: 10_000_000_000 } };
      const r = await new FrameAnalyzer().run(c);
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.fps.window.count').value).toBe(2);
      expect(get('frame.fps.window.min').value).toBe(1);
      expect(get('frame.fps.window.max').value).toBe(10);
      expect(get('frame.fps.window.mean').value).toBe(5.5);
    } finally {
      narrow.close();
    }
  });

  it('emits metrics and evidence in their documented sort order', async () => {
    // All three jank frames share one ts, so (kind, startNs) ties and only the
    // id can break them. Insertion order is zzz, mmm, aaa (rowid order) while
    // sorted-by-id order is aaa, mmm, zzz — so removing either sort fails here.
    const unsorted = withDb('sort-order.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 1000000000, 0, 10, 44, 94, 20000000, '', 0, 0, 'actural', 1, 0, 0),
        (1, 1000000000, 0, 11, 44, 94, 20000000, '', 0, 0, 'actural', 1, 0, 0),
        (2, 1000000000, 0, 12, 44, 94, 20000000, '', 0, 0, 'actural', 1, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES
        (0, 10, 500, 'zzz', NULL, 0, 1, 1, 0),
        (1, 11, 501, 'mmm', NULL, 0, 1, 1, 0),
        (2, 12, 502, 'aaa', NULL, 0, 1, 1, 0)`);
      d.exec(THREAD_DDL);
    });
    try {
      const c = {
        ...ctx(), frames: new FrameQuery(unsorted),
        processes: new ProcessQuery(unsorted),
      };
      const r = await new FrameAnalyzer().run(c);
      const ids = r.metrics.map((m) => m.id);
      expect(ids).toEqual([...ids].sort());
      expect(r.metrics.map((m) => m.id)).toEqual([
        'frame.avg.duration', 'frame.count', 'frame.empty.rate',
        'frame.fps', 'frame.fps.window.count', 'frame.fps.window.max',
        'frame.fps.window.mean', 'frame.fps.window.min',
        'frame.jank.rate', 'frame.rendered.count',
        'frame.stutter.count', 'frame.stutter.level1.count',
        'frame.stutter.level2.count', 'frame.stutter.level3.count',
        'frame.stutter.render.count', 'frame.stutter.render.rate',
        'frame.stutter.sceneboard.count', 'frame.stutter.sceneboard.rate',
        'frame.stutter.ui.count', 'frame.stutter.ui.rate',
        'frame.stutter.unpaired.count',
      ]);
      const jank = r.evidence.filter((e) => e.kind === 'jank');
      expect(jank.map((e) => e.subject.process)).toEqual(['aaa', 'mmm', 'zzz']);
    } finally {
      unsorted.close();
    }
  });

  it('does not claim a sub-budget frame exceeded a budget', async () => {
    // 11 of 60 real flag-1 frames have dur < 16.7ms (lowest 0.35ms). The
    // platform flagged them late for reasons unrelated to the 60Hz budget, so
    // an explain that says "took 0.5ms (budget 16.7ms)" reads as a false
    // positive. It must name the platform verdict instead.
    const tiny = withDb('sub-budget-jank.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 1000000000, 7, 17, 44, 94, 500000, '', 0, 0, 'actural', 1, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', NULL, 0, 1, 1, 0)`);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(tiny) };
      const r = await new FrameAnalyzer().run(c);
      const jank = r.evidence.filter((e) => e.kind === 'jank');
      expect(jank).toHaveLength(1);
      expect(jank[0].explain).toContain('flagged late by platform');
      expect(jank[0].explain).toContain('dur 0.5ms');
      expect(jank[0].explain).toContain('vsync 7');
      expect(jank[0].explain).not.toMatch(/budget/i);
      expect(jank[0].explain).not.toContain('16.7');
    } finally {
      tiny.close();
    }
  });

  it('reports the real row count when the window has only unknown frame types', async () => {
    // type outside {0,1} is not produced by the measured traces, but if it
    // occurs the no_data evidence must not claim 0 rows when frames.all()
    // would return rows.
    const odd = withDb('unknown-type.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 0, 17, 44, 94, 100000, '', 0, 2, 'other', 0, 0, 0),
        (1, 200, 0, 17, 44, 94, 100000, '', 0, 2, 'other', 0, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
    });
    try {
      const c = { ...ctx(), frames: new FrameQuery(odd) };
      const r = await new FrameAnalyzer().run(c);
      const noData = r.evidence.filter((e) => e.kind === 'no_data');
      expect(noData).toHaveLength(1);
      expect(noData[0].drillDown[0].estRows).toBe(2);
    } finally {
      odd.close();
    }
  });

  it('grades stutter by excess over the expected frame in the vsync group', async () => {
    const graded = withDb('stutter-grades.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 1000000000, 7, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (1, 1100000000, 7, 17, 44, 94, 26670000, '', 0, 0, 'actual', 1, 0, 0),
        (2, 1200000000, 7, 17, 44, 94, 56670000, '', 0, 0, 'actual', 1, 0, 0),
        (3, 1300000000, 7, 17, 44, 94, 126670000, '', 0, 0, 'actual', 1, 0, 0),
        (4, 1400000000, 8, 17, 44, 94, 20000000, '', 0, 0, 'actual', 1, 0, 0),
        (5, 1500000000, 7, 17, 44, 94, 16670000, '', 0, 0, 'actual', 0, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', NULL, 0, 1, 1, 0)`);
      d.exec(THREAD_DDL);
    });
    try {
      const r = await new FrameAnalyzer().run({ ...ctx(), frames: new FrameQuery(graded) });
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.stutter.count').value).toBe(4);
      expect(get('frame.stutter.level1.count').value).toBe(1);  // +10ms
      expect(get('frame.stutter.level2.count').value).toBe(1);  // +40ms
      expect(get('frame.stutter.level3.count').value).toBe(1);  // +110ms
      expect(get('frame.stutter.unpaired.count').value).toBe(1); // vsync 8
      expect(get('frame.stutter.ui.count').value).toBe(4);
      expect(get('frame.stutter.render.count').value).toBe(0);
      expect(get('frame.stutter.sceneboard.count').value).toBe(0);
      // 5 rendered ui frames (4 stuttered + 1 flag 0).
      expect(get('frame.stutter.ui.rate').value).toBeCloseTo(80, 5);
      const levels = r.evidence.filter((e) => e.kind === 'jank')
        .map((e) => [e.window.startNs, e.signals.stutterLevel]);
      expect(levels).toEqual([
        [1100000000, 1], [1200000000, 2], [1300000000, 3], [1400000000, undefined],
      ]);
      const first = r.evidence.find((e) => e.window.startNs === 1100000000)!;
      expect(first.signals.excessMs).toBeCloseTo(10, 5);
      expect(first.explain).toContain('level 1');
    } finally { graded.close(); }
  });

  it('uses the documented level boundaries at 2 and 6 frame budget units', async () => {
    // Expected duration is 16.67ms, so the thresholds are exactly 33.34ms and
    // 100.02ms of excess. `excessFrames < 2` is false at exactly 2, and
    // `excessFrames < 6` is false at exactly 6. The comparison is done in
    // integer nanoseconds (16_670_000 per budget unit) so the exact boundary
    // is not decided by float rounding.
    const bounds = withDb('stutter-bounds.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 1000000000, 7, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (1, 1100000000, 7, 17, 44, 94, 50009999, '', 0, 0, 'actual', 1, 0, 0),
        (2, 1200000000, 8, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (3, 1300000000, 8, 17, 44, 94, 50010000, '', 0, 0, 'actual', 1, 0, 0),
        (4, 1400000000, 9, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (5, 1500000000, 9, 17, 44, 94, 116689999, '', 0, 0, 'actual', 1, 0, 0),
        (6, 1600000000, 10, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (7, 1700000000, 10, 17, 44, 94, 116690000, '', 0, 0, 'actual', 1, 0, 0)`);
      d.exec(PROCESS_DDL); d.exec(THREAD_DDL);
    });
    try {
      const r = await new FrameAnalyzer().run({ ...ctx(), frames: new FrameQuery(bounds) });
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.stutter.level1.count').value).toBe(1); // excess 33.339999ms
      expect(get('frame.stutter.level2.count').value).toBe(2); // 33.34ms and 100.019999ms
      expect(get('frame.stutter.level3.count').value).toBe(1); // exactly 100.02ms
    } finally { bounds.close(); }
  });

  it('classifies stutter into ui, render and sceneboard buckets', async () => {
    const classes = withDb('stutter-classes.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 1000000000, 7, 17, 44, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (1, 1100000000, 7, 17, 44, 94, 20000000, '', 0, 0, 'actual', 1, 0, 0),
        (2, 1200000000, 8, 18, 45, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (3, 1300000000, 8, 18, 45, 94, 20000000, '', 0, 0, 'actual', 1, 0, 0),
        (4, 1400000000, 9, 19, 46, 94, 16670000, '', 0, 1, 'expect', 0, 0, 0),
        (5, 1500000000, 9, 19, 46, 94, 20000000, '', 0, 0, 'actual', 1, 0, 0)`);
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES
        (0, 17, 4999, 'com.demo', NULL, 0, 1, 1, 0),
        (1, 18, 6000, 'render_service', NULL, 0, 1, 1, 0),
        (2, 19, 6001, 'ohos.sceneboard', NULL, 0, 1, 1, 0)`);
      d.exec(THREAD_DDL);
    });
    try {
      const r = await new FrameAnalyzer().run({
        ...ctx(), frames: new FrameQuery(classes), processes: new ProcessQuery(classes),
      });
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.stutter.ui.count').value).toBe(1);
      expect(get('frame.stutter.render.count').value).toBe(1);
      expect(get('frame.stutter.sceneboard.count').value).toBe(1);
      expect(get('frame.stutter.ui.rate').value).toBeCloseTo(100, 5);
    } finally { classes.close(); }
  });
});
