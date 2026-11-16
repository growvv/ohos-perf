# P10 Frame Load, Stutter Levels and FPS Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add frame sampled-event load with attribution drill-downs, graded stutter levels, per-process stutter breakdown, 1-second FPS windows, and empty-frame load/severity to `@ohos-perf/core`, then release `0.5.0`.

**Architecture:** One batched `FrameLoadIndex` reads `perf_sample` once and answers per-frame load/thread splits; a new `frame-load` analyzer and the existing `empty-frame` analyzer consume it. `FrameAnalyzer` gains deterministic expected-frame pairing, level metrics and `computeFpsWindows`. Four named queries expose FPS series and per-thread/symbol/file attribution. All output flows through the existing P9 report model.

**Tech Stack:** TypeScript ESM, `node:sqlite`, Vitest, npm workspaces; zero runtime dependencies in core.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p10-frame-load-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`; Node built-ins only.
- D5 determinism: byte-identical output for identical input; no `Date.now()`, no absolute paths, locale-independent sorting, every emitted array sorted.
- `perf_sample.event_count` is sample weight. Never call it instructions, CPU time or power.
- Metric ids, evidence kinds, query names and types are copied from the spec verbatim; do not rename them in later tasks.
- Every analyzer result must be finite: no `NaN`/`Infinity` (JSON turns them into `null`).
- TDD: write the test, run it and watch it fail, implement, run it green, then run the whole suite.
- Before CLI tests or the full suite, rebuild core: `npm run build -w @ohos-perf/core`.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **Time-base mismatch:** samples exist but none land inside any frame window (e.g. `timeStamp` vs `timestamp_trace` base). Exact zeros would read as an idle app; the analyzer must degrade with a reason naming the time base.
2. **Overlapping app frames:** ui and render frames in one vsync period double-count shared samples per frame. `frame.load.total` may exceed `frame.load.span.weight`; shares must use the documented denominator, not the unique weight.
3. **Boundary inclusivity:** a sample at exactly `ts` or `ts + dur` counts; a frame at exactly a 1 s window boundary belongs to the next window. Off-by-one changes measured fixture values.
4. **Expected-frame choice:** several expected frames can share a vsync, and a later one may sort first by `(ts, id)`. Pairing must be deterministic and must not borrow an expected frame from a different vsync.
5. **Degenerate windows:** zero rendered frames, zero-duration frames, and an empty perf thread list must not divide by zero or emit fabricated zero metrics.

---

### Task 1: Leaf attribution in `PerfQuery`

**Files:**
- Modify: `packages/core/src/query/perf.ts` (add interface + method; extract the shared chain-weight query if it keeps `foldedStacks` intact)
- Test: `packages/core/test/query-callstack-perf.test.ts`

**Interfaces:**
- Produces: `export interface PerfLeafAttribution { symbol: string; filePath: string; samples: number }`
- Produces: `PerfQuery.leafAttribution(threadIds: readonly number[], range: TimeRange): PerfLeafAttribution[]`

- [ ] **Step 1: Write the failing tests**

Append to `describe('PerfQuery')`:

```ts
it('attributes each sample weight to the leaf symbol and file', () => {
  const rows = new PerfQuery(perfDb).leafAttribution([100], { startNs: 0, endNs: 2000 });
  // Chain 10 weighs 12 and its depth-3 frame is `raw3` with no resolved file.
  expect(rows).toEqual([{ symbol: 'raw3', filePath: '', samples: 12 }]);
});

it('resolves the leaf through perf_files exact and file-only matches', () => {
  const rows = new PerfQuery(perfDb).leafAttribution([101], { startNs: 0, endNs: 2000 });
  // Chain 11's only frame is file 101 / serial 2 => Other() /lib/libbar2.so.
  expect(rows).toEqual([{ symbol: 'Other()', filePath: '/lib/libbar2.so', samples: 3 }]);
});

it('orders leaf rows by samples desc, then symbol, then filePath', () => {
  const tie = withDb('leaf-tie.db', (d) => {
    d.exec(PERF_SAMPLE_DDL);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(PERF_FILES_DDL);
    d.exec(`INSERT INTO perf_sample VALUES
      (0, 20, 100, 900, 1, 1, 100, 0, 'S'),
      (1, 21, 200, 900, 1, 1, 200, 0, 'S'),
      (2, 22, 300, 900, 2, 1, 300, 0, 'S')`);
    d.exec(`INSERT INTO perf_callchain VALUES
      (0, 20, 0, 0, 0, 0, NULL, NULL, 'zeta', 0, 0),
      (1, 21, 0, 0, 0, 0, NULL, NULL, 'alpha', 0, 0),
      (2, 22, 0, 0, 0, 0, NULL, NULL, 'beta', 0, 0)`);
  });
  try {
    const rows = new PerfQuery(tie).leafAttribution([900], { startNs: 0, endNs: 1000 });
    expect(rows.map((r) => [r.symbol, r.samples])).toEqual([
      ['beta', 2], ['alpha', 1], ['zeta', 1],
    ]);
  } finally {
    tie.close();
  }
});

it('skips chains with no frames or no resolved symbol and empty thread lists', () => {
  const empty = withDb('leaf-empty.db', (d) => {
    d.exec(PERF_SAMPLE_DDL);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(PERF_FILES_DDL);
    d.exec("INSERT INTO perf_sample VALUES (0, 30, 100, 901, 4, 1, 100, 0, 'S')");
    d.exec("INSERT INTO perf_callchain VALUES (0, 30, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0)");
  });
  try {
    expect(new PerfQuery(empty).leafAttribution([901], { startNs: 0, endNs: 1000 })).toEqual([]);
    expect(new PerfQuery(perfDb).leafAttribution([], { startNs: 0, endNs: 2000 })).toEqual([]);
  } finally {
    empty.close();
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/query-callstack-perf.test.ts`
Expected: FAIL — `leafAttribution is not a function`.

- [ ] **Step 3: Implement**

In `perf.ts`, add the exported interface near `FoldedStack`. Implement by sharing one private `chainWeights(threadIds, range): Map<number, number>` with `foldedStacks` (same `GROUP BY callchain_id` SQL), then:

```ts
leafAttribution(threadIds: readonly number[], range: TimeRange): PerfLeafAttribution[] {
  if (threadIds.length === 0 || !this.hasTable('perf_sample')) return [];
  const unique = [...new Set(threadIds)];
  const weights = this.chainWeights(unique, range);
  if (weights.size === 0) return [];
  const functionsByChain = this.chainFunctions([...weights.keys()]);
  const folded = new Map<string, PerfLeafAttribution>();
  for (const [callchainId, samples] of weights) {
    const functions = functionsByChain.get(callchainId);
    const leaf = functions?.[functions.length - 1];
    if (leaf === undefined || leaf.symbol === '') continue;
    const key = `${leaf.filePath}\u0000${leaf.symbol}`;
    const row = folded.get(key);
    if (row) row.samples += samples;
    else folded.set(key, { symbol: leaf.symbol, filePath: leaf.filePath, samples });
  }
  return [...folded.values()].sort((a, b) =>
    b.samples - a.samples ||
    (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) ||
    (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
}
```

Keep `foldedStacks` output byte-identical; it must still skip chains with no frames and join symbols in depth order.

- [ ] **Step 4: Run green**

Run the same command. Expected: PASS (existing PerfQuery tests plus 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/perf.ts packages/core/test/query-callstack-perf.test.ts
git commit -m "feat(core): attribute perf samples to leaf symbols and files"
```

---

### Task 2: `FrameLoadIndex`

**Files:**
- Create: `packages/core/src/analyze/frame-load.ts`
- Test: `packages/core/test/frame-load.test.ts`

**Interfaces:**
- Consumes: `PerfQuery.threads`, `PerfQuery.samples`; `Frame.ts`, `ts`, `dur`.
- Produces: `export interface FrameLoadThread { threadId: number; threadName: string; samples: number }`
- Produces: `export class FrameLoadIndex` with `static build(input: { perf: PerfQuery; pids: readonly number[]; range: TimeRange }): FrameLoadIndex | undefined`, readonly `sampleRows`, `threadCount`, `spanWeight`, `load(frame: Pick<Frame,'ts'|'dur'>): number`, `threadLoads(frame: Pick<Frame,'ts'|'dur'>): FrameLoadThread[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/frame-load.test.ts` with a shared fixture builder (also used by Task 3):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { PerfQuery } from '../src/query/perf';
import { FrameLoadIndex } from '../src/analyze/frame-load';

let dir: string;

export const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
  flag INT, depth INT, frame_no INT)`;
export const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
export const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;
export const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT,
  process_id INT, thread_name TEXT)`;
export const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT,
  timeStamp INT, thread_id INT, event_count INT, event_type_id INT,
  timestamp_trace INT, cpu_id INT, thread_state TEXT)`;

/** Two app threads, one other-process thread, samples straddling frame edges. */
export function perfDb(name: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES
    (0, 100, 4999, 'main'), (1, 101, 4999, 'worker'), (2, 102, 6000, 'other')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
    (1, 10, 1999, 100, 7, 1, 1999, 0, 'S'),
    (2, 11, 2000, 101, 3, 1, 2000, 0, 'S'),
    (3, 11, 2001, 101, 11, 1, 2001, 0, 'S'),
    (4, 12, 500, 102, 13, 1, 500, 0, 'S'),
    (5, 13, 3000, 100, 99, 1, 3000, 0, 'S')`);
  d.close();
  return openDb(path);
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ohosperf-frameload-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('FrameLoadIndex', () => {
  it('sums app-thread event_count inside an inclusive frame window', () => {
    const db = perfDb('index.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index).toBeDefined();
      // [1000,2000]: 5 + 7 (thread 100) + 3 (thread 101 at the inclusive end).
      expect(index.load({ ts: 1000, dur: 1000 })).toBe(15);
      // [1500,2500]: 7 + 3 + 11.
      expect(index.load({ ts: 1500, dur: 1000 })).toBe(21);
      expect(index.sampleRows).toBe(4);
      expect(index.threadCount).toBe(2);
      // Unique weight: 5 + 7 + 3 + 11. Frame loads above overlap and sum to 36.
      expect(index.spanWeight).toBe(26);
    } finally {
      db.close();
    }
  });

  it('counts a sample exactly at ts in a zero-duration frame', () => {
    const db = perfDb('point.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index.load({ ts: 2000, dur: 0 })).toBe(3);
    } finally {
      db.close();
    }
  });

  it('splits a frame window by app thread, sorted by weight then thread id', () => {
    const db = perfDb('threads.db');
    try {
      const index = FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999],
        range: { startNs: 1000, endNs: 2500 },
      })!;
      expect(index.threadLoads({ ts: 1000, dur: 1000 })).toEqual([
        { threadId: 100, threadName: 'main', samples: 12 },
        { threadId: 101, threadName: 'worker', samples: 3 },
      ]);
      expect(index.threadLoads({ ts: 1500, dur: 1000 })).toEqual([
        { threadId: 101, threadName: 'worker', samples: 14 },
        { threadId: 100, threadName: 'main', samples: 7 },
      ]);
    } finally {
      db.close();
    }
  });

  it('returns undefined without perf rows or without app threads', () => {
    const empty = join(dir, 'empty.db');
    const d = new DatabaseSync(empty);
    d.exec(PERF_THREAD_DDL);
    d.exec(PERF_SAMPLE_DDL);
    d.close();
    const db = openDb(empty);
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(db), pids: [4999], range: { startNs: 0, endNs: 10 },
      })).toBeUndefined();
    } finally {
      db.close();
    }
    const noTables = openDb(join(dir, 'empty2.db'));
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(noTables), pids: [4999], range: { startNs: 0, endNs: 10 },
      })).toBeUndefined();
    } finally {
      noTables.close();
    }
    const db2 = perfDb('no-app-thread.db');
    try {
      expect(FrameLoadIndex.build({
        perf: new PerfQuery(db2), pids: [7777], range: { startNs: 0, endNs: 5000 },
      })).toBeUndefined();
    } finally {
      db2.close();
    }
  });
});
```

Note: `perfDb` opens a file named `no-app-thread.db` but writes the standard
rows; only the pid selection differs.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/frame-load.test.ts`
Expected: FAIL — module `../src/analyze/frame-load` not found.

- [ ] **Step 3: Implement `FrameLoadIndex`**

Implementation notes:

- `perf.hasSamples()` false → `undefined`.
- Calls `perf.threads(pids)`; unique `threadId`s sorted ascending. Empty → `undefined`.
- Calls `perf.samples(threadIds, range)`; empty → `undefined`.
- Group rows by `threadId` preserving the query's `(timestamp_trace, id)` order; store `{ts, count}` and a parallel sorted `timestamps` array.
- `load`/`threadLoads` use lower bound (`ts >= frame.ts`) and upper bound (`ts <= frame.ts + frame.dur`) per thread. `dur <= 0` means `[ts, ts]`.
- Thread names from `perf_thread`; `''` stays `''`; a thread id absent from the map reads `'unknown'`.
- `threadLoads` drops zero-weight threads and sorts by `samples desc`, then `threadId asc`.
- Constructor is `private`; the class is exposed for the analyzer and queries.

- [ ] **Step 4: Run green**

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/frame-load.ts packages/core/test/frame-load.test.ts
git commit -m "feat(core): add batched frame load index"
```

---

### Task 3: `frame-load` analyzer

**Files:**
- Modify: `packages/core/src/analyze/frame-load.ts` (add `FrameLoadAnalyzer`)
- Modify: `packages/core/src/analyze/engine.ts` (register after `FrameAnalyzer`)
- Modify: `packages/core/src/report/model.ts` (`'frame-load': 'Frame load'`)
- Modify: `packages/core/src/index.ts` (export `FrameLoadAnalyzer`, `FrameLoadIndex`, `FrameLoadThread`)
- Modify: `packages/core/test/analyze-engine.test.ts` (default analyzer list)
- Test: `packages/core/test/frame-load.test.ts` (analyzer block)

**Interfaces:**
- Consumes: `FrameLoadIndex`, `resolveAppIpids`, `ctx.perf`, `ctx.frames`, `ctx.processes`.
- Produces: `FrameLoadAnalyzer` with `id = 'frame-load'`, `requires = ['trace.frames', 'perf.samples']`.
- Produces metric ids: `frame.load.frames.count`, `frame.load.total`, `frame.load.avg`, `frame.load.min`, `frame.load.max`, `frame.load.top10.share`, `frame.load.span.weight`, `frame.load.degraded`.
- Produces evidence kind `frame_load` (add to `EvidenceKind`).

- [ ] **Step 1: Write the failing analyzer tests**

Add a trace builder to `frame-load.test.ts`:

```ts
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { FrameLoadAnalyzer } from '../src/analyze/frame-load';
import type { AnalyzeContext } from '../src/analyze/types';
import { CapabilityMatrix } from '../src/device/capability';

function traceWith(name: string, framesSql: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(FRAME_DDL);
  d.exec(PROCESS_DDL);
  d.exec(THREAD_DDL);
  d.exec(`INSERT INTO process VALUES
    (0, 17, 4999, 'com.demo', 0, 0, 1, 1, 0),
    (1, 18, 6000, 'render_service', 0, 0, 1, 1, 0)`);
  d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'main', 0, 0, 17, 1, 0)`);
  d.exec(`INSERT INTO frame_slice VALUES ${framesSql}`);
  d.close();
  return openDb(path);
}

function ctxFor(db: QueryHandle, perf?: QueryHandle): AnalyzeContext {
  const caps = new CapabilityMatrix(['trace.frames', 'perf.samples'].map((id) => ({
    id, available: true, collector: 'x', fidelity: 'exact' as const,
    probe: { command: 'p', stdout: '', stderr: '', code: 0 },
  })));
  return {
    frames: new FrameQuery(db), processes: new ProcessQuery(db),
    ...(perf === undefined ? {} : { perf: new PerfQuery(perf) }),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 10_000 },
    caps, deviceId: 'emu',
  };
}

describe('FrameLoadAnalyzer', () => {
  it('reports per-frame load for rendered app actual frames only', async () => {
    const trace = traceWith('analyzer.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0),
      (2, 4000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 2, 0, 0),
      (3, 5000, 0, 17, 44, 0, 1000, '', 0, 1, 'expect', 0, 0, 0),
      (4, 6000, 0, 18, 45, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    const perf = perfDb('analyzer-perf.db');
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.load.frames.count').value).toBe(2);
      expect(get('frame.load.total').value).toBe(36);
      expect(get('frame.load.avg').value).toBe(18);
      expect(get('frame.load.min').value).toBe(15);
      expect(get('frame.load.max').value).toBe(21);
      expect(get('frame.load.top10.share').value).toBeCloseTo(100, 5);
      expect(get('frame.load.span.weight').value).toBe(26);
      expect(get('frame.load.total').provenance).toEqual({
        collector: 'hiperf', table: 'perf_sample', rows: 4, device: 'emu',
      });
      for (const m of r.metrics) expect(Number.isFinite(m.value as number)).toBe(true);
    } finally { trace.close(); perf.close(); }
  });

  it('emits top-frame evidence ranked by load with attribution signals', async () => {
    const trace = traceWith('analyzer-rank.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0)`);
    const perf = perfDb('analyzer-rank-perf.db');
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const ev = r.evidence.filter((e) => e.kind === 'frame_load');
      expect(ev).toHaveLength(2);
      // Evidence is chronological; rank carries the load ordering.
      expect(ev.map((e) => [e.window.startNs, e.signals.rank])).toEqual([
        [1000, 2], [1500, 1],
      ]);
      expect(ev[1].signals.load).toBe(21);
      expect(ev[1].signals.topThread).toBe('worker');
      expect(ev[1].signals.topThreadLoad).toBe(14);
      expect(ev[1].drillDown.map((d) => d.tool)).toEqual([
        'frames.get', 'frame.load.threads', 'frame.load.symbols', 'callstack.range',
      ]);
      expect(ev[1].explain).toContain('sampled events');
    } finally { trace.close(); perf.close(); }
  });

  it('degrades without perf samples instead of reporting zeros', async () => {
    const trace = traceWith('analyzer-noperf.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    try {
      const r = await new FrameLoadAnalyzer().run(ctxFor(trace));
      expect(r.metrics.map((m) => m.id)).toEqual(['frame.load.degraded']);
      expect(r.metrics[0].fidelity).toBe('proxy');
      expect(r.metrics[0].degraded?.reason).toMatch(/perf samples|--hiperf/);
      expect(r.evidence[0].kind).toBe('no_data');
    } finally { trace.close(); }
  });

  it('degrades when samples exist but none fall inside a frame window', async () => {
    // perf samples at 900000+, frames at 1000: the time bases do not meet.
    const trace = traceWith('analyzer-mismatch.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0)`);
    const perf = perfDb('analyzer-mismatch-perf.db');
    try {
      const c = ctxFor(trace, perf);
      c.window = { startNs: 0, endNs: 2_000_000 };
      const r = await new FrameLoadAnalyzer().run(c);
      expect(r.metrics.map((m) => m.id)).toEqual(['frame.load.degraded']);
      expect(r.metrics[0].degraded?.reason).toMatch(/time base|inside any frame/);
    } finally { trace.close(); perf.close(); }
  });

  it('is deterministic across runs', async () => {
    const trace = traceWith('analyzer-det.db', `
      (0, 1000, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 0, 0, 0),
      (1, 1500, 0, 17, 44, 0, 1000, '', 0, 0, 'actual', 1, 0, 0)`);
    const perf = perfDb('analyzer-det-perf.db');
    try {
      const a = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      const b = await new FrameLoadAnalyzer().run(ctxFor(trace, perf));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally { trace.close(); perf.close(); }
  });
});
```

**Note on the mismatch fixture:** build a dedicated perf database containing
only one app sample at `timestamp_trace = 900_000`
(`INSERT INTO perf_sample VALUES (0, 10, 900000, 100, 50, 1, 900000, 0, 'S')`)
and the standard `perf_thread` rows. The frame spans 1000–2000 and the test
uses `ctx.window = { startNs: 0, endNs: 2_000_000 }`, so the index range
(which expands the window to cover the frame span) contains the sample:
`spanWeight = 50`, every frame load is 0 → the time-base degraded branch.
The normal fixtures use samples at 1000–3000, which do fall inside frames.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/frame-load.test.ts`
Expected: FAIL — `FrameLoadAnalyzer` not exported.

- [ ] **Step 3: Implement the analyzer**

Rules:

- `resolveAppIpids(ctx.processes, ctx.app.pids)`; empty → degraded reason
  `no app process was identified in this trace, so frame load cannot be attributed`.
- `all = ctx.frames.all(ctx.window)`; `frames = all.filter(type === 0 && ipids.includes(ipid))`;
  `rendered = frames.filter(flag !== 2)`.
- `ctx.perf === undefined || !ctx.perf.hasSamples()` → degraded
  `no perf samples: the scene was captured without --hiperf, or the app was not debuggable so perf recorded nothing`.
- Index range: `{ startNs: min(ctx.window.startNs, firstFrameTs), endNs: max(ctx.window.endNs, lastFrameEnd) }`; `undefined` index → degraded
  `no perf threads or samples for the app processes in this window`.
- `rendered.length === 0` → `metrics: []`, one `no_data` evidence
  (`key: 'frame-load:no-frames'`, explain names empty/expect-only frames,
  drill-down `frames.all`).
- If `rendered.every(f => index.load(f) === 0) && index.spanWeight > 0` → degraded
  reason `perf samples exist but none fall inside any app frame window; frame and perf timestamps may use different time bases`.
- Metrics: `frames.count` = rendered.length, `total` = sum loads, `avg =
  total/len`, `min`, `max`, `top10.share = top10Sum/total*100` (0 when total 0),
  `span.weight` = index.spanWeight. Provenance `{collector:'hiperf',
  table:'perf_sample', rows: index.sampleRows, device: ctx.deviceId}`, window
  `ctx.window`, fidelity `exact`.
- Rank rendered frames by `load desc, ts asc, id asc`; take 10. Process name
  via `ctx.processes.all()` lowest `process.id` per ipid; unresolved →
  `ipid:<n>`. Evidence: kind `frame_load`, severity `info`, subject process +
  frameNo, window frame interval, signals `{rank, load, share, durMs, offsetMs,
  vsync, flag, topThread, topThreadLoad}` where `share = load/total*100` (0
  when total 0), `offsetMs = (ts - firstFrameTs)/1e6`, and the top thread comes
  from `index.threadLoads(frame)[0]` (`'unknown'`/0 when none). Explain:
  `${process} frame at ${offsetMs.toFixed(1)}ms cost ${load} sampled events
  (${share.toFixed(1)}% of frame load, dur ${durMs.toFixed(1)}ms, flag ${flag})`.
  Drill-downs exactly as the test lists.
- `degradedResult` emits `frame.load.degraded` (unit count, fidelity proxy,
  `degraded: {reason, fallback: 'no frame load'}`) plus a `no_data` evidence
  with key `'frame-load:no-data'` and `frames.all` drill-down.
- Sort metrics by id, evidence by `(kind, window.startNs, id)`.

Then register `new FrameLoadAnalyzer()` after `new FrameAnalyzer()`; update
`analyze-engine.test.ts`'s id list and instanceof list; add
`'frame-load': 'Frame load'` to `SECTION_TITLES`; export from `index.ts`;
add `'frame_load'` to `EvidenceKind`.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/frame-load.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/frame-load.ts packages/core/src/analyze/engine.ts \
  packages/core/src/report/model.ts packages/core/src/report/evidence.ts \
  packages/core/src/index.ts packages/core/test/frame-load.test.ts \
  packages/core/test/analyze-engine.test.ts
git commit -m "feat(core): add the frame-load analyzer"
```

---

### Task 4: Stutter levels and per-process breakdown

**Files:**
- Modify: `packages/core/src/analyze/frames.ts`
- Test: `packages/core/test/analyze-frames.test.ts`

**Interfaces:**
- Consumes: existing `frames`, `processNames` map.
- Produces metric ids: `frame.stutter.count`, `frame.stutter.unpaired.count`,
  `frame.stutter.level1.count`, `frame.stutter.level2.count`,
  `frame.stutter.level3.count`, `frame.stutter.ui.count`,
  `frame.stutter.render.count`, `frame.stutter.sceneboard.count`,
  `frame.stutter.ui.rate`, `frame.stutter.render.rate`,
  `frame.stutter.sceneboard.rate`.
- Produces jank evidence signals `excessMs`, `excessFrames`, `stutterLevel`
  (only when paired) and an explain suffix `; level N (excess Xms over
  expected Yms)`.

- [ ] **Step 1: Write the failing tests**

```ts
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
  // `excessFrames < 6` is false at exactly 6.
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
```

Update the existing exact-id-list test at the end of `analyze-frames.test.ts`
to the full sorted list after implementation (run the test to read the actual
ids; do not guess). Also update `e2e-offline.test.ts` only if it asserts the
metric id list (it does not).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/analyze-frames.test.ts`
Expected: FAIL — `frame.stutter.count` undefined.

- [ ] **Step 3: Implement in `frames.ts`**

- Build `expectedByVsync: Map<number, Frame>` from `frames` sorted by
  `(ts, id)`: first `type === 1` per vsync.
- For each stuttered frame: expected = map.get(vsync). If present:
  `excessNs = dur - expected.dur`; `excessFrames = excessNs / 1e6 / 16.67`;
  level as spec. Push `{frame, excessNs, excessFrames, level}` into a paired
  list; else increment unpaired.
- Extend `jankEvidence` to accept an optional pairing and append signals +
  explain suffix. Keep the existing explain text byte-identical when unpaired.
- Process classes: build the ipid→name map whenever there are stuttered frames
  (also needed for class metrics); `classOf(name)` per spec; unresolved name →
  `'ui'`.
- Rendered frames per class for rates (rendered set is already computed).
- Add the 11 metrics with `provenance(ctx, frames.length)`.
- Sorted metrics/evidence as before.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/analyze-frames.test.ts packages/core/test/e2e-offline.test.ts packages/core/test/parity-hapray.test.ts`
Expected: PASS (e2e may skip without the fixture; the parity fixtures are
checked in).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/frames.ts packages/core/test/analyze-frames.test.ts
git commit -m "feat(core): grade stutter levels and split them by process class"
```

---

### Task 5: FPS windows

**Files:**
- Create: `packages/core/src/analyze/fps.ts`
- Modify: `packages/core/src/analyze/frames.ts` (window metrics)
- Modify: `packages/core/src/index.ts` (export `computeFpsWindows`, `FpsWindow`)
- Test: `packages/core/test/analyze-fps.test.ts`; extend `analyze-frames.test.ts`

**Interfaces:**
- Produces: `export interface FpsWindow { startNs: number; endNs: number; frames: number; fps: number }`
- Produces: `export function computeFpsWindows(frames: readonly Frame[], windowMs?: number): FpsWindow[]`
- Produces metric ids: `frame.fps.window.count`, `frame.fps.window.min`,
  `frame.fps.window.max`, `frame.fps.window.mean`.

- [ ] **Step 1: Write failing tests**

`analyze-fps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeFpsWindows } from '../src/analyze/fps';
import type { Frame } from '../src/query/frames';

function f(ts: number, dur = 0, flag: 0 | 1 | 2 = 0, type: 0 | 1 = 0, id = ts): Frame {
  return { id, ts, dur, vsync: 0, ipid: 17, itid: 44, callstackId: 0,
    flag, type, typeDesc: '', src: '', dst: 0, depth: 0, frameNo: 0 };
}

describe('computeFpsWindows', () => {
  it('tiles fixed 1s windows and counts rendered frames only', () => {
    const frames = Array.from({ length: 10 }, (_, i) => f(i * 100_000_000, 10_000_000));
    const windows = computeFpsWindows([...frames, f(950_000_000, 0, 2), f(960_000_000, 0, 0, 1)]);
    expect(windows).toEqual([{ startNs: 0, endNs: 1_000_000_000, frames: 10, fps: 10 }]);
  });

  it('puts a frame on a window boundary into the next window', () => {
    expect(computeFpsWindows([f(0), f(1_000_000_000)])).toEqual([
      { startNs: 0, endNs: 1_000_000_000, frames: 1, fps: 1 },
      { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('emits explicit zero windows across an idle gap', () => {
    expect(computeFpsWindows([f(0), f(3_500_000_000)])).toEqual([
      { startNs: 0, endNs: 1_000_000_000, frames: 1, fps: 1 },
      { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 0, fps: 0 },
      { startNs: 2_000_000_000, endNs: 3_000_000_000, frames: 0, fps: 0 },
      { startNs: 3_000_000_000, endNs: 4_000_000_000, frames: 1, fps: 1 },
    ]);
  });

  it('returns [] for no rendered frames and is deterministic', () => {
    expect(computeFpsWindows([])).toEqual([]);
    expect(computeFpsWindows([f(5, 0, 2)])).toEqual([]);
    const frames = [f(300), f(100), f(200)];
    expect(JSON.stringify(computeFpsWindows(frames)))
      .toBe(JSON.stringify(computeFpsWindows([...frames].reverse())));
  });
});
```

**FrameAnalyzer test:**

```ts
it('reports 1-second fps window statistics', async () => {
  // 11 frames 100ms apart: window 1 holds 10 (10 fps), window 2 holds the
  // frame exactly at the boundary (1 fps).
  const narrow = withDb('fps-windows.db', (d) => {
    d.exec(FRAME_DDL);
    d.exec(INSERT_11_FRAMES);   // same rows as 'fps-span.db'
    d.exec(PROCESS_DDL); d.exec(THREAD_DDL);
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
  } finally { narrow.close(); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/analyze-fps.test.ts packages/core/test/analyze-frames.test.ts`
Expected: FAIL — module not found / metric undefined.

- [ ] **Step 3: Implement**

`fps.ts`: filter `type === 0 && flag !== 2`; dedupe by `id` (a Set); sort by
`ts` then `id`; if none return `[]`. `windowMs` default 1000; guard
`windowMs > 0` else return `[]`. Anchor `start = first.ts`. For each frame:
`while (frame.ts >= end) { push window; start = end; end = start + windowMs*1e6 }`;
increment the current window's count. After the loop push the last window.
Window fps = `frames / (windowMs / 1000)`; the window list is already sorted by
start.

`frames.ts`: after the existing metrics, if `rendered.length > 0`:
`const windows = computeFpsWindows(rendered)`; push the four metrics, all
`unit: 'fps'` except count, fidelity `'exact'`, provenance `prov`. Pure
function; no globals.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/analyze-fps.test.ts packages/core/test/analyze-frames.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/fps.ts packages/core/src/analyze/frames.ts \
  packages/core/src/index.ts packages/core/test/analyze-fps.test.ts \
  packages/core/test/analyze-frames.test.ts
git commit -m "feat(core): add 1-second fps window statistics"
```

---

### Task 6: Empty-frame load, share and severity

**Files:**
- Modify: `packages/core/src/analyze/empty-frame.ts`
- Test: `packages/core/test/analyze-empty-frame.test.ts`

**Interfaces:**
- Consumes: `FrameLoadIndex`.
- Produces metric ids: `empty_frame.load.total`, `empty_frame.load.share`,
  `empty_frame.load.severity`, `empty_frame.load.degraded`.
- Extends empty-frame evidence signals with `load`, `loadShare`, `loadRank`.

- [ ] **Step 1: Write failing tests**

Use the existing `dbWith` fixture and add perf tables when requested. Add a
`perf` option to the fixture helper:

```ts
interface Fixture {
  frames?: Frame[];
  events?: ReturnType<typeof event>[];
  perf?: Array<{ id: number; ts: number; threadId: number; count: number }>;
}
```

After the existing tables, create `perf_thread`/`perf_sample` when
`fixture.perf` is present, with app threads `(100, 'main')`, `(101, 'worker')`
for pid 4999 and a sample row per entry.

Tests:

```ts
it('reports empty-frame load, share and severity from exact windows', async () => {
  const db = dbWith('empty-load.db', {
    frames: [
      frame(0, 1_000_000_000, 1, 0, 44, 17, 100_000_000),   // rendered, 50+50
      frame(1, 2_000_000_000, 2, 2, 44, 17, 100_000_000),   // empty, 3
      frame(2, 3_000_000_000, 3, 0, 44, 17, 100_000_000),   // rendered, 0
    ],
    perf: [
      { id: 0, ts: 1_050_000_000, threadId: 100, count: 50 },
      { id: 1, ts: 1_080_000_000, threadId: 101, count: 50 },
      { id: 2, ts: 2_050_000_000, threadId: 100, count: 3 },
    ],
  });
  const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
  const get = (id: string) => metricOf(r, id);
  expect(get('empty_frame.load.total').value).toBe(3);
  // Loads: 100 + 3 + 0 = 103; 3 / 103 * 100 = 2.9126...% -> normal.
  expect(get('empty_frame.load.share').value).toBeCloseTo(2.9126, 3);
  expect(get('empty_frame.load.severity').value).toBe('normal');
  expect(metricOf(r, 'empty_frame.count').value).toBe(1);
});

it('grades load share at 3, 10 and 100 percent boundaries', async () => {
  const severity = async (emptyCount: number) => {
    const db = dbWith(`empty-sev-${emptyCount}.db`, {
      frames: [
        frame(0, 1_000_000_000, 1, 0, 44, 17, 100_000_000),
        frame(1, 2_000_000_000, 2, 2, 44, 17, 100_000_000),
      ],
      perf: [
        { id: 0, ts: 1_050_000_000, threadId: 100, count: 97 },
        { id: 1, ts: 2_050_000_000, threadId: 100, count: emptyCount },
      ],
    });
    try {
      return metricOf(await new EmptyFrameAnalyzer().run(ctxWith(db)),
        'empty_frame.load.severity').value;
    } finally { db.close(); }
  };
  expect(await severity(2)).toBe('normal');     // 2/99 = 2.02%
  expect(await severity(3)).toBe('moderate');   // 3/100 = 3%
  expect(await severity(10)).toBe('moderate');  // 10/107 = 9.35%
  expect(await severity(11)).toBe('severe');    // 11/108 = 10.19%
});

it('degrades empty-frame load without perf samples', async () => {
  const db = dbWith('empty-load-noperf.db', {
    frames: [frame(0, 1_000_000_000, 1, 2)],
  });
  const r = await new EmptyFrameAnalyzer().run(ctxWith(db));
  expect(r.metrics.map((m) => m.id)).toContain('empty_frame.load.degraded');
  expect(r.metrics.some((m) => m.id === 'empty_frame.load.total')).toBe(false);
  expect(metricOf(r, 'empty_frame.count').value).toBe(1);
});
```

Add `perf: new PerfQuery(target)` to `ctxWith` unconditionally — `PerfQuery`
returns `false` from `hasSamples()` when the tables are absent, so the
existing no-perf tests keep their behavior.

The existing test "emits one evidence item per confirmed frame over its own
window" asserts `drillDown` exactly; extend its expected array with the new
`frame.load.symbols` handle in the order `frames.get`, `frame.load.symbols`.
Every existing fixture without perf tables now also gets
`empty_frame.load.degraded`; no existing assertion counts metrics except the
no-app-frames case, which stays `[]`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/analyze-empty-frame.test.ts`
Expected: FAIL — `empty_frame.load.total` missing.

- [ ] **Step 3: Implement**

- Build the index over all app actual frames when `ctx.perf?.hasSamples()`:
  range `[ctx.window.startNs, ctx.window.endNs]` intersected with the frame
  span (use `min(ctx.window.startNs, firstFrameTs)` /
  `max(ctx.window.endNs, lastFrameEnd)` as in Task 3 so samples outside the
  window but inside the frame span are visible for the mismatch guard).
- If no index: push `empty_frame.load.degraded` proxy with reason
  `no perf samples: the scene was captured without --hiperf...` (same wording
  as frame-load); skip the three load metrics.
- If index exists: sum loads over confirmed empties (`emptyLoad`) and over all
  app actual frames (`totalLoad`); share = `totalLoad > 0 ? emptyLoad/totalLoad*100 : 0`;
  severity per ladder; add the three metrics (`total` count exact, `share` %
  exact, `severity` unit none value label exact). Guard: `index.spanWeight > 0
  && totalLoad === 0` → degraded metric with the time-base reason instead of
  the three.
- Evidence per confirmed empty frame gets `load`, `loadShare` (vs totalLoad)
  and `loadRank` (rank among confirmed empties by load desc, ts asc, id asc;
  top 10 get their ordinal, the rest `0`).
- Ordering and provenance unchanged.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/analyze-empty-frame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/empty-frame.ts packages/core/test/analyze-empty-frame.test.ts
git commit -m "feat(core): measure empty-frame load and severity"
```

---

### Task 7: Named queries and report integration

**Files:**
- Modify: `packages/core/src/query/registry.ts` (four definitions)
- Modify: `packages/core/src/index.ts` if new types need exporting (`FpsWindow` already exported in Task 5; export `PerfLeafAttribution` type)
- Test: `packages/core/test/query-registry.test.ts` (or a new `query-frame-load.test.ts`)
- Test: `packages/core/test/drilldown.test.ts` remains green (it scans tool literals)

**Interfaces:**
- Consumes: `computeFpsWindows`, `FrameLoadIndex`, `PerfQuery.leafAttribution`.
- Produces query names and row shapes exactly as the spec table.

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/query-frame-load.test.ts` with a fixture combining
`frame_slice`, `perf_thread`, `perf_sample`, `perf_callchain`, `perf_files`
and `process`; use the Task 2 sample fixture plus two callchains:

```ts
function ctx(db: QueryHandle): QueryContext {
  return {
    db,
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
  };
}
```

Tests:

```ts
it('returns the 1s fps series for a window', () => {
  const r = runNamedQuery(ctx(db), 'frames.fpsSeries',
    { startNs: 0, endNs: 5_000_000_000 });
  expect(r.rows).toEqual([
    { startNs: 1_000_000_000, endNs: 2_000_000_000, frames: 10, fps: 10 },
    { startNs: 2_000_000_000, endNs: 3_000_000_000, frames: 1, fps: 1 },
  ]);
});

it('splits a frame window by thread with shares', () => {
  const r = runNamedQuery(ctx(db), 'frame.load.threads',
    { startNs: 1000, endNs: 2000 });
  expect(r.rows).toEqual([
    { threadId: 100, threadName: 'main', samples: 12, share: 80 },
    { threadId: 101, threadName: 'worker', samples: 3, share: 20 },
  ]);
});

it('attributes symbols and files with shares of the window weight', () => {
  expect(runNamedQuery(ctx(db), 'frame.load.symbols',
    { startNs: 1000, endNs: 2000 }).rows).toEqual([
    { symbol: 'leafB()', filePath: '/lib/libb.so', samples: 12, share: 80 },
    { symbol: 'leafA()', filePath: '/lib/liba.so', samples: 3, share: 20 },
  ]);
  expect(runNamedQuery(ctx(db), 'frame.load.files',
    { startNs: 1000, endNs: 2000 }).rows).toEqual([
    { filePath: '/lib/libb.so', samples: 12, share: 80 },
    { filePath: '/lib/liba.so', samples: 3, share: 20 },
  ]);
});

it('returns [] without perf tables and validates required args', () => {
  const bare = ctx(openDb(join(dir, 'bare.db')));
  expect(runNamedQuery(bare, 'frame.load.threads', { startNs: 0, endNs: 1 }).rows).toEqual([]);
  expect(runNamedQuery(bare, 'frame.load.symbols', { startNs: 0, endNs: 1 }).rows).toEqual([]);
  expect(runNamedQuery(bare, 'frame.load.files', { startNs: 0, endNs: 1 }).rows).toEqual([]);
  expect(() => runNamedQuery(bare, 'frames.fpsSeries', {})).toThrow(/startNs/);
});
```

Define the fixture exactly: frames at 1.0 s…1.9 s (10 rendered) + 2.0 s (one
rendered) → fps series as above; chain 10 weight 12 leaf `leafB()`
(`/lib/libb.so`) on thread 100; chain 11 weight 3 leaf `leafA()`
(`/lib/liba.so`) on thread 101. Shares: 12/15 = 80, 3/15 = 20.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/query-frame-load.test.ts`
Expected: FAIL — `unknown query "frames.fpsSeries"`.

- [ ] **Step 3: Implement the four definitions**

- `frames.fpsSeries`: required `startNs`/`endNs`
  (`rangeArg` returns undefined only when both are absent; require it), rows
  `computeFpsWindows(new FrameQuery(ctx.db).all(range))`.
- `frame.load.threads`: required range; `pids = ctx.app.pids`; empty → `[]`;
  build `FrameLoadIndex` over the range with a synthetic frame
  `{ts: range.startNs, dur: range.endNs - range.startNs}`; map rows to
  `{...row, share}` where share is over the sum of returned weights.
- `frame.load.symbols`: `perf = new PerfQuery(ctx.db)`;
  `threadIds` from `perf.threads(ctx.app.pids)` (unique, sorted); total =
  `perf.eventCount(threadIds, range)`; rows = `perf.leafAttribution(threadIds,
  range)` mapped with `share = total > 0 ? samples/total*100 : 0`.
- `frame.load.files`: same rows aggregated by `filePath` (`''` allowed),
  sorted by samples desc then filePath asc.
- Add all four to `DEFINITIONS`; descriptions must state the 1 s tumbling
  window and the sample-weight unit. `returns` values:
  `FpsWindow[]`, `FrameLoadThread[]`, `PerfLeafAttribution[]`,
  `PerfFileAttribution[]` (define the last interface locally in registry.ts or
  in `frame-load.ts` and export it).
- Run `npx vitest run --project unit packages/core/test/drilldown.test.ts`:
  every new tool literal must be registered.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/query-frame-load.test.ts packages/core/test/query-registry.test.ts packages/core/test/drilldown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/registry.ts packages/core/src/index.ts \
  packages/core/test/query-frame-load.test.ts
git commit -m "feat(core): expose fps series and frame attribution queries"
```

---

### Task 8: Docs, metadata and release 0.5.0

**Files:**
- Modify: `CHANGELOG.md` (new `## 0.5.0 — 2026-11-17` section)
- Modify: `README.md` (status, roadmap row, report bullet, test counts)
- Modify: `site/index.html` (hero, stats, shipped card, parity card, quickstart)
- Modify: `skill/ohos-perf/SKILL.md` (frame-load diagnostics and new queries)
- Modify: `packages/core/package.json`, `packages/cli/package.json`,
  `package-lock.json` (versions `0.5.0`, CLI dependency `0.5.0`)

- [ ] **Step 1: Rebuild and run everything**

```bash
npm run build -w @ohos-perf/core
npx tsc --noEmit -p packages/core/tsconfig.test.json
npx tsc --noEmit -p packages/cli/tsconfig.test.json
npm test
```

Expected: unit and device suites green; typechecks clean; record the exact
pass/skip counts for the README and site.

- [ ] **Step 2: Update docs**

- CHANGELOG: frame load definition with inclusive windows and
  `span.weight`; stutter levels with 2/6 thresholds; per-process split; 1 s
  FPS windows (fixed, unlike whole-span `frame.fps`); empty-frame load
  share/severity and the no-expansion difference from upstream; four named
  queries; degraded paths.
- README: P10 row `shipped in 0.5.0`; status counts; report bullet mentions
  frame load/attribution; quickstart query examples
  (`ohos-perf query --query frames.fpsSeries --arg startNs=… --arg endNs=…`;
  check the exact CLI syntax in `packages/cli/src/program.ts` before writing).
- Site: hero `P1–P10 …`; stat counts; new "Shipped · v0.5.0" card; parity
  card moves to `P11–P16`; roadmap table.
- Skill: add a "Frame load and stutter" section naming the metric families
  and the four tools; ensure the command list (if any) stays accurate — no new
  CLI command this release.

- [ ] **Step 3: Version bump**

```bash
npm pkg set version=0.5.0 -w @ohos-perf/core
npm pkg set version=0.5.0 -w @ohos-perf/cli
npm pkg set 'dependencies.@ohos-perf/core=0.5.0' -w @ohos-perf/cli
npm install --package-lock-only
```

- [ ] **Step 4: Commit, tag, push, release**

```bash
git add -A
git commit -m "chore(release): 0.5.0"
git tag v0.5.0
git push origin master --follow-tags
gh release create v0.5.0 --title "v0.5.0" --notes-file <(printf '...release notes...\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n')
```

Release notes: frame load/stutter/FPS summary, the two documented divergences
(no ±1 ms expansion; no `high_load_frames`), degraded behavior, artifact note.
Do not publish the LLM API key. `npm publish` only if the registry is
authenticated; otherwise leave the GitHub release's npm note.

- [ ] **Step 5: Verify CI and Pages**

```bash
sha=$(git rev-parse HEAD)
gh run list --limit 20 --json headSha,name,status,conclusion \
  --jq ".[] | select(.headSha==\"$sha\") | [.name,.status,.conclusion] | @tsv"
```

Expected: `ci success` and `pages success`. Fix before declaring the release
done.

---

## Self-review notes

- Spec coverage: frame load + index (Tasks 1–3), stutter levels/per-process
  (4), FPS windows (5), empty load/severity (6), attribution queries (7),
  release/docs (8). The spec's "no ±1 ms expansion", "no high_load_frames",
  and "no credit-assignment beyond the frame window" are honored by not
  implementing them.
- Type consistency: `FrameLoadThread` is used by Tasks 2, 3 and 7;
  `FpsWindow` by Tasks 5 and 7; `PerfLeafAttribution` by Tasks 1 and 7;
  `frame.load.threads/symbols/files` tool literals match the evidence
  drill-downs in Task 3.
- Review Focus tests: time-base guard (Task 3), overlap vs span weight
  (Task 2), inclusive boundaries (Tasks 2 and 5), deterministic pairing
  (Task 4), degenerate windows (Tasks 2, 5 and 6).
