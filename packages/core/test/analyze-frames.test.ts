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
      expect(r.metrics).toHaveLength(6);
      for (const m of r.metrics) {
        expect(Number.isFinite(m.value as number)).toBe(true);
      }
      const noData = r.evidence.filter((e) => e.kind === 'no_data');
      expect(noData).toHaveLength(1);
      expect(noData[0].explain).toMatch(/expect/i);
      expect(noData[0].signals.expectFrames).toBe(2);
    } finally {
      expectOnly.close();
    }
  });
});
