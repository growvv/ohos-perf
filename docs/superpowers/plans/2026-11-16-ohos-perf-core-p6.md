# ohos-perf P6 Remaining HapRay Analysis Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the HapRay analyzers that are pure `trace.db` / `perf.db` algorithms — GC invocation pressure, VSync anomaly periods, empty-frame detection with its two false-positive filters, RenderService-skip reverse tracing, folded flamegraph stacks, and ArkUI component reuse — so `analyze` covers the analysis surface HapRay produces from a trace, not just the eight analyzers P1–P5 ported.

**Architecture:** Each analyzer is one focused module under `packages/core/src/analyze/`, gated by a capability id and driven by the existing `runAnalyzers` engine. SQL the typed query layer cannot yet express is added to the class that owns the table (`CallstackQuery` gains an `ipids` scope, `PerfQuery` gains weighted sample counts and folded stacks), so the analyzers stay free of ad-hoc SQL except where a cross-table join has no owner — and those places say why. Every new analyzer emits `Metric`s with provenance and `Evidence` with drill-down handles that resolve through the existing named-query registry.

**Tech Stack:** TypeScript (ESM), Vitest, `node:sqlite`, commander, npm workspaces. No new runtime dependencies.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` §5 (the GC, VSync, empty-frame, flamegraph and UI rows) and §11. The P6 row of `README.md`'s Roadmap is the scope statement.

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- Determinism contract (D5): identical inputs produce byte-identical JSON; every output array has an explicit, documented order. Metrics sort by `id`; evidence by `(kind, window.startNs, id)`; the engine rejects duplicate ids.
- A metric is emitted only when it is measured. An absent input yields either no metric or a `fidelity: 'proxy'` metric carrying `degraded.reason` — never a zero labeled `exact`.
- Analysis code performs no IO of its own; it reads through the query classes, or `ctx.db` when no query class covers the join.
- Ported algorithms keep HapRay's SQL predicates verbatim (including `LIKE` patterns, `COALESCE`, and process-name exclusions) and change only the pandas post-processing into array operations. Where this plan deliberately diverges from HapRay, the divergence is named in the task that makes it.
- Every `tool:` literal in an analyzer must be a registered named query (`packages/core/test/drilldown.test.ts` scans for them).
- Every new value export goes into `VALUE_EXPORTS` in `packages/core/test/types.test.ts`; every declared type must be exported from `packages/core/src/index.ts`.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Measured facts

Measured on 2026-11-16 from the two recorded traces (`spike/out/emu_big.db`, `spike/out/real_device.db`) and from HapRay itself at rev `9386e4e` (`.venv-win/Scripts/python.exe -I`, see `scripts/parity/README.md`). Tasks depend on these values verbatim; do not re-derive them by eye.

| Fact | Measured value |
| --- | --- |
| HapRay `GCAnalyzer`, `real_device`, pid 6115 | `{FullGC:0, SharedFullGC:0, SharedGC:0, PartialGC:2, GCStatus:"OK", perf_percentage:0.0}` |
| `real_device` `callstack` span | `565702509753784` … `565705160318367` = **2.650564583 s** |
| GC rows by process in `real_device` | ipid 5 (pid 6115) **2**, ipid 2 (pid 63785, `m.kugou.hmmusic`) **4** |
| HapRay `VSyncAnomalyAnalyzer`, `emu_big`, pid 16702 | 60 signals, **0** high-freq periods, **7** low-freq periods, **54** mismatches, anomaly rate **101.67** |
| The 7 `emu_big` periods, in interval order | `interval_count` **8, 12, 7, 6, 4, 9, 5**; every one `low_frequency_period`, severity **high** |
| HapRay `VSyncAnomalyAnalyzer`, `real_device`, pid 6115 | 160 signals, 0 periods, 0 mismatches, rate **0.0** |
| VSync groups, app vs device-wide | `emu_big` ipid 17: **60** of 169; `real_device` ipid 5: **160** of 231 |
| App frames | `emu_big` ipid 17: 66 rows (60 actual, 6 empty); `real_device` ipid 5: 320 rows (160 actual, **all** flag 2) |
| HapRay `EmptyFrameAnalyzer` | `emu_big`: 6 empty, **0** filtered; `real_device`: 160 empty, **0** filtered |
| Buffer events outside system processes | **0** on `real_device` — rule 1 filters nothing there |
| App empties with a non-empty `(vsync, itid)` sibling | **0** of 160 on `real_device` — rule 2 filters nothing there |
| `frame_slice` id 16 on `emu_big` | `dur` is **NULL** (the only NULL in either trace) |
| `DisplayNode skip` in `real_device` | **8** events, all on ipid 4 (`render_service`); **7** fall inside **4** RenderService frames |
| Those 4 RenderService frames | `frame_slice.id` **292, 304, 312, 316**; SQLite `rowid` **293, 305, 313, 317** |
| HapRay RS-skip trace on `real_device` | 4 frames, 7 events, **4 traced**, `trace_accuracy` **100.0**, all via `nativewindow` |
| Traced app frames | `frame_slice.id` **294, 306, 314, 318** (all flag 2, so all 4 are also forward-detected empties) |
| RS buffer events (`AcquireBuffer`/`DoFlushBuffer`/`ConsumeAndUpdateAllNodes`) | **537** on `real_device` |
| HapRay `ComponentReusableAnalyzer` on the 7-row synthetic trace | `{max_component:"ItemView", total_builds:4, recycled_builds:2, reusability_ratio:0.5, details:{"ItemView":[4,2],"Text":[3,0]}}` |
| `H:CustomNode:Build%` rows in either recorded trace | **0** |
| `perf_sample` rows in either recorded trace | **0** (the table exists; `PerfQuery.hasSamples()` is false) |
| `HITRACE_DEFAULT_CATEGORIES` | already contains `ark` and `ace`, so GC and build events are captured today |
| Python `round(x, 2)` | `0.125→0.12`, `0.375→0.38`, `2.675→2.67`, `1.005→1.0` (half-even on the exact double) |

## Out of scope

- **HapRay's `PerfAnalyzer` flamegraph output.** It shells out to the external `perf -i` binary and embeds the resulting `perf.json` in an HTML template. This plan builds the folded-stack aggregation those renderers consume, directly from `perf_sample`/`perf_callchain`/`perf_files`. No HTML is produced, and **no HapRay parity is claimed** for it.
- **UI animation analysis (component-tree diff + screenshot diff).** It needs `ui/<step>/pages.json`, two element-tree dumps and two screenshots per step, produced by HapRay's CaptureUI. No collector in this package produces them, and inventing a screenshot comparator would be a new subsystem, not a port. P6 ports the trace-side component signal (`H:CustomNode:Build*`) instead.
- **The RS-API reverse-trace path.** `frame_rs_skip_backtrack_api.py` traces through `UnMarshRSTransactionData`/`instant` events. The NativeWindow path succeeds on the recorded trace; P6 ports only that path and the metric says which method produced the trace.
- **`ui.gesture`, `coverage`, `js.heap`.** Unchanged; each stays reported unavailable with its reason.

## Review Focus

1. **A ratio whose denominator is zero must not read as a measured 0%.** An app with no actual frames has no empty-frame rate, and a trace with no `H:CustomNode:Build*` rows has no reuse ratio. `0 / 0` is unmeasured, not "perfect". Owned by Task 4 (empty-frame rate) and Task 7 (reuse rate).
2. **The GC rate's denominator is the whole `callstack` span, not the app's window.** HapRay divides by `max(ts) - min(ts)` over the entire table. On a 60 s trace where the app ran for 2.6 s, a rate computed from the app's own span is 23× higher and the `> 10 invocations and > 1/s` rule fires when HapRay says OK. Owned by Task 2.
3. **VSync analysis is per app.** `emu_big` has 60 app vsync groups out of 169 device-wide. Analyzing every group mixes sceneboard and RenderService cadence into the app's anomaly rate and changes HapRay's numbers. Owned by Task 3.
4. **A NULL `dur` is not a zero-length frame.** `num()` maps NULL to 0, which would make the NativeWindow false-positive window `[ts, ts]` and filter a frame whose event lands exactly on `ts`. HapRay's NaN comparison never matches. Owned by Task 4.
5. **`perf_sample.event_count` is the sample's weight, not 1.** Summing rows instead of `event_count` makes every flamegraph weight wrong by the sampling period. Owned by Task 6.

---

### Task 1: Add the `trace.ark` capability

**Files:**
- Modify: `packages/core/src/device/capability.ts` (the `CapabilityId` union and `RULES`)
- Modify: `packages/cli/src/deps.ts` (`TABLE_RULES`)
- Modify: `design/2026-11-14-ohos-perf-core-design.md` (§2 `CapabilityId` union, §7 capability table)
- Test: `packages/core/test/capability.test.ts`, `packages/cli/test/deps.test.ts`

**Interfaces:**
- Consumes: the existing `Rule` shape and the offline `TABLE_RULES` array.
- Produces: `CapabilityId` gains `'trace.ark'`; `buildMatrix` emits it as a hitrace row; `offlineCapabilities` grants it only when `callstack`, `thread` and `process` are all present. Tasks 2 and 7 gate on it.

GC phases and `H:CustomNode:Build*` events are Ark-runtime trace events. No
existing id means them: `trace.binder` names the binder tables (and would
require `args`/`data_dict`/`trace_range`, which GC never reads), and
`trace.frames` names `frame_slice`. The spec's §2 union lists 20 ids and its
§5 already assigns GC a module, so the union is one id behind the analysis
surface; this task closes that gap and edits the spec to match rather than
leaving code and spec disagreeing.

- [x] **Step 1: Write the failing tests**

In `packages/core/test/capability.test.ts`, change the count pin and add a row test:

```ts
it('emits exactly the 21 spec capability ids', () => {
  const ids = buildMatrix(FULL_DEVICE).all().map((s) => s.id);
  expect(ids).toHaveLength(21);
  expect(new Set(ids).size).toBe(21);
});

it('serves trace.ark from hitrace', () => {
  const m = buildMatrix(FULL_DEVICE);
  expect(m.get('trace.ark')!.collector).toBe('hitrace');
  expect(m.get('trace.ark')!.available).toBe(true);
  expect(buildMatrix(EMULATOR).get('trace.ark')!.available).toBe(true);
});
```

In `packages/cli/test/deps.test.ts`, inside the existing offline-matrix test,
next to the `trace.binder` assertions (reuse its local `fakeDb` helper):

```ts
const arkTables = ['callstack', 'thread', 'process'];
expect(offlineCapabilities(fakeDb(arkTables), {}).has('trace.ark')).toBe(true);
expect(offlineCapabilities(fakeDb(['callstack', 'thread']), {}).has('trace.ark')).toBe(false);
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/test/capability.test.ts packages/cli/test/deps.test.ts`
Expected: FAIL — `trace.ark` is not a `CapabilityId` (a compile error at the `get` call, `undefined` at runtime), and the matrix has 20 rows.

- [x] **Step 3: Implement the rule and edit the spec**

In `capability.ts`, add `| 'trace.ark'` to the union after `'trace.thread_state'`, and to `RULES` after `render.vsync`:

```ts
// Ark-runtime trace events (GC phases, CustomNode builds). The hitrace
// categories `ark` and `ace` are already in HITRACE_DEFAULT_CATEGORIES, so
// this row is about the trace content, not about a collector to add.
{ id: 'trace.ark', collector: 'hitrace', binary: 'hitrace' },
```

In `deps.ts`'s `TABLE_RULES`, after the `trace.thread_state` row:

```ts
// GC and component-build events are callstack rows scoped through thread and
// process; without either join the analyzers would crash rather than degrade.
{ id: 'trace.ark', collector: 'hitrace', tables: ['callstack', 'thread', 'process'] },
```

In the design doc, add `| 'trace.ark'` to the §2 union and a `trace.ark` row to
§7's table (`✅ exact` on both device columns, path `hitrace → callstack`).

- [x] **Step 4: Run them to verify they pass**

Run: `npx vitest run packages/core/test/capability.test.ts packages/cli/test/deps.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/device/capability.ts packages/cli/src/deps.ts \
  design/2026-11-14-ohos-perf-core-design.md \
  packages/core/test/capability.test.ts packages/cli/test/deps.test.ts
git commit -m "feat: add the trace.ark capability for Ark-runtime events"
```

---

### Task 2: GC pressure analyzer

**Files:**
- Modify: `packages/core/src/query/callstack.ts` (`matching`, `countMatching`)
- Modify: `packages/core/src/query/perf.ts` (`eventCount`, `threadIdsNamed`)
- Modify: `packages/core/src/analyze/context.ts` (new `resolveAppIpids`)
- Modify: `packages/core/src/analyze/mem-measure.ts`, `packages/core/src/analyze/startup.ts` (use the shared helper)
- Modify: `packages/core/src/report/evidence.ts` (add `'gc_pressure'`)
- Create: `packages/core/src/analyze/gc.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/src/report/compare.ts`
- Test: `packages/core/test/query-callstack-perf.test.ts`, `packages/core/test/analyze-gc.test.ts` (new)

**Interfaces:**
- Consumes: `QueryHandle`, `CallstackQuery`, `PerfQuery`, `ProcessQuery`, `AnalyzeContext`.
- Produces:
  ```ts
  // query/callstack.ts
  matching(pattern: string, opts: { range?: TimeRange; limit?: number; ipids?: readonly number[] }): CallstackEvent[]
  countMatching(pattern: string, opts: { range?: TimeRange; ipids?: readonly number[] }): number
  // query/perf.ts
  eventCount(threadIds?: readonly number[]): number
  threadIdsNamed(pids: readonly number[], threadName: string): number[]
  // analyze/context.ts
  export function resolveAppIpids(processes: ProcessQuery, pids: readonly number[]): number[]
  // analyze/gc.ts
  export interface GcSignals {
    full: number; sharedFull: number; shared: number; partial: number;
    invocations: number; spanNs: number; rate: number; tooMany: boolean;
  }
  export function computeGc(db: QueryHandle, opts: { ipids: readonly number[] }): GcSignals
  export class GcAnalyzer implements Analyzer  // id 'gc', requires ['trace.ark']
  ```
  Metrics: `gc.full.count`, `gc.invocations.count`, `gc.partial.count`, `gc.perf.degraded` **or** `gc.perf.share`, `gc.rate`, `gc.shared.count`, `gc.shared_full.count`. Evidence kind `gc_pressure`, one item per run.

`ipids: []` must match **nothing**, not everything: an empty app identity
means no process was identified, and widening to device-wide is exactly the
attribution bug `MemoryMeasureAnalyzer` already guards against. `ipids:
undefined` is the unscoped query, which is what the drill-down uses.

- [x] **Step 1: Write the failing query test**

In `packages/core/test/query-callstack-perf.test.ts`, add a `thread` table to the
`callstack.db` fixture in `beforeAll` — the existing fixture has none:

```ts
cd.exec('CREATE TABLE thread(id INT, itid INT, ipid INT, name TEXT)');
cd.exec(`INSERT INTO thread VALUES (44, 44, 17, 'main'), (45, 45, 18, 'w'), (46, 46, 17, 'x')`);
```

The fixture's three `callstack` rows use `callid` 44, 45, 46, and its names are
`H:ProcessedNodes`, `binder transaction` and `H:Animate [nodeSize]`, so `H:%`
matches rows 0 and 2. Then:

```ts
it('scopes a LIKE match to the given ipids and matches nothing for an empty list', () => {
  const q = new CallstackQuery(callstackDb);
  expect(q.matching('H:%', { ipids: [17] }).map((row) => row.id)).toEqual([0, 2]);
  expect(q.countMatching('H:%', { ipids: [17] })).toBe(2);
  expect(q.matching('H:%', { ipids: [] })).toEqual([]);
  expect(q.countMatching('H:%', { ipids: [] })).toBe(0);
  expect(q.matching('H:%')).toHaveLength(2);
  expect(q.countMatching('H:%', { ipids: [18] })).toBe(0);
});
```

And for `PerfQuery`, against the existing `perf.db` fixture (thread 100 carries
`event_count` 5, 7, 9, 2; thread 101 carries 3; the 30 total includes thread
102's 4):

```ts
it('sums event_count, which is the sample weight, not the row count', () => {
  const q = new PerfQuery(perfDb);
  expect(q.eventCount()).toBe(30);
  expect(q.eventCount([100])).toBe(23);
  expect(q.eventCount([100, 101])).toBe(26);
  expect(q.eventCount([])).toBe(0);
});

it('resolves perf thread ids by thread name within the given processes', () => {
  expect(new PerfQuery(perfDb).threadIdsNamed([500], 'main')).toEqual([100]);
  expect(new PerfQuery(perfDb).threadIdsNamed([500], 'OS_GC_Thread')).toEqual([]);
});
```

- [x] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/core/test/query-callstack-perf.test.ts`
Expected: FAIL — `opts.ipids` is ignored (3 `H:%` rows, not 2), and `eventCount` is not a function.

- [x] **Step 3: Implement the query surface**

In both callstack methods, after the `range` clause:

```ts
const ipids = opts.ipids;
if (ipids !== undefined) {
  if (ipids.length === 0) return [];      // or 0 for countMatching
  where.push(`callid IN (SELECT id FROM thread WHERE ipid IN (${ipids.map(() => '?').join(', ')}))`);
  params.push(...ipids);
}
```

`eventCount` = `SELECT COALESCE(SUM(event_count), 0) AS n FROM perf_sample`
plus an `IN (…)` thread clause when `threadIds` is given (an empty array → 0,
an absent table → 0). `threadIdsNamed` = `SELECT thread_id FROM perf_thread
WHERE process_id IN (…) AND thread_name = ? ORDER BY thread_id` (empty `pids`
or absent table → `[]`).

- [x] **Step 4: Run them to verify they pass**

Run: `npx vitest run packages/core/test/query-callstack-perf.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing analyzer test**

Create `packages/core/test/analyze-gc.test.ts`. Build one trace with `callstack`,
`thread` and `process`; the app is ipid 17 / pid 4999, a second process is
ipid 18 / pid 5000. Build a second, empty `perf.db` with the `perf_*` DDL and no
`perf_sample` rows.

```ts
const GC = (id: number, ts: number, name: string, callid: number) =>
  `(${id}, ${ts}, 1000, ${callid}, 'App', '${name}', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0)`;

it('counts each GC type for the app only, over the whole callstack span', async () => {
  // 2 PartialGC + 1 FullGC on callid 44 (ipid 17); 1 PartialGC on callid 45
  // (ipid 18). Span 1e9..3e9 = 2s, so 3 invocations = 1.5/s, and 3 > 2 but
  // not > 10, so the app is NOT flagged.
  const r = await new GcAnalyzer().run(ctxFor(db));
  expect(metric(r, 'gc.partial.count').value).toBe(2);
  expect(metric(r, 'gc.full.count').value).toBe(1);
  expect(metric(r, 'gc.invocations.count').value).toBe(3);
  expect(metric(r, 'gc.rate').value).toBeCloseTo(1.5, 6);
  expect(r.evidence.filter((e) => e.kind === 'gc_pressure')[0].severity).toBe('info');
});

it('reports GC pressure when the app both exceeds 10 invocations and 1/s', async () => {
  // 12 PartialGC in 2s: 12 > 10 and 12 > 2.
  ...
  expect(r.evidence.filter((e) => e.kind === 'gc_pressure')[0].severity).toBe('warn');
});

it('divides by the whole callstack span, not the app’s own window', async () => {
  // The app's GCs all sit inside 1e9..1.1e9, but a row on the other process
  // extends the table to 3e9. The rate must still be 3/2 = 1.5, not 3/0.1.
  ...
  expect(metric(r, 'gc.rate').value).toBeCloseTo(1.5, 6);
});

it('degrades the perf share instead of reporting 0% when there are no samples', async () => {
  expect(r.metrics.map((m) => m.id)).not.toContain('gc.perf.share');
  expect(metric(r, 'gc.perf.degraded').fidelity).toBe('proxy');
  expect(metric(r, 'gc.perf.degraded').degraded?.reason).toContain('perf_sample');
});

it('degrades rather than reporting zeros when the app has no pid', async () => {
  // app.pids = []
  expect(r.metrics.map((m) => m.id)).toEqual(['gc.degraded']);
});

it('carries one drill-down per GC type that resolves through callstack.matching', async () => {
  const item = r.evidence.find((e) => e.kind === 'gc_pressure')!;
  expect(item.drillDown.map((d) => d.tool)).toEqual([
    'callstack.matching', 'callstack.matching', 'callstack.matching', 'callstack.matching',
  ]);
  expect(item.drillDown.map((d) => d.args.pattern)).toEqual([
    '%H:FullGC::RunPhases%', '%H:PartialGC::RunPhases%',
    '%H:SharedFullGC::RunPhases%', '%H:SharedGC::RunPhases%',
  ]);
});
```

- [x] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/test/analyze-gc.test.ts`
Expected: FAIL — cannot resolve `../src/analyze/gc`.

- [x] **Step 7: Implement `resolveAppIpids`, `computeGc` and `GcAnalyzer`**

`resolveAppIpids` is the body currently private in `mem-measure.ts` (`appIpids`)
and duplicated in `startup.ts`: map each pid through `processes.byPid(pid)?.ipid`,
skip `undefined`, non-integers, `<= 0`, and duplicates, preserving pid order.
Move it to `context.ts`, export it, and make both analyzers call it — their
existing tests are the regression net.

`computeGc` runs **four** `countMatching` calls, one per HapRay `LIKE` predicate,
each with `{ ipids }`; no row fetching is needed because GC only counts. The
type per row comes from the pattern that matched it. The span is
`SELECT MIN(ts) AS s, MAX(ts) AS e FROM callstack` over the **whole table**, as
HapRay does. `rate = invocations / (spanNs / 1e9)`, and `0` when the span is 0;
`tooMany = invocations > spanSeconds && invocations > 10`.

The analyzer: no `ctx.db` or no app ipids → one `gc.degraded` proxy plus one
`no_data` evidence (mirror `FaultTreeAnalyzer`). Otherwise emit the seven
metrics. `gc.perf.share` comes from `ctx.perf` when `hasSamples()` and the app
has at least one `OS_GC_Thread`; share = `eventCount(gcThreadIds) /
eventCount(appThreadIds) × 100`, guarded against a zero total. Otherwise emit
`gc.perf.degraded` with a reason naming `perf_sample` and `--hiperf`. One
`gc_pressure` evidence item: severity `warn` when `tooMany` else `info`,
`signals` carrying the four type counts, the invocation count, the rate and the
span in seconds, window = `ctx.window`, four `callstack.matching` drill-downs
over `ctx.window`.

Register in `defaultAnalyzers()` after `new RenderAnalyzer()`, export from
`index.ts`, add `'gc_pressure'` to `EvidenceKind`, and add the `'lower'`
directions for `gc.*.count`, `gc.rate` and `gc.perf.share` to
`METRIC_DIRECTIONS`.

**Divergence from HapRay, state it in the module header:** HapRay returns
`None` (no output at all) when `perf.db` is missing. We emit the trace-side
counts and a degraded perf proxy, because the counts were measured and
withholding them would hide real data.

- [x] **Step 8: Run the analyzer test and the engine test**

Run: `npx vitest run packages/core/test/analyze-gc.test.ts packages/core/test/analyze-engine.test.ts packages/core/test/compare.test.ts packages/core/test/analyze-mem-measure.test.ts packages/core/test/analyze-startup.test.ts`
Expected: PASS after adding `'gc'` to the `defaultAnalyzers` id list pin and
`GcAnalyzer` to its instance list in `analyze-engine.test.ts`.

- [x] **Step 9: Commit**

```bash
git add packages/core/src/query/callstack.ts packages/core/src/query/perf.ts \
  packages/core/src/analyze/context.ts packages/core/src/analyze/mem-measure.ts \
  packages/core/src/analyze/startup.ts packages/core/src/analyze/gc.ts \
  packages/core/src/report/evidence.ts packages/core/src/report/compare.ts \
  packages/core/src/analyze/engine.ts packages/core/src/index.ts \
  packages/core/test/query-callstack-perf.test.ts packages/core/test/analyze-gc.test.ts \
  packages/core/test/analyze-engine.test.ts packages/core/test/compare.test.ts
git commit -m "feat: port HapRay's GC pressure analyzer"
```

---

### Task 3: VSync anomaly analyzer

**Files:**
- Create: `packages/core/src/analyze/vsync.ts`
- Modify: `packages/cli/src/deps.ts` (`TABLE_RULES` gains `render.vsync`)
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/src/report/compare.ts`
- Test: `packages/core/test/analyze-vsync.test.ts` (new), `packages/cli/test/deps.test.ts`

**Interfaces:**
- Consumes: `FrameQuery`, `resolveAppIpids` (Task 2).
- Produces:
  ```ts
  export type VsyncPeriodKind = 'high_frequency' | 'low_frequency';
  export type VsyncSeverity = 'low' | 'medium' | 'high';
  export interface VsyncPeriod {
    kind: VsyncPeriodKind;
    startVsync: number; endVsync: number;
    startNs: number; endNs: number;          // absolute trace ns
    intervalCount: number; avgIntervalNs: number; avgFrequencyHz: number;
    severity: VsyncSeverity;
  }
  export interface VsyncAnalysis {
    signals: number; mismatches: number; periods: VsyncPeriod[]; anomalyRate: number;
  }
  export function computeVsyncAnomalies(frames: readonly Frame[]): VsyncAnalysis
  export class VsyncAnalyzer implements Analyzer  // id 'vsync', requires ['render.vsync']
  ```
  Metrics: `vsync.anomaly.rate`, `vsync.mismatch.count`, `vsync.periods.count`, `vsync.signals.count`. Evidence kind `vsync_anomaly`, one item per period.

`render.vsync` has a device rule but **no offline `TABLE_RULES` entry**, so
without this task the analyzer is skipped as "capability not probed" on every
offline analysis.

- [x] **Step 1: Write the failing test**

`analyze-vsync.test.ts` tests the pure function directly and the analyzer once:

```ts
const frame = (id: number, ts: number, vsync: number, type: 0 | 1, ipid = 17): Frame => ({
  id, ts, dur: 16_000_000, vsync, ipid, itid: 44, callstackId: 0, flag: 0,
  type, typeDesc: type === 0 ? 'actual' : 'expect', src: '', dst: 0, depth: 0, frameNo: 0,
});

it('detects a run of three or more short intervals as one high-frequency period', () => {
  // 4ms gaps = 250Hz; 4 intervals; duration 16ms.
  const frames = [0, 4e6, 8e6, 12e6, 16e6, 32e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
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
  const medium = [0, 6.25e6, 12.5e6, 18.75e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
  expect(computeVsyncAnomalies(medium).periods[0].severity).toBe('medium');
  // 210Hz (about 4.762ms) x 3 -> high.
  const high = [0, 4.762e6, 9.524e6, 14.286e6].map((d, i) => frame(i, 1e9 + d, 100 + i, 0));
  expect(computeVsyncAnomalies(high).periods[0].severity).toBe('high');
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

it('analyzes only the app’s frames, not every process’s', async () => {
  // Two app frames and two sceneboard frames, each with a different cadence.
  const r = await new VsyncAnalyzer().run(ctxWith(frames));
  expect(metric(r, 'vsync.signals.count').value).toBe(2);
});

it('emits no_data and no metrics when the app rendered no frames', async () => {
  const r = await new VsyncAnalyzer().run(ctxWith([]));
  expect(r.metrics).toEqual([]);
  expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/analyze-vsync.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the analyzer**

Port `frame_analyzer_vsync.py` literally: group by `vsync` (keeping only frames
with a non-null `vsync`, sorted by the group's minimum `ts`); interval =
current `min(ts)` − previous `min(ts)`; the normal band is
`8.33e6 < interval <= 33.3e6` ns; runs of `interval < 8.33e6` (high) and
`interval > 33.3e6` (low) are kept only at length ≥ 3; severity uses the
upstream thresholds (`avg > 200Hz || duration > 100ms` → high,
`avg > 150Hz || duration > 50ms` → medium for high-frequency; the mirrored
`< 15Hz || > 200ms` / `< 20Hz || > 100ms` for low-frequency); a mismatch is a
group with `count(type=0) === 0` or `count(type=1) === 0`;
`anomalyRate = round2((periods + mismatches) / signals * 100)`. Note the
upstream rate can exceed 100 — that is not a bug to clamp.

`VsyncAnalyzer.run` takes `ctx.frames.all(ctx.window)`, keeps the frames whose
`ipid` is in `resolveAppIpids(ctx.processes, ctx.app.pids)`, and emits one
`vsync_anomaly` evidence item per period: window `[startNs, endNs]` (absolute),
severity `high → critical`, `medium → warn`, `low → info`, `signals` carrying
`kind`, `intervalCount`, `avgFrequencyHz`, `startVsync`, `endVsync`, and
`explain` naming the period in relative ms, drill-down `frames.all` over the
period window. Zero app frames → no metrics and one `no_data` evidence
explaining that the app rendered nothing in this window.

Add `{ id: 'render.vsync', collector: 'hitrace', tables: ['frame_slice', 'process'] }`
to `TABLE_RULES`. Register the analyzer, export it, and add
`vsync.anomaly.rate`, `vsync.mismatch.count` and `vsync.periods.count` as
`'lower'` in `METRIC_DIRECTIONS` (`vsync.signals.count` has no direction).

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/analyze-vsync.test.ts packages/cli/test/deps.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS after adding `'vsync'` to the id list and `VsyncAnalyzer` to the
instance list of `analyze-engine.test.ts`'s `defaultAnalyzers` pin, and a `render.vsync`
offline assertion (`frame_slice` + `process` → available; `frame_slice` alone →
absent) to `deps.test.ts`.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/analyze/vsync.ts packages/core/src/analyze/engine.ts \
  packages/core/src/index.ts packages/core/src/report/compare.ts packages/cli/src/deps.ts \
  packages/core/test/analyze-vsync.test.ts packages/core/test/analyze-engine.test.ts \
  packages/cli/test/deps.test.ts
git commit -m "feat: port HapRay's VSync anomaly analyzer"
```

---

### Task 4: Empty-frame analyzer with HapRay's false-positive filters

**Files:**
- Create: `packages/core/src/analyze/empty-frame.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/src/report/compare.ts`
- Test: `packages/core/test/analyze-empty-frame.test.ts` (new)

**Interfaces:**
- Consumes: `FrameQuery`, `resolveAppIpids`.
- Produces:
  ```ts
  export interface EmptyFrameFilter {
    confirmed: Frame[];
    filtered: Frame[];
    rule1: Frame[];   // a buffer API event on the frame's own thread inside its window
    rule2: Frame[];   // a non-empty actual frame shares (vsync, itid)
  }
  export function filterEmptyFrames(db: QueryHandle, frames: readonly Frame[]): EmptyFrameFilter
  export class EmptyFrameAnalyzer implements Analyzer  // id 'empty-frame', requires ['trace.frames', 'trace.ark']
  ```
  Metrics: `empty_frame.count` (confirmed), `empty_frame.filtered.count`, `empty_frame.rate`. Evidence kind `empty_frame`, one item per confirmed frame.

`trace.ark` is required alongside `trace.frames` because rule 1 joins
`callstack` to `thread` and `process`, and only `trace.ark`'s offline rule
guarantees those tables exist. Requiring `trace.frames` alone would let the
engine run this analyzer against a trace with `frame_slice` but no `callstack`
and crash on `no such table` — the exact failure the capability matrix exists
to prevent.

Rule 1's predicate, verbatim from `frame_analyzer_empty.py`: events whose process
name is not `render_service`, `rmrenderservice` or `ohos.sceneboard`, and does
not match `system_%` or `com.ohos.%`, whose name matches `%RequestBuffer%`,
`%FlushBuffer%`, `%DoFlushBuffer%` or `%NativeWindow%`, on the frame's own
`itid`, with `ts` in `[frame.ts, frame.ts + frame.dur]`.

`frame_slice.itid` joins `thread.id`, which is unique across the whole table, so
no other process's thread can share an app frame's `itid`. The process-name
clause is ported verbatim as a defensive filter and is therefore unreachable on
a well-formed trace — say so in the module header rather than inventing a test
for an impossible collision.

- [x] **Step 1: Write the failing test**

```ts
it('confirms an empty frame with no buffer event and no non-empty sibling', () => {
  // frame flag=2, no callstack rows for its itid.
  expect(filterEmptyFrames(db, [empty]).confirmed).toHaveLength(1);
});

it('filters a frame whose own thread emitted a buffer API event inside it', () => {
  // callstack row callid=44, ts inside [frame.ts, frame.ts+dur], name 'H:RequestBuffer'
  const f = filterEmptyFrames(db, [empty]);
  expect(f.rule1).toHaveLength(1);
  expect(f.confirmed).toEqual([]);
});

it('filters a frame when the same vsync and itid already drew a non-empty frame', () => {
  // a second frame_slice row: same vsync, same itid, type 0, flag 0
  expect(filterEmptyFrames(db, [empty]).rule2).toHaveLength(1);
});

it('does not filter a frame whose dur is NULL', () => {
  // dur 0 on the Frame (NULL in the column). HapRay's NaN comparison never
  // matches, so a buffer event at exactly ts must not become a false positive.
  const nullDur = { ...empty, dur: 0 };
  expect(filterEmptyFrames(db, [nullDur]).rule1).toEqual([]);
});

it('ignores a buffer event that falls outside the frame window', () => {
  // an event one ns after ts+dur must not filter.
  ...
});

it('reports a rate over the app’s actual frames', async () => {
  // app ipid has 10 actual frames, 1 confirmed empty -> 10%.
  expect(metric(r, 'empty_frame.rate').value).toBeCloseTo(10, 6);
});

it('never reports an exact 0% empty rate for an app with no frames', async () => {
  const r = await new EmptyFrameAnalyzer().run(ctxWith([], { appHasNoFrames: true }));
  expect(r.metrics.map((m) => m.id)).not.toContain('empty_frame.rate');
  expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/analyze-empty-frame.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `filterEmptyFrames` and `EmptyFrameAnalyzer`**

One `db` query for the buffer events over the whole frame span, because the
typed `CallstackQuery.matching` takes a single pattern and this needs four
`OR`ed patterns joined to `thread`/`process` — the module header says why the
raw join is used. Then, per frame:

- rule 1 = `frame.dur > 0` **and** a matching event on `frame.itid` with
  `ts >= frame.ts && ts <= frame.ts + frame.dur`;
- rule 2 = any `frame_slice` row with the same `vsync` and `itid`,
  `type = 0`, `flag != 2` (one SQL query over the distinct `(vsync, itid)`
  pairs, as HapRay batches it; SQL's `!= 2` already excludes NULL flags).

`confirmed = frames − rule1 − rule2`, preserving the input order.

The analyzer: no app ipids → one `empty_frame.degraded` proxy and one `no_data`
evidence. App actual frames (`type = 0`) = 0 → no metrics and one `no_data`
explaining the app rendered nothing. Otherwise emit `empty_frame.count`,
`empty_frame.filtered.count`, and `empty_frame.rate`
(`confirmed / appActual × 100`, emitted only when `appActual > 0` — this rate is
**our** definition, not a HapRay field, and the doc comment says so). Emit one
`empty_frame` evidence item per confirmed frame: window `[ts, ts + dur]`,
subject `{ process, frameNo: frame.id }`, `signals` carrying `vsync` and
`filtered`, drill-down `frames.get` with `{ id }`. Severity `warn` when the rate
is ≥ 10, else `info`; when there is no rate, `info`.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/analyze-empty-frame.test.ts packages/core/test/analyze-engine.test.ts packages/core/test/compare.test.ts`
Expected: PASS after adding `'empty-frame'` to the id list and
`EmptyFrameAnalyzer` to the instance list of `analyze-engine.test.ts`'s pin, and
`empty_frame.count` / `empty_frame.rate` as `'lower'`.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/analyze/empty-frame.ts packages/core/src/analyze/engine.ts \
  packages/core/src/index.ts packages/core/src/report/compare.ts \
  packages/core/test/analyze-empty-frame.test.ts packages/core/test/analyze-engine.test.ts \
  packages/core/test/compare.test.ts
git commit -m "feat: port HapRay's empty-frame analyzer with its false-positive filters"
```

---

### Task 5: RenderService-skip reverse tracing

**Files:**
- Create: `packages/core/src/analyze/rs-skip.ts`
- Modify: `packages/core/src/report/evidence.ts` (add `'rs_skip'`)
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/src/report/compare.ts`
- Test: `packages/core/test/analyze-rs-skip.test.ts` (new)

**Interfaces:**
- Consumes: `FrameQuery`, `resolveAppIpids`.
- Produces:
  ```ts
  export interface RsSkipFrame {
    frame: Frame;                       // the RenderService frame containing the skips
    events: number;                     // DisplayNode skip rows inside it
    traced?: { frame: Frame; eventNs: number; timeDiffNs: number };
  }
  export interface RsSkipResult { frames: RsSkipFrame[]; totalEvents: number }
  export function computeRsSkip(db: QueryHandle, opts: {
    window: TimeRange; appIpids: readonly number[]; rsIpids: readonly number[];
  }): RsSkipResult
  export class RsSkipAnalyzer implements Analyzer  // id 'rs-skip', requires ['trace.frames', 'trace.ark']
  ```
  Metrics: `rs_skip.events.count`, `rs_skip.frames.count`, `rs_skip.trace.accuracy`, `rs_skip.traced.count`. Evidence kind `rs_skip`, one item per RenderService frame with skips.

`trace.ark` is required alongside `trace.frames` for the same reason as Task 4:
this analyzer joins `callstack` to `thread` and `process`, and only
`trace.ark`'s offline rule guarantees those tables.

HapRay numbers frame ids as SQLite **`rowid`**; `Frame.id` is the `id` column.
On `real_device` they differ by one (ids 292/304/312/316, rowids
293/305/313/317). Evidence carries `frame.id` and the drill-down is
`frames.get`, so the id resolves; the divergence is documented in the module
header rather than emulated.

- [x] **Step 1: Write the failing test**

```ts
it('traces a skip to the nearest app frame through a buffer event', () => {
  // render_service frame [1e9, 1e9+16ms]; skip at 1e9+4ms;
  // AcquireBuffer at 1e9+3ms; app frame at 1e9+3.5ms.
  const r = computeRsSkip(db, { window: WINDOW, appIpids: [17], rsIpids: [4] });
  expect(r.frames).toHaveLength(1);
  expect(r.frames[0].events).toBe(1);
  expect(r.frames[0].traced?.frame.id).toBe(21);
  expect(r.frames[0].traced?.timeDiffNs).toBe(500_000);
});

it('leaves the trace undefined when no buffer event precedes the skip', () => {
  expect(computeRsSkip(db, OPTS).frames[0].traced).toBeUndefined();
});

it('does not attribute another process’s frame to the app', () => {
  // the nearest frame belongs to ipid 18; the app is 17
  expect(computeRsSkip(db, OPTS).frames[0].traced).toBeUndefined();
});

it('assigns a skip event to the frame whose inclusive window contains it', () => {
  // An event exactly at ts + dur still belongs to the frame (COALESCE + >=).
  ...
});

it('reports accuracy over the skip frames it found', async () => {
  // 2 skip frames, 1 traced -> 50.
  expect(metric(r, 'rs_skip.trace.accuracy').value).toBeCloseTo(50, 6);
});

it('emits no_data when the trace has no DisplayNode skip events', async () => {
  const r = await new RsSkipAnalyzer().run(ctxWith([]));
  expect(r.metrics).toEqual([]);
  expect(r.evidence[0].kind).toBe('no_data');
  expect(r.evidence[0].explain).toContain('DisplayNode skip');
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/analyze-rs-skip.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `computeRsSkip` and `RsSkipAnalyzer`**

Port `frame_analyzer_rs_skip.py` and `frame_rs_skip_backtrack_nw.py`, using
`db` for the joins (no query class covers `callstack ⋈ thread ⋈ process ⋈
frame_slice`); the module header says why.

1. RenderService frames: `frame_slice` rows whose `ipid` is in `rsIpids`,
   `type = 0`, `flag IS NOT NULL`.
2. Skip assignment: `callstack` rows matching `%DisplayNode skip%` whose
   thread's ipid is a RenderService ipid, joined to those frames with
   `fs.ts <= c.ts AND (fs.ts + COALESCE(fs.dur, 0)) >= c.ts` — **both bounds
   inclusive**, exactly as upstream.
3. Buffer events: RenderService `callstack` rows matching `%AcquireBuffer%`,
   `%DoFlushBuffer%` or `%ConsumeAndUpdateAllNodes%` with
   `frame.ts - 500ms <= ts <= frame.ts + COALESCE(frame.dur, 0)`; keep the five
   nearest to `frame.ts`.
4. App frames: `frame_slice` rows of `appIpids`, `type = 0`, with
   `event.ts - 500ms <= ts <= event.ts + 10ms`; keep the ten nearest to
   `event.ts`. The closest app frame across all candidate events wins; nothing
   found leaves `traced` undefined.

The analyzer emits `rs_skip.frames.count`, `rs_skip.events.count`,
`rs_skip.traced.count`, and `rs_skip.trace.accuracy` (traced / skip frames ×
100, emitted only when at least one skip frame exists). One `rs_skip` evidence
item per skip frame: subject `render_service`, window `[frame.ts, frame.ts +
dur]`, severity `warn`, `signals` carrying `skipEvents`, `appFrameId`,
`appFrameFlag`, `timeDiffMs` and `method: 'nativewindow'`, drill-downs
`callstack.matching` (`%DisplayNode skip%` over the frame window) and, when
traced, `frames.get`. No skip events at all → one `no_data` evidence naming
`DisplayNode skip`.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/analyze-rs-skip.test.ts packages/core/test/analyze-engine.test.ts packages/core/test/compare.test.ts`
Expected: PASS after adding `'rs-skip'` to the id list and `RsSkipAnalyzer` to
the instance list of `analyze-engine.test.ts`'s pin, and
`rs_skip.frames.count` / `rs_skip.events.count` (`'lower'`),
`rs_skip.traced.count` / `rs_skip.trace.accuracy` (`'higher'`) to
`METRIC_DIRECTIONS`.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/analyze/rs-skip.ts packages/core/src/report/evidence.ts \
  packages/core/src/analyze/engine.ts packages/core/src/index.ts \
  packages/core/src/report/compare.ts packages/core/test/analyze-rs-skip.test.ts \
  packages/core/test/analyze-engine.test.ts packages/core/test/compare.test.ts
git commit -m "feat: port RenderService-skip reverse tracing"
```

---

### Task 6: Folded flamegraph stacks from `perf.db`

**Files:**
- Modify: `packages/core/src/query/perf.ts` (`foldedStacks`)
- Create: `packages/core/src/analyze/flamegraph.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/query-callstack-perf.test.ts`, `packages/core/test/analyze-flamegraph.test.ts` (new)

**Interfaces:**
- Consumes: `PerfQuery`, `AnalyzeContext.perf`.
- Produces:
  ```ts
  export interface FoldedStack { stack: string; leaf: string; samples: number }
  // query/perf.ts
  foldedStacks(threadIds: readonly number[], range: TimeRange, top: number): FoldedStack[]
  // analyze/flamegraph.ts
  export class FlamegraphAnalyzer implements Analyzer  // id 'flamegraph', requires ['perf.samples']
  ```
  Metrics: `flamegraph.app.share`, `flamegraph.samples.count`, `flamegraph.stacks.count`, `flamegraph.top.samples`, `flamegraph.top.symbol`. No evidence, so no named query is added.

`foldedStacks` must **not** reuse `callchains()`: that method caps at 50 chain
ids and 20 chains per thread (HapRay's UI budget), which silently truncates an
aggregate. It queries every distinct `callchain_id` of the given samples and
weights each by `event_count`.

- [x] **Step 1: Write the failing query test**

Add to `query-callstack-perf.test.ts`, against the existing `perf.db` fixture
(chain 10: depths 0–3, `Foo()` / `Bar()` / `raw2` / `raw3`; `event_count` 5 + 7):

```ts
it('folds callchains into semicolon-joined stacks weighted by event_count', () => {
  const stacks = new PerfQuery(perfDb).foldedStacks([100], { startNs: 0, endNs: 2000 }, 10);
  expect(stacks[0]).toEqual({
    stack: 'Foo();Bar();raw2;raw3', leaf: 'raw3', samples: 12,
  });
});

it('orders folded stacks by samples desc, then stack string asc', () => {
  // Equal weights must not fall back to row order.
  ...
});

it('returns nothing for an empty thread list', () => {
  expect(new PerfQuery(perfDb).foldedStacks([], { startNs: 0, endNs: 2000 }, 10)).toEqual([]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/query-callstack-perf.test.ts -t "folds callchains"`
Expected: FAIL — `foldedStacks` is not a function.

- [x] **Step 3: Implement `foldedStacks`**

One query for `(thread_id, callchain_id, SUM(event_count))` of the threads in
range (`callchain_id IS NOT NULL`), one for the frames of those chain ids
ordered by `callchain_id, depth, id`, one for `perf_files`; fold in TS using
the same symbol resolution `callchains()` uses (exact `(file_id, symbol_id)`,
then `file_id`, then the raw `name`), join with `';'`, aggregate by the stack
string, and sort by `samples` desc then `stack` asc before slicing to `top`.
`leaf` is the last frame's symbol. A chain with no frames is skipped, as
upstream does.

- [x] **Step 4: Run them to verify they pass**

Run: `npx vitest run packages/core/test/query-callstack-perf.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing analyzer test**

Build a dedicated `perf.db` in the test (the shared fixture's extra threads make
the shares hard to read):

```ts
// perf_thread: (0, 500, 9000, 'main'), (1, 501, 9000, 'worker'), (2, 502, 9001, 'other')
// perf_sample event_count: 5+7 on thread 500 chain 10; 3 on thread 501 chain 11;
//                          4 on thread 502 chain 12  -> total 19, app (9000) 15
it('weights stacks by event_count and names the hottest leaf symbol', async () => {
  const r = await new FlamegraphAnalyzer().run(ctxWith(perfDb, [9000]));
  expect(metric(r, 'flamegraph.samples.count').value).toBe(15);
  expect(metric(r, 'flamegraph.stacks.count').value).toBe(2);
  expect(metric(r, 'flamegraph.top.symbol').value).toBe('raw3');
  expect(metric(r, 'flamegraph.top.samples').value).toBe(12);
  expect(metric(r, 'flamegraph.app.share').value).toBeCloseTo(78.95, 2);
});

it('emits the documented degraded proxy when the perf database has no samples', async () => {
  const r = await new FlamegraphAnalyzer().run(ctxWith(emptyPerfDb, [9000]));
  expect(r.metrics.map((m) => m.id)).toEqual(['flamegraph.degraded']);
  expect(r.metrics[0].fidelity).toBe('proxy');
});
```

- [x] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/test/analyze-flamegraph.test.ts`
Expected: FAIL — module not found.

- [x] **Step 7: Implement `FlamegraphAnalyzer`**

`ctx.perf` absent or `!hasSamples()` → one `flamegraph.degraded` proxy whose
reason names `--hiperf` and the debuggable-app requirement. Otherwise resolve
the app's perf threads with `ctx.perf.threads(ctx.app.pids)`, fold their stacks
(top 20), and emit the five metrics: `flamegraph.samples.count` = app
`eventCount(threadIds)`; `flamegraph.app.share` = that divided by
`eventCount() × 100`, guarded against a zero total; `flamegraph.stacks.count`;
and `flamegraph.top.symbol` / `flamegraph.top.samples` only when at least one
stack exists. Register, export, and add no `METRIC_DIRECTIONS` entries — none
of these five is better or worse in a fixed direction.

- [x] **Step 8: Run the tests**

Run: `npx vitest run packages/core/test/analyze-flamegraph.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS after adding `'flamegraph'` to the id list and
`FlamegraphAnalyzer` to the instance list of `analyze-engine.test.ts`'s pin.

- [x] **Step 9: Commit**

```bash
git add packages/core/src/query/perf.ts packages/core/src/analyze/flamegraph.ts \
  packages/core/src/analyze/engine.ts packages/core/src/index.ts \
  packages/core/test/query-callstack-perf.test.ts \
  packages/core/test/analyze-flamegraph.test.ts packages/core/test/analyze-engine.test.ts
git commit -m "feat: add folded flamegraph stacks from perf.db"
```

---

### Task 7: ArkUI component reuse

**Files:**
- Create: `packages/core/src/analyze/components.ts`
- Create: `packages/core/test/fixtures/hapray/components.synthetic.sql`
- Create: `packages/core/test/fixtures/hapray/components.components.json` (generated by HapRay)
- Modify: `scripts/parity/hapray_reference.py` (optional component mode)
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/index.ts`
- Modify: `packages/core/src/report/compare.ts`
- Test: `packages/core/test/analyze-components.test.ts` (new), `packages/core/test/parity-fixtures.test.ts`, `packages/core/test/parity-hapray.test.ts`

**Interfaces:**
- Consumes: `QueryHandle`, `resolveAppIpids`.
- Produces:
  ```ts
  export interface ComponentReuse {
    max_component: string;
    total_builds: number;                       // the max component's builds, as HapRay reports it
    recycled_builds: number;                    // the max component's recycled builds
    reusability_ratio: number;                  // 0..1, HapRay's shape
    details: Record<string, [number, number]>;  // [builds, recycled], first-seen order
  }
  export function computeComponentReuse(db: QueryHandle, opts: { ipids: readonly number[] }): ComponentReuse
  export function round2HalfEven(value: number): number
  export class ComponentReuseAnalyzer implements Analyzer  // id 'components', requires ['trace.ark']
  ```
  Metrics: `components.builds.count`, `components.recycled.count`, `components.reuse.rate`, and `components.top.name` only when builds > 0. No evidence.

Two HapRay quirks this port must preserve, both named in the module header:
`total_builds` is the **max component's** build count, not the sum across
components (4, not 7, on the fixture); and `reusability_ratio` is rounded with
Python's half-even `round(x, 2)`, not half-up.

HapRay queries `callstack` **without** a process filter, so its payload is
device-wide. This port scopes to the app's ipids when there are any, because
attributing another process's builds to the app is the same bug
`MemoryMeasureAnalyzer` guards against. The golden fixture has no `process` or
`thread` table, so `resolveAppIpids` yields `[]` and the computation is
unscoped — which is why parity holds there. The scoped behaviour has its own
test and **no parity claim**.

- [x] **Step 1: Write the synthetic fixture and generate the golden**

`components.synthetic.sql` contains the `callstack` DDL and these seven rows.
This exact data was already run through HapRay to produce the golden below.

```sql
CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
  depth INT, cookie INT, parent_id INT, argsetid INT, chainId TEXT, spanId TEXT,
  parentSpanId TEXT, flag TEXT, trace_level TEXT, trace_tag TEXT,
  custom_category TEXT, custom_args TEXT, child_callid INT);
INSERT INTO callstack VALUES
 (0,1000,10,44,'App','H:CustomNode:BuildItem [ItemView][self:86][parent:-1]',1,0,0,0,'','','','','','','','',0),
 (1,1001,10,44,'App','H:CustomNode:BuildRecycle ItemView',1,0,0,0,'','','','','','','','',0),
 (2,1002,10,44,'App','H:CustomNode:BuildItem [ItemView][self:87][parent:-1]',1,0,0,0,'','','','','','','','',0),
 (3,1003,10,44,'App','H:CustomNode:BuildRecycle ItemView',1,0,0,0,'','','','','','','','',0),
 (4,1004,10,44,'App','H:CustomNode:BuildItem [Text][self:88][parent:-1]',1,0,0,0,'','','','','','','','',0),
 (5,1005,10,44,'App','H:CustomNode:BuildItem [Text][self:89][parent:-1]',1,0,0,0,'','','','','','','','',0),
 (6,1006,10,44,'App','H:CustomNode:BuildItem [Text][self:90][parent:-1]',1,0,0,0,'','','','','','','','',0);
```

Extend `scripts/parity/hapray_reference.py` with an optional
`--components-trace PATH`. When it is supplied the script runs **only**
`ComponentReusableAnalyzer` against that trace (the other four analyzers need
`process`/`thread`, which this fixture lacks), writes
`components.<stem>.json` into `--out-dir` via the existing `write_json`
(`indent=1`, like every other fixture), and returns. Make `--trace` optional
when `--components-trace` is given.

Generate it:

```bash
"E:/CodeE/vibe51/performance_rq/performance_rq/hapray_perf_testing/.venv-win/Scripts/python.exe" \
  -I scripts/parity/hapray_reference.py \
  --hapray-root "E:/CodeE/vibe51/performance_rq/performance_rq/hapray_perf_testing" \
  --components-trace /tmp/p6v/db/components.db \
  --out-dir packages/core/test/fixtures/hapray
```

`components.components.json` must parse to exactly:

```json
{"details": {"ItemView": [4, 2], "Text": [3, 0]},
 "max_component": "ItemView", "recycled_builds": 2,
 "reusability_ratio": 0.5, "total_builds": 4}
```

If the generator produces anything else, the SQL and the golden disagree — fix
the SQL, do not edit the golden by hand.

- [x] **Step 2: Write the failing tests**

```ts
it('matches the HapRay component-reuse golden', () => {
  // apply components.synthetic.sql into a temp db
  expect(computeComponentReuse(db, { ipids: [] }))
    .toEqual(readGolden('components.components.json'));
});

it('excludes another process’s builds when the app is known', () => {
  // the seven rows above plus one BuildItem for ipid 18, with thread/process rows
  expect(computeComponentReuse(db, { ipids: [17] }).total_builds).toBe(4);
  expect(computeComponentReuse(db, { ipids: [18] }).total_builds).toBe(1);
});

it('rounds the ratio the way Python’s round(x, 2) does', () => {
  expect(round2HalfEven(0.125)).toBe(0.12);
  expect(round2HalfEven(0.375)).toBe(0.38);
  expect(round2HalfEven(2.675)).toBe(2.67);
  expect(round2HalfEven(0.5)).toBe(0.5);
});

it('reports no reuse rate when nothing was built', async () => {
  const r = await new ComponentReuseAnalyzer().run(ctxWith(emptyDb));
  expect(metric(r, 'components.builds.count').value).toBe(0);
  expect(r.metrics.map((m) => m.id)).not.toContain('components.reuse.rate');
  expect(r.metrics.map((m) => m.id)).not.toContain('components.top.name');
});
```

- [x] **Step 3: Run them to verify they fail**

Run: `npx vitest run packages/core/test/analyze-components.test.ts`
Expected: FAIL — module not found.

- [x] **Step 4: Implement `round2HalfEven`, `computeComponentReuse` and the analyzer**

`round2HalfEven` must be half-even on the exact double, so
`Math.round(x * 100) / 100` (half-up) is wrong: `0.125` would become `0.13`.
Scale, split at the integer boundary, and on an exact `.5` pick the even
neighbour — that reproduces Python for all four pinned cases, including
`2.675 → 2.67` because the double is slightly below the midpoint.

`computeComponentReuse` queries `callstack WHERE name LIKE '%H:CustomNode:Build%'`
ordered by `ts, id` (scoped to `ipids` when non-empty), classifies each row with
`/^H:CustomNode:BuildItem\s*\[([^\]]*)\]/` and the `BuildRecycle` fallback
(`name.split(' ')[1]`, `'Unknown'` when that is missing), accumulates
`[builds, recycled]` per component in first-seen order, picks the first strict
maximum as `max_component`, and computes
`reusability_ratio = round2HalfEven(recycled / total)` when `total > 0`, else 0.

The analyzer emits `components.builds.count` (= `max_component`'s builds),
`components.recycled.count` (= its recycled builds), and — only when
`total_builds > 0` — `components.reuse.rate` (`round2HalfEven(ratio * 100)`) and
`components.top.name`. Register, export, and add `components.builds.count`
`'lower'` and `components.recycled.count` / `components.reuse.rate` `'higher'`
to `METRIC_DIRECTIONS`.

- [x] **Step 5: Run the parity and integrity tests**

Run: `npx vitest run packages/core/test/analyze-components.test.ts packages/core/test/parity-hapray.test.ts packages/core/test/parity-fixtures.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS after adding the new fixture to the integrity test's key list
(keys `['details', 'max_component', 'recycled_builds', 'reusability_ratio',
'total_builds']`) and `'components'` plus `ComponentReuseAnalyzer` to
`analyze-engine.test.ts`'s pin.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/analyze/components.ts packages/core/src/analyze/engine.ts \
  packages/core/src/index.ts packages/core/src/report/compare.ts \
  scripts/parity/hapray_reference.py \
  packages/core/test/fixtures/hapray/components.synthetic.sql \
  packages/core/test/fixtures/hapray/components.components.json \
  packages/core/test/analyze-components.test.ts packages/core/test/parity-hapray.test.ts \
  packages/core/test/parity-fixtures.test.ts packages/core/test/analyze-engine.test.ts
git commit -m "feat: port HapRay's ArkUI component-reuse analyzer"
```

---

### Task 8: Measure on the recorded traces and update the docs

**Files:**
- Modify: `README.md`, `site/index.html`, `skill/ohos-perf/SKILL.md`
- Modify: `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`
- Test: `packages/cli/test/skill.test.ts`, `packages/cli/test/program.test.ts`, `packages/core/test/types.test.ts`

**Interfaces:**
- Consumes: the finished surface.
- Produces: documented behaviour for the six new analyzers, the measured counts on both recorded traces, and an honest statement of what P6 did **not** port.

- [x] **Step 1: Export every new value and type**

Add the new exports to `packages/core/src/index.ts` and the new value names to
`VALUE_EXPORTS` in `types.test.ts`: `GcAnalyzer`, `computeGc`, `VsyncAnalyzer`,
`computeVsyncAnomalies`, `EmptyFrameAnalyzer`, `filterEmptyFrames`,
`RsSkipAnalyzer`, `computeRsSkip`, `FlamegraphAnalyzer`,
`ComponentReuseAnalyzer`, `computeComponentReuse`, `round2HalfEven`,
`resolveAppIpids`.

- [x] **Step 2: Run the type surface test**

Run: `npm run build -w @ohos-perf/core && npx vitest run packages/core/test/types.test.ts packages/core/test/index.test.ts`
Expected: PASS. A declared-but-unexported type fails the second test; a value
missing from `VALUE_EXPORTS` fails the first.

- [x] **Step 3: Measure the new counts — record, do not predict**

`analyze` takes a **scene directory**, not a `.db`, and needs `--app` or every
app-scoped analyzer degrades for lack of a pid (the scene has no `scene.json`).
The app names and pids are the measured ones from the table above. Use a
repo-relative scratch directory so the paths resolve on Windows:

```bash
mkdir -p .p6measure
for t in emu_big real_device; do
  mkdir -p ".p6measure/$t" && cp "spike/out/$t.db" ".p6measure/$t/trace.db"
done
node packages/cli/dist/index.js analyze .p6measure/emu_big --app pbench.baseline --json > .p6measure/emu.json
node packages/cli/dist/index.js analyze .p6measure/real_device --app erviceAbility:1 --json > .p6measure/real.json
node -e "const fs=require('node:fs');
for (const t of ['emu','real']) {
  const r = JSON.parse(fs.readFileSync('.p6measure/'+t+'.json','utf8'));
  const kinds = {}; for (const e of r.evidence) kinds[e.kind] = (kinds[e.kind]||0)+1;
  console.log(t, r.metrics.length, 'metrics', r.evidence.length, 'evidence', JSON.stringify(kinds));
  console.log('  new:', r.metrics.filter(m => /^(gc|vsync|empty_frame|rs_skip|flamegraph|components)\./.test(m.id))
    .map(m => m.id+'='+m.value).join(' '));
}"
```

Assert only what the design guarantees: the six new prefixes appear on
`real_device`, and on `emu_big` the GC and component analyzers produce their
documented no-data/degraded output rather than fabricated numbers. Every other
number you print is the measurement — write **that** into the docs, never an
estimate. If a value looks wrong, re-read the analyzer that produced it before
recording it.

Two cross-checks against the table above, on `real_device`: `gc.partial.count`
must be **2** (not 6 — the other 4 rows belong to pid 63785) and
`vsync.periods.count` must be **0**; on `emu_big`, `vsync.periods.count` must be
**7** and `vsync.mismatch.count` **54**. A different value means the app scope
is wrong, not that HapRay is wrong.

Delete `.p6measure/` afterwards (it is untracked scratch).

- [x] **Step 4: Re-measure the capability matrix if a device is attached**

```bash
node packages/cli/dist/index.js caps --json | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);
   console.log(c.length, c.filter(x=>x.available).length,
     c.filter(x=>!x.available).map(x=>x.id));})"
```

`caps --json` prints a bare array. Expected: 21 rows. On the Mate 60 the
numerator is 20 (hitrace is present, so `trace.ark` is available); on the
emulator 10. If no device is attached, update the denominators to 21 and keep
the previously measured numerators, annotated "(measured before `trace.ark`
was added)".

- [x] **Step 5: Update the docs**

- `README.md`: the "20 verdicts" line becomes 21; the analyzers list and the
  metric-prefix table gain `gc.*`, `vsync.*`, `empty_frame.*`, `rs_skip.*`,
  `flamegraph.*`, `components.*`; the P1–P5 status paragraph becomes P1–P6 with
  the re-measured counts and the clean-checkout split; the Roadmap moves P6 to
  `shipped in 0.2.0` only if the release is cut in this branch, otherwise
  `next`; the "Not implemented yet" paragraph now names only `ui.gesture`,
  `coverage` and the UI animation diff, with the `pages.json`/screenshot
  reason; the L5 architecture line lists all fourteen analyzers.
- `site/index.html`: the analyzer table gains six rows; every `data-en` **and**
  `data-zh` pair that says "eight analyzers" / "八个分析器", and the
  `39 metrics / 76 evidence` copy, become the measured counts and "fourteen";
  the stat tile `8` becomes `14`; the capability table gains `trace.ark`; the
  roadmap card for P6 changes status.
- `skill/ohos-perf/SKILL.md`: mention that `analyze` also reports GC pressure,
  VSync anomalies, empty frames (forward and RenderService-traced), the hottest
  folded stack, and component reuse; note that the flamegraph needs `--hiperf`
  on a debuggable app.
- `THIRD_PARTY_NOTICES.md`: add `analyze/gc.ts` ← `hapray/analyze/gc_analyzer.py`,
  `analyze/vsync.ts` ← `hapray/core/common/frame/frame_analyzer_vsync.py`,
  `analyze/empty-frame.ts` ← `frame_analyzer_empty.py` + `frame_trace_accessor.py`,
  `analyze/rs-skip.ts` ← `frame_analyzer_rs_skip.py` + `frame_rs_skip_backtrack_nw.py`,
  `analyze/components.ts` ← `hapray/analyze/component_reusable_analyzer.py`.
- `CHANGELOG.md`: one entry for the six analyzers, the `trace.ark` capability,
  `CallstackQuery`'s `ipids` scope and `PerfQuery`'s `eventCount` /
  `threadIdsNamed` / `foldedStacks`.

- [x] **Step 6: Run the doc-reading tests and both typechecks**

Run: `npx vitest run packages/cli/test/skill.test.ts packages/cli/test/program.test.ts && npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: PASS and both typechecks exit 0.

- [x] **Step 7: Run the whole suite**

Run: `npm test`
Expected: green. Record the total and the clean-checkout split (move
`spike/out` aside, run `npm run test:unit` and `npm run test:device`, restore)
and use those numbers — not estimates — in README and the site.

- [x] **Step 8: Commit**

```bash
git add README.md site/index.html skill/ohos-perf/SKILL.md \
  THIRD_PARTY_NOTICES.md CHANGELOG.md packages/core/src/index.ts \
  packages/core/test/types.test.ts
git commit -m "docs: document the six P6 analyzers and the trace.ark capability"
```

---

## Self-review

**Spec coverage.** §5's GC row → Task 2; VSync row → Task 3 (the spec's row
names only type mismatches; HapRay also detects frequency periods, and the
spec's own 移植原则 says to keep HapRay's algorithm, so the port is a superset);
empty-frame row → Tasks 4 and 5 (the row names both the forward `flag=2` scan
and the reverse RS-skip trace); flamegraph row → Task 6; UI row → Task 7's
trace-side half, with the screenshot half moved to "Out of scope" and the
reason stated. `trace.ark` is the capability §2's id list lacks for Tasks 2 and
7, and Task 1 edits the spec to keep the two in step.

**Step scan.** Every step names a test or a command and its expected result.
The one step that writes a fixture (Task 7, Step 1) gives the exact SQL and the
exact expected JSON, both already verified against HapRay.

**Type consistency.** `resolveAppIpids(processes, pids)` is defined in Task 2
and consumed unchanged by Tasks 3, 4 and 5 (Task 5 takes resolved ipids, not
pids). `Frame` and `CallstackEvent` are the existing types. `FoldedStack` is
defined once, in Task 6, and `flamegraph.top.symbol` reads its `leaf`.
`round2HalfEven` is defined and tested in Task 7 before any analyzer uses it.
`countMatching(pattern, { ipids })` from Task 2 is the only callstack API the
GC analyzer counts with. Tasks 4 and 5 declare `['trace.frames', 'trace.ark']`
because both join `callstack` to `thread`/`process`; Task 3's `render.vsync`
offline rule covers `frame_slice` + `process` and needs no `callstack`.

**Review Focus.** Every line names its owning task, and that task's steps
contain the test: (1) Task 4's "never reports an exact 0% empty rate" and Task
7's "reports no reuse rate when nothing was built"; (2) Task 2's "divides by the
whole callstack span, not the app's own window"; (3) Task 3's "analyzes only
the app's frames"; (4) Task 4's "does not filter a frame whose dur is NULL";
(5) Task 6's `event_count` weighting assertion.

**Proportion.** The plan specifies signatures and assertions, not
implementations. The three ported algorithms whose shape the tests do not fully
determine (VSync periods, RS-skip matching, folded stacks) carry a short
description of the upstream rule instead of a transcribed body.
