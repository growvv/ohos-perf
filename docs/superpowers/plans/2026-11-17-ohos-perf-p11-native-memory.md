# P11 Native Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `native_hook` data the package already captures into measured peak, trough and unreleased-bytes results with callchain, thread and component attribution.

**Architecture:** One typed query class (`NativeHookQuery`) reads the four native tables once; a pure pairing module (`pairNativeMemory`) replays alloc/free events by address with LIFO accounting and produces peak, trough, unreleased sets and a timeline; `NativeMemoryAnalyzer` wraps that into metrics and evidence, and four named queries expose the same data on demand. Classification is a checked-in constant ported from HapRay's `kind.json`.

**Tech Stack:** TypeScript (ESM), `node:sqlite`, Vitest (`--project unit`), zero runtime dependencies in core.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p11-native-memory-design.md`

## Global Constraints

- `event_type` is alloc for `'AllocEvent' | 'MmapEvent' | 0`, free for `'FreeEvent' | 'MunmapEvent' | 1`; anything else is other.
- Sizes are magnitudes; the sign is applied by the event type, never read from the stored `heap_size`.
- Pairing is per address, LIFO, with partial frees leaving a remainder.
- Events ordered by `(start_ts, id)`; unreleased rows sorted by `size desc, callchainId, pid, tid`; timeline by `startNs`.
- Every metric names its collector and table: `{ collector: 'hiprofiler', table: 'native_hook', rows }`.
- No fabricated zeros: absent data → one `mem.native.degraded` proxy plus a `no_data` evidence with a reason; statistic-only data → `proxy` metrics that never claim peak or timeline.
- Every named query returns `[]` when its tables are absent; never throws `no such table`.
- All emitted arrays sorted deterministically; identical input must produce byte-identical output (D5).
- Do not port `meminfo/` (showmap / gpuMem / dmabuff) parsing, leak labels, or `all_heap_size` inference.

## Review Focus

- A free larger than the newest active block must consume it and continue into older blocks, not stop at the first — a single-block assumption silently loses bytes.
- The peak tie-break: equal running totals must keep the **earliest** event, or the peak offset changes between runs.
- A trace that starts mid-lifetime troughs negative; clamping at zero would misreport every absolute figure after it.
- An allocation with a null `addr` can never be freed; counting it as unreleased would overstate live memory forever.
- Unattributed active bytes (`callchain_id` null/0) must appear once in a metric, not vanish and not repeat per row.
- Classification precedence: an exact-path rule must never be re-tested as a regex (upstream's accidental double-registration).

---

### Task 1: NativeHookQuery

**Files:**
- Create: `packages/core/src/query/native-hook.ts`
- Test: `packages/core/test/query-native-hook.test.ts`

**Interfaces:**
- Consumes: `QueryHandle` (`../db/driver`), `TimeRange` (`../types`), `num`/`str` from `./rows`.
- Produces: `NativeHookEvent`, `NativeHookFrame`, `NativeHookStatistic`, `NativeHookQuery` with `hasData()`, `hasStatistics()`, `events(pids, range?)`, `frames(callchainIds)`, `statistics(pids)`, `dataDict(ids)`.

- [ ] **Step 1: Write the failing test**

Fixture DDL (write it in the test file):

```sql
CREATE TABLE native_hook(id INT, callchain_id INT, ipid INT, itid INT,
  event_type INT, sub_type_id INT, start_ts INT, end_ts INT, dur INT, addr INT,
  heap_size INT, all_heap_size INT, current_size_dur INT, last_lib_id INT,
  last_symbol_id INT);
CREATE TABLE native_hook_frame(id INT, callchain_id INT, depth INT, ip INT,
  symbol_id INT, file_id INT, offset INT, symbol_offset INT, vaddr INT);
CREATE TABLE native_hook_statistic(id INT, callchain_id INT, ipid INT, ts INT,
  type INT, sub_type_id INT, apply_count INT, release_count INT, apply_size INT,
  release_size INT, last_lib_id INT, last_symbol_id INT);
CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT);
CREATE TABLE data_dict(id INT, data TEXT);
```

Seed `process` with `(0, 17, 4999, 'com.demo')`, `(1, 18, 5000, 'other')`; three
events for ipid 17 and one for ipid 18; two frames for callchain 10; one
statistic row; `data_dict` `(1,'libfoo.so'),(2,'Foo()')`.

Tests:

```ts
it('reads app events ordered by start_ts then id, filtered by pid', () => {
  const rows = new NativeHookQuery(db).events([4999]);
  expect(rows.map((r) => r.id)).toEqual([2, 1]);        // ts 300 then 400
  expect(rows[0]).toMatchObject({ callchainId: 10, heapSize: 64, addr: 4096 });
});

it('returns [] and false for every accessor when the tables are absent', () => {
  const bare = new NativeHookQuery(openBareDb());
  expect(bare.hasData()).toBe(false);
  expect(bare.events([4999])).toEqual([]);
  expect(bare.statistics([4999])).toEqual([]);
  expect(bare.dataDict([1])).toEqual(new Map());
  expect(bare.frames([10])).toEqual(new Map());
});

it('resolves frames by depth and data_dict names in one read', () => {
  const frames = new NativeHookQuery(db).frames([10]);
  expect(frames.get(10)!.map((f) => f.depth)).toEqual([0, 1]);
  expect(new NativeHookQuery(db).dataDict([1, 2])).toEqual(
    new Map([[1, 'libfoo.so'], [2, 'Foo()']]),
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/query-native-hook.test.ts`
Expected: FAIL — cannot resolve `../src/query/native-hook`.

- [ ] **Step 3: Implement**

- Every accessor checks `hasTable(name)` first (private helper, same shape as
  `PerfQuery.hasTable`) and returns `[]`/`false`/empty `Map` otherwise.
- `events(pids, range?)` joins `process` on `ipid` and filters `p.pid IN (…)`;
  orders by `start_ts, id`; applies `start_ts >= range.startNs AND start_ts <= range.endNs`
  when a range is given.
- `frames(ids)` reads `native_hook_frame` for the ids, ordered by
  `callchain_id, depth, id`, grouped into a `Map` preserving that order.
- `statistics(pids)` mirrors `events` (join, filter, order by `ts, id`).
- `dataDict(ids)` reads `data_dict` for the ids; an empty `ids` returns an empty
  `Map` without querying.
- Row normalizers use `num`/`str` from `./rows`; a null `callchain_id` becomes
  `0`, a null `addr` becomes `0` (the pairing layer treats `0` as "no address").

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/query-native-hook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/native-hook.ts packages/core/test/query-native-hook.test.ts
git commit -m "feat(core): add a typed native_hook query"
```

---

### Task 2: Pairing, peak and unreleased

**Files:**
- Create: `packages/core/src/analyze/native-memory.ts`
- Test: `packages/core/test/native-memory-pairing.test.ts`

**Interfaces:**
- Consumes: `NativeHookEvent` from `../query/native-hook`.
- Produces:
  ```ts
  export type NativeEventKind = 'alloc' | 'free' | 'other';
  export function nativeEventKind(eventType: number | string): NativeEventKind;
  export interface ActiveAlloc { addr: number; size: number; pid: number;
    tid: number; callchainId: number; relativeNs: number }
  export interface NativeMemoryResult {
    events: number; allocCount: number; allocBytes: number;
    freeCount: number; freeBytes: number;
    peak: number; peakTs: number; trough: number;
    endTotal: number; unaddressedAllocs: number; unpairedFrees: number;
    unattributedBytes: number;
    unreleasedAt(ts: number): ActiveAlloc[];
  }
  export function pairNativeMemory(events: readonly NativeHookEvent[]): NativeMemoryResult;
  ```

- [ ] **Step 1: Write the failing test**

Build events with a helper `ev(id, kind, ts, addr, size, callchain = 10, pid = 4999, tid = 100)`.

```ts
it('pairs allocs and frees per address and tracks the running total', () => {
  const r = pairNativeMemory([
    ev(0, 0, 100, 4096, 100),
    ev(1, 1, 200, 4096, 100),
  ]);
  expect(r.allocBytes).toBe(100);
  expect(r.freeBytes).toBe(100);
  expect(r.endTotal).toBe(0);
  expect(r.unreleasedAt(200)).toEqual([]);
});

it('consumes older blocks when a free exceeds the newest block (LIFO)', () => {
  const r = pairNativeMemory([
    ev(0, 0, 100, 4096, 60),   // older block
    ev(1, 0, 150, 4096, 40),   // reused address, newer block
    ev(2, 1, 200, 4096, 70),   // frees the 40 then 30 of the 60
  ]);
  const live = r.unreleasedAt(200);
  expect(live.map((a) => a.size)).toEqual([30]);
  expect(r.endTotal).toBe(30);
});

it('leaves a remainder on a partial free', () => {
  const r = pairNativeMemory([ev(0, 0, 100, 4096, 100), ev(1, 1, 200, 4096, 25)]);
  expect(r.unreleasedAt(200).map((a) => a.size)).toEqual([75]);
});

it('reports the peak with the earliest event on a tie, and a negative trough', () => {
  const r = pairNativeMemory([
    ev(0, 0, 100, 4096, 50),
    ev(1, 0, 200, 8192, 50),   // peak 100 at ts 200
    ev(2, 1, 300, 4096, 50),   // 50
    ev(3, 1, 400, 8192, 50),   // 0
    ev(4, 1, 500, 9000, 30),   // unpaired free: -30
  ]);
  expect(r.peak).toBe(100);
  expect(r.peakTs).toBe(200);
  expect(r.trough).toBe(-30);
  expect(r.endTotal).toBe(-30);
  expect(r.unpairedFrees).toBe(1);
});

it('excludes unaddressed allocs from the unreleased set and counts them', () => {
  const r = pairNativeMemory([ev(0, 0, 100, 0, 64)]);
  expect(r.unreleasedAt(100)).toEqual([]);
  expect(r.unaddressedAllocs).toBe(1);
  expect(r.endTotal).toBe(64);
});

it('counts active bytes with no callchain once', () => {
  const r = pairNativeMemory([
    ev(0, 0, 100, 4096, 32, 0),
    ev(1, 0, 110, 8192, 16, 0),
  ]);
  expect(r.unattributedBytes).toBe(48);
  expect(r.unreleasedAt(200)).toEqual([]);   // no callchain → not a row
});

it('orders by (start_ts, id) regardless of input order and ignores other event types', () => {
  const r = pairNativeMemory([
    ev(1, 0, 200, 8192, 40),
    ev(0, 0, 100, 4096, 100),
    ev(2, 7, 150, 4096, 999),   // other: counted, no effect
  ]);
  expect(r.peak).toBe(140);
  expect(r.peakTs).toBe(200);
  expect(r.endTotal).toBe(140);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/native-memory-pairing.test.ts`
Expected: FAIL — cannot resolve `../src/analyze/native-memory`.

- [ ] **Step 3: Implement `pairNativeMemory`**

Sort a copy of the events by `(startTs, id)`. Walk once, maintaining
`total`, `peak`, `peakTs`, `trough`, and `Map<addr, ActiveAlloc[]>` stacks
(newest last). For each event:

- alloc: `size = abs(heapSize)`; `allocCount++`, `allocBytes += size`,
  `total += size`; if `addr === 0` → `unaddressedAllocs++` and no stack entry;
  else push `{addr, size, pid, tid, callchainId, relativeNs: startTs - firstTs}`.
- free: `size = abs(heapSize)`; `freeCount++`, `freeBytes += size`,
  `total -= size`; pop/deduct from the address's stack (LIFO) until the free is
  consumed or the stack is empty; if nothing was consumed, `unpairedFrees++`.
- other: count only.

After each event update peak (strictly greater, keeping the earliest) and
trough (strictly less).

`unreleasedAt(ts)` replays the same walk up to `ts` (exclusive of later events)
and returns the live stacks flattened, skipping entries whose `callchainId` is
`0`; the bytes of those skipped entries are accumulated into
`unattributedBytes` **only for the end instant** — `unreleasedAt` returns rows
and the analyzer computes unattributed bytes from the end replay, so implement
`unreleasedAt` with an internal `replay(ts)` that also returns the skipped
byte sum, and set `unattributedBytes` from `replay(lastTs)`.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/native-memory-pairing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/native-memory.ts packages/core/test/native-memory-pairing.test.ts
git commit -m "feat(core): pair native alloc/free events by address"
```

---

### Task 3: Component classification

**Files:**
- Create: `packages/core/src/analyze/native-kinds.ts`
- Test: `packages/core/test/native-kinds.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NativeCategory { category: number; categoryName: string;
    subCategory: string; file: string }
  export function classifyNativePath(filePath: string | null,
    symbol: string | null, thread: string | null): NativeCategory;
  ```

- [ ] **Step 1: Write the failing test**

```ts
it('matches an exact path before any regex', () => {
  expect(classifyNativePath('/system/lib64/module/arkui/libcomponentutils.z.so', null, null))
    .toMatchObject({ category: 2, categoryName: 'ArkUI' });
});

it('matches a regex rule', () => {
  expect(classifyNativePath('/system/lib64/module/app/ability/libx.z.so', null, null))
    .toMatchObject({ category: 3, categoryName: 'OS_Runtime' });
});

it('classifies bundle .so and .abc, refining an ArkTS symbol to its package', () => {
  const so = classifyNativePath(
    '/proc/1234/data/storage/el2/base/bundle/libs/arm64/libentry.so', null, null);
  expect(so).toMatchObject({ category: 1, categoryName: 'APP', subCategory: 'libentry.so' });

  const abc = classifyNativePath(
    '/proc/1234/data/storage/el2/base/bundle/ets/modules.abc',
    'foo:[url:com.demo|entry|1.0.0|ets/pages/Index.ets:10:2]', null);
  expect(abc).toMatchObject({ category: 0, categoryName: 'APP', subCategory: 'com.demo' });
});

it('refines a KMP symbol to its package', () => {
  const c = classifyNativePath('/system/lib64/libkmp.so', 'kfun:com.demo.Native.main', null);
  expect(c).toMatchObject({ category: 8, subCategory: 'com.demo' });
});

it('falls back to the basename, then SYS_SDK, then the thread', () => {
  expect(classifyNativePath('/vendor/lib64/libfoo.so', null, null).categoryName).toBe('SYS_SDK');
  expect(classifyNativePath(null, null, 'worker')).toMatchObject({
    category: -1, categoryName: 'Thread', subCategory: 'worker',
  });
  expect(classifyNativePath('', 'unknown', null)).toMatchObject({ categoryName: 'UNKNOWN' });
});

it('treats a rule as either exact or regex, never both', () => {
  // `/system/lib64/platformsdk/libability_manager.z.so` is an exact rule; it must
  // not also be compiled as a regex with `.` wildcards.
  expect(classifyNativePath('/system/lib64/platformsdk/libabilityXmanagerYzXso', null, null))
    .toMatchObject({ categoryName: 'SYS_SDK' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/native-kinds.test.ts`
Expected: FAIL — cannot resolve `../src/analyze/native-kinds`.

- [ ] **Step 3: Implement**

- Copy the seven kinds, 22 components and 125 path rules from
  `E:\CodeE\FuckHdc\ArkAnalyzer-HapRay\tools\static_analyzer\res\perf\kind.json`
  into a `const KINDS` literal in this file, preserving order. Add the
  Apache-2.0 port header used by the other ported modules.
- Split rules once at module load: a rule containing any of `$`, `.*`, `.+`,
  `d+` is a regex (compiled once), everything else is an exact-path key.
- Lookup order: exact path → regex in order → bundle rule → basename exact →
  `SYS_SDK` with `subCategory = basename`; empty/`unknown` file with no symbol
  and no thread → `UNKNOWN`.
- Symbol refinement for `APP_ABC` uses
  `/^([^:]+):\[url:([^:|]+)\|([^|]+)\|([^:|]+)\|([^|]*):(\d+):(\d+)\]$/`
  and takes group 3 as the package. For KMP, `kfun:pkg.Class.fn` takes the
  segment after `kfun:` up to the first `.`.
- Thread fallback: `{ category: -1, categoryName: 'Thread', subCategory: thread }`.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/native-kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/native-kinds.ts packages/core/test/native-kinds.test.ts
git commit -m "feat(core): classify native memory by component kind"
```

---

### Task 4: Unreleased aggregation and timeline

**Files:**
- Modify: `packages/core/src/analyze/native-memory.ts`
- Test: `packages/core/test/native-memory-aggregate.test.ts`

**Interfaces:**
- Consumes: `pairNativeMemory`, `ActiveAlloc`.
- Produces:
  ```ts
  export interface UnreleasedRow { callchainId: number; pid: number;
    process: string; tid: number; thread: string; file: string; symbol: string;
    size: number; count: number; firstRelativeNs: number;
    category: number; categoryName: string; subCategory: string }
  export function aggregateUnreleased(allocs: readonly ActiveAlloc[],
    names: NativeNames): UnreleasedRow[];
  export interface NativeNames { processes: Map<number, string>;
    threads: Map<number, string>; files: Map<number, string>;
    symbols: Map<number, string>; frameLeaves: Map<number, { fileId: number;
    symbolId: number }> }
  export interface NativeTimelineBucket { startNs: number; endNs: number;
    allocBytes: number; freeBytes: number; deltaBytes: number;
    totalBytes: number; isPeak: boolean }
  export function buildNativeTimeline(events: readonly NativeHookEvent[],
    bucketNs?: number): NativeTimelineBucket[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
it('merges active allocations per (pid, tid) inside a callchain', () => {
  const rows = aggregateUnreleased(
    [
      { addr: 1, size: 30, pid: 4999, tid: 100, callchainId: 10, relativeNs: 5 },
      { addr: 2, size: 20, pid: 4999, tid: 100, callchainId: 10, relativeNs: 9 },
      { addr: 3, size: 50, pid: 4999, tid: 101, callchainId: 11, relativeNs: 7 },
    ],
    names(),
  );
  expect(rows.map((r) => [r.callchainId, r.tid, r.size, r.count, r.firstRelativeNs]))
    .toEqual([[11, 101, 50, 1, 7], [10, 100, 50, 2, 5]]);
});

it('orders equal sizes by callchain, then pid, then tid', () => {
  const rows = aggregateUnreleased(
    [
      { addr: 1, size: 10, pid: 2, tid: 2, callchainId: 20, relativeNs: 1 },
      { addr: 2, size: 10, pid: 1, tid: 9, callchainId: 20, relativeNs: 1 },
      { addr: 3, size: 10, pid: 2, tid: 2, callchainId: 10, relativeNs: 1 },
    ],
    names(),
  );
  expect(rows.map((r) => [r.callchainId, r.pid, r.tid])).toEqual([[10, 2, 2], [20, 1, 9], [20, 2, 2]]);
});

it('buckets events and omits empty buckets', () => {
  const buckets = buildNativeTimeline(
    [
      ev(0, 0, 0, 4096, 100),
      ev(1, 1, 500_000_000, 4096, 40),
      ev(2, 0, 2_500_000_000, 8192, 60),
    ],
    1_000_000_000,
  );
  expect(buckets.map((b) => [b.startNs, b.allocBytes, b.freeBytes, b.totalBytes]))
    .toEqual([[0, 100, 40, 60], [2_000_000_000, 60, 0, 120]]);
  expect(buckets.some((b) => b.isPeak)).toBe(true);
});

it('marks the bucket containing the peak', () => {
  const buckets = buildNativeTimeline([ev(0, 0, 0, 4096, 10), ev(1, 0, 1_000_000_000, 8192, 90)], 1_000_000_000);
  expect(buckets.map((b) => b.isPeak)).toEqual([false, true]);
});

it('rejects a non-positive bucket width', () => {
  expect(() => buildNativeTimeline([], 0)).toThrow(/bucketNs/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/native-memory-aggregate.test.ts`
Expected: FAIL — `aggregateUnreleased` is not exported.

- [ ] **Step 3: Implement**

- `aggregateUnreleased`: group by `(callchainId, pid, tid)`; sum `size`, count
  entries, take the minimum `relativeNs`; resolve `process`/`thread` from
  `names` (`''` when absent, `'unknown'` for a missing thread row), `file` and
  `symbol` from the callchain's **leaf frame** (`frameLeaves`, deepest depth)
  resolved through `names.files`/`names.symbols`; classify with
  `classifyNativePath(file, symbol, thread)`; sort by `size desc, callchainId,
  pid, tid`.
- `buildNativeTimeline`: throw on `bucketNs <= 0` or non-finite; sort events by
  `(startTs, id)`; anchor at the first alloc/free event; bucket index
  `Math.floor((ts - origin) / bucketNs)`; accumulate alloc/free bytes and the
  running total; skip buckets with no events; mark the bucket containing
  `peakTs` with `isPeak: true`; each bucket's `endNs` is
  `startNs + bucketNs`.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/native-memory-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/native-memory.ts packages/core/test/native-memory-aggregate.test.ts
git commit -m "feat(core): aggregate unreleased memory and build the timeline"
```

---

### Task 5: NativeMemoryAnalyzer

**Files:**
- Modify: `packages/core/src/analyze/native-memory.ts`
- Modify: `packages/core/src/analyze/engine.ts` (register after `mem-measure`)
- Modify: `packages/core/src/report/evidence.ts` (`'native_memory'` kind)
- Modify: `packages/core/src/report/model.ts` (`'native-memory'` section title)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/analyze-native-memory.test.ts`

**Interfaces:**
- Consumes: `NativeHookQuery`, `pairNativeMemory`, `aggregateUnreleased`, `buildNativeTimeline`, `classifyNativePath`.
- Produces: `NativeMemoryAnalyzer` with `id: 'native-memory'` and
  `requires: ['mem.native_hook']`; metrics per the spec table; `native_memory`
  evidence.

- [ ] **Step 1: Write the failing test**

Use a `dbWith` fixture like `analyze-empty-frame.test.ts`, seeding
`native_hook` (alloc 100 at ts 1000 addr 4096; alloc 50 at ts 2000 addr 8192;
free 50 at ts 3000 addr 8192; alloc 20 at ts 4000 addr 4096), `native_hook_frame`
(two frames for callchain 10 → file 1/symbol 2), `data_dict`
(`1:'/system/lib64/libfoo.so'`, `2:'foo()'`), `process` (ipid 17, pid 4999), and
`thread` (`itid 100 → 'main'`).

```ts
it('reports peak, trough, end and unreleased at both instants', async () => {
  const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
  const get = (id: string) => metricOf(r, id).value;
  expect(get('mem.native.events.count')).toBe(4);
  expect(get('mem.native.alloc.bytes')).toBe(170);
  expect(get('mem.native.free.bytes')).toBe(50);
  expect(get('mem.native.total.peak')).toBe(150);   // 100 then 150 at ts 2000
  expect(get('mem.native.total.end')).toBe(120);
  expect(get('mem.native.unreleased.peak')).toBe(150);
  expect(get('mem.native.unreleased.end')).toBe(120);
  expect(get('mem.native.callchains.count')).toBe(1);
});

it('emits evidence for the peak and end points with drill-downs', async () => {
  const r = await new NativeMemoryAnalyzer().run(ctxWith(db));
  const items = r.evidence.filter((e) => e.kind === 'native_memory');
  expect(items.map((e) => e.signals.point).sort()).toEqual(['end', 'peak']);
  expect(items[0].drillDown.map((d) => d.tool)).toEqual([
    'mem.native.callchain', 'mem.native.unreleased', 'frames.all',
  ]);
});

it('degrades with a reason when native_hook is absent', async () => {
  const r = await new NativeMemoryAnalyzer().run(ctxWith(bareDb));
  expect(metricOf(r, 'mem.native.degraded').fidelity).toBe('proxy');
  expect(r.evidence.map((e) => e.kind)).toEqual(['no_data']);
  expect(r.metrics.some((m) => m.id === 'mem.native.total.peak')).toBe(false);
});

it('falls back to statistics as proxy data and never claims a peak', async () => {
  const r = await new NativeMemoryAnalyzer().run(ctxWith(statsOnlyDb));
  expect(metricOf(r, 'mem.native.statistic.fallback').fidelity).toBe('proxy');
  expect(metricOf(r, 'mem.native.unreleased.end').fidelity).toBe('proxy');
  expect(r.metrics.some((m) => m.id === 'mem.native.total.peak')).toBe(false);
  expect(metricOf(r, 'mem.native.unreleased.end').degraded!.reason).toMatch(/statistic/i);
});

it('degrades when the app has no process in the trace', async () => {
  const r = await new NativeMemoryAnalyzer().run(ctxWith(db, []));
  expect(metricOf(r, 'mem.native.degraded').value).toBe(0);
});

it('is deterministic across runs', async () => {
  const a = await new NativeMemoryAnalyzer().run(ctxWith(db));
  const b = await new NativeMemoryAnalyzer().run(ctxWith(db));
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/analyze-native-memory.test.ts`
Expected: FAIL — `NativeMemoryAnalyzer` is not exported.

- [ ] **Step 3: Implement**

- Resolve `ipids` with `resolveAppIpids`; empty → degraded.
- `events = query.events(ctx.app.pids, ctx.window)`; if empty and
  `query.hasStatistics()` → statistic path; if empty otherwise → degraded with
  the `--hiprofiler --plugins nativehook` + debuggable-app reason.
- Build names: processes (`processes.all()` by ipid → name), threads (by itid →
  name), frames (`query.frames(callchainIds)` → leaf `(fileId, symbolId)`),
  `dataDict` over the file/symbol ids, then `pairNativeMemory`.
- `peakRows = aggregateUnreleased(pair.unreleasedAt(peakTs), names)`,
  `endRows = aggregateUnreleased(pair.unreleasedAt(lastTs), names)`.
- Metrics: every id from the spec table, `exact`, provenance
  `{ collector: 'hiprofiler', table: 'native_hook', rows: events.length }`,
  except `mem.native.peak.offset` (ms, `(peakTs - firstTs) / 1e6`).
- Evidence: top 10 of each row set by `size`; `severity` warn at ≥5% of that
  point's total, info otherwise; `key`
  `native-memory:<point>:<callchainId>:<pid>:<tid>`; drill-downs
  `mem.native.callchain {callchainId}`, `mem.native.unreleased {point}`,
  `frames.all {window}` around the point (±500 ms, clamped to the trace span).
- Statistic path: `applySize - releaseSize` per callchain from
  `statistics(pids)`, aggregated by callchain (no thread split);
  `mem.native.statistic.fallback` proxy, `mem.native.unreleased.end` proxy with
  the statistic reason, `mem.native.callchains.count`; nothing else.
- Register the analyzer in `engine.ts` after `new MemoryMeasureAnalyzer()`;
  add `'native_memory'` to `EvidenceKind` and `'native-memory': 'Native memory'`
  to `SECTION_TITLES`; export `NativeMemoryAnalyzer`, `NativeHookQuery`, the
  types and the pure functions from `index.ts`.
- Update `test/analyze-engine.test.ts` (15 → 16 ids, instanceof list) and
  `test/types.test.ts` `VALUE_EXPORTS` (`NativeHookQuery`, `NativeMemoryAnalyzer`,
  `pairNativeMemory`, `classifyNativePath`, `aggregateUnreleased`,
  `buildNativeTimeline`).

- [ ] **Step 4: Run green**

Run: `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/analyze-native-memory.test.ts packages/core/test/analyze-engine.test.ts packages/core/test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add the native memory analyzer"
```

---

### Task 6: Named queries

**Files:**
- Modify: `packages/core/src/query/registry.ts`
- Test: `packages/core/test/query-native-memory.test.ts`

**Interfaces:**
- Consumes: `NativeHookQuery`, `pairNativeMemory`, `aggregateUnreleased`.
- Produces: `mem.native.unreleased`, `mem.native.callchain`,
  `mem.native.timeline`, `mem.native.categories`.

- [ ] **Step 1: Write the failing test**

```ts
it('lists unreleased rows at the end by default and at a point when asked', () => {
  expect(runNamedQuery(ctx(db), 'mem.native.unreleased', {}).rows[0])
    .toMatchObject({ callchainId: 10, size: 120, count: 2 });
  expect(runNamedQuery(ctx(db), 'mem.native.unreleased', { point: 'peak' }).rows[0])
    .toMatchObject({ size: 150 });
});

it('returns one callchain with its frames', () => {
  const r = runNamedQuery(ctx(db), 'mem.native.callchain', { callchainId: 10 });
  expect(r.rows).toEqual([
    { depth: 0, symbol: 'foo()', file: '/system/lib64/libfoo.so', ip: 4096 },
    { depth: 1, symbol: 'bar()', file: '/system/lib64/libfoo.so', ip: 8192 },
  ]);
});

it('returns timeline buckets and per-category totals', () => {
  expect(runNamedQuery(ctx(db), 'mem.native.timeline', { bucketMs: 1 }).rows.length).toBeGreaterThan(0);
  expect(runNamedQuery(ctx(db), 'mem.native.categories', {}).rows[0])
    .toMatchObject({ categoryName: 'SYS_SDK', size: 120 });
});

it('returns [] without native tables and validates arguments', () => {
  const bare = ctx(openBareDb());
  expect(runNamedQuery(bare, 'mem.native.unreleased', {}).rows).toEqual([]);
  expect(runNamedQuery(bare, 'mem.native.callchain', { callchainId: 1 }).rows).toEqual([]);
  expect(runNamedQuery(bare, 'mem.native.timeline', {}).rows).toEqual([]);
  expect(() => runNamedQuery(bare, 'mem.native.unreleased', { point: 'middle' }))
    .toThrow(/point/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit packages/core/test/query-native-memory.test.ts`
Expected: FAIL — unknown query.

- [ ] **Step 3: Implement**

- `mem.native.unreleased`: args `point` (`'peak' | 'end'`, default `end`);
  builds events for `ctx.app.pids` over the whole table, pairs, aggregates at
  the chosen instant, returns `UnreleasedRow[]`; `[]` when no data.
- `mem.native.callchain`: required `callchainId`; frames ordered by depth with
  `symbol`/`file` resolved through `data_dict`, `[]` when absent.
- `mem.native.timeline`: optional `bucketMs` (default 1000, min 1); returns
  `NativeTimelineBucket[]`.
- `mem.native.categories`: aggregates the end-point rows by
  `(categoryName, subCategory)`, sorted by `size desc, categoryName, subCategory`.
- Update the registry name-list test (12 → 16 names) and the CLI
  `deps.test.ts` tool-list expectation.

- [ ] **Step 4: Run green**

Run: `npx vitest run --project unit packages/core/test/query-native-memory.test.ts packages/core/test/query-registry.test.ts packages/core/test/drilldown.test.ts packages/cli/test/deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/registry.ts packages/core/test packages/cli/test/deps.test.ts
git commit -m "feat(core): expose native memory queries"
```

---

### Task 7: Docs, metadata and release 0.6.0

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `site/index.html`,
  `skill/ohos-perf/SKILL.md`, both `package.json` files, `package-lock.json`
- Modify: `packages/core/test/e2e-offline.test.ts` only if an exact count changes

- [ ] **Step 1: Rebuild and run everything**

```bash
npm run build -w @ohos-perf/core
npx tsc --noEmit -p packages/core/tsconfig.test.json
npx tsc --noEmit -p packages/cli/tsconfig.test.json
npm test
```

Expected: green; record exact counts for README/site. Recorded traces have an
empty `native_hook`, so `native-memory` degrades there: `emu_big` gains one
metric and one evidence item.

- [ ] **Step 2: Update docs**

- CHANGELOG `## 0.6.0 — <date>`: pairing semantics (LIFO, partial frees,
  unpaired frees counted), peak/trough, unreleased at peak and end, component
  classification, statistic fallback, four queries, and the deliberate exclusions
  (meminfo/GPU/DMA, leak labels).
- README: P11 row shipped in `0.6.0`; analyzer list and metric table gain
  `mem.native.*`; status counts; measured trace numbers.
- Site: hero `P1–P11`, stat counts, a "Shipped · v0.6.0" card, parity card
  updated to `8 ported / 9 partial / 18 missing` → recount after this phase.
- Skill: a "Native memory" section naming the metric families, the four tools
  and the fact that "unreleased" is not a leak.

- [ ] **Step 3: Version bump**

```bash
npm pkg set version=0.6.0 -w @ohos-perf/core
npm pkg set version=0.6.0 -w @ohos-perf/cli
npm pkg set 'dependencies.@ohos-perf/core=0.6.0' -w @ohos-perf/cli
npm install --package-lock-only
```

- [ ] **Step 4: Commit, tag, push, release**

```bash
git add -A
git commit -m "chore(release): 0.6.0"
git tag v0.6.0
git push origin master
git push origin v0.6.0
gh release create v0.6.0 --title "v0.6.0 — native memory" --notes-file <notes>
```

Do not publish the LLM API key. `npm publish` only if the registry is
authenticated; otherwise record that publication is pending.

- [ ] **Step 5: Verify CI and Pages**

```bash
sha=$(git rev-parse HEAD)
gh run list --limit 20 --json headSha,name,status,conclusion \
  --jq ".[] | select(.headSha==\"$sha\") | [.name,.status,.conclusion] | @tsv"
```

Expected: `ci success` and `pages success`.
