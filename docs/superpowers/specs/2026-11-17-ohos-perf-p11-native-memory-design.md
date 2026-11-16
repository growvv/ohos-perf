# P11 — Native memory: allocation pairing, peak and unreleased (HapRay parity W3)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.6.0`
**Builds on:** P10 frame load (`0.5.0`); HapRay `9386e4e`
**Gap-analysis rows:** 4 (native memory / `native_hook`), part of 12 (per-symbol
attribution)

## Why this phase

HapRay's native-memory view answers the question a frame profile cannot: *which
call site is holding memory, and how much of it is still live at the end of the
capture*. It pairs `native_hook` allocation and free events by address, tracks
the running total to find the peak, and at the peak and end instants lists the
unreleased bytes per callchain, process and thread, classified into app /
ArkUI / runtime / RN / Flutter / Web / KMP components.

This package already captures `native_hook` through hiprofiler
(`--hiprofiler --plugins nativehook`) and reports `mem.native_hook` as a
capability, but nothing consumes the tables — the capability is honestly
reported as present while no analyzer reads it. P11 closes that: the data the
package already collects becomes a measured result, not a table nobody reads.

## Scope

**In scope**

- `NativeHookQuery` — one typed, batched read of `native_hook`,
  `native_hook_frame`, `native_hook_statistic` and `data_dict`, returning `[]`
  when a table is absent (never `no such table`).
- `NativeMemoryAnalyzer` (`id: 'native-memory'`, requires
  `['mem.native_hook']`):
  - alloc/free pairing by address with LIFO partial-free accounting;
  - running total, peak value and peak timestamp, plus the trough;
  - unreleased bytes at the peak and at the end, aggregated per callchain and
    then per `(pid, tid)` within a callchain;
  - component classification (APP / ArkUI / OS_Runtime / RN / Flutter / WEB /
    KMP) ported from `kind.json`, with symbol refinement for ArkTS (`.abc`) and
    KMP symbols;
  - per-second (configurable bucket) allocation timeline;
  - metrics, `native_memory` evidence with drill-downs, and degraded paths.
- `native_hook_statistic` fallback: when `native_hook` is empty but the
  statistic table is not, report end-of-capture unreleased bytes per callchain
  as a `proxy`, with a reason naming the lost precision (no timestamps per
  allocation, no thread, no address, no peak).
- Named queries: `mem.native.unreleased`, `mem.native.callchain`,
  `mem.native.timeline`, `mem.native.categories`.
- Report section title `native-memory`; docs, skill, site and roadmap at
  release.

**Out of scope, deliberately**

- **`meminfo/` parsing** (`dynamic_showmap`, `dynamic_gpuMem`,
  `dynamic_process_dmabuff_info`). It is a separate capture path HapRay drives
  with its own scripts; this package has no collector for those files yet.
  Reporting GPU or DMA totals from files nobody produced would be a claim, not
  a measurement. It becomes its own workstream once a collector exists.
- **Leak classification.** "Unreleased at end" is live allocation, not proof of
  a leak. The analyzer reports it under that name and never labels a callchain
  a leak.
- **`all_heap_size` / `current_size_dur`-derived inference.** HapRay does not
  use them for the report and their semantics are undocumented; they are read
  into the row model for callers but never interpreted.
- **Cross-capture memory comparison.** `compare` already diffs every metric,
  including these, on a like-for-like basis; a dedicated memory diff is W6
  material.

## Semantics

### Events and pairing

- App events are `native_hook` rows whose `ipid` belongs to the analyzed app's
  pids (`process.pid`), joined through `process.ipid`. The join is the same
  number space HapRay uses.
- `event_type` is alloc for `'AllocEvent'`, `'MmapEvent'` and `0`; free for
  `'FreeEvent'`, `'MunmapEvent'` and `1`. Anything else is **other**: counted,
  classified, but it neither allocates nor frees.
- An alloc adds `heap_size`; a free subtracts `heap_size`. Sizes are stored as
  magnitudes in the trace; the sign is applied here, so a negative
  `heap_size` in the database does not flip the direction.
- Frees are paired with allocs **per address, LIFO**, because a runtime may
  reuse an address before the previous block is fully released. A free larger
  than the newest block consumes that block, then the next one, and so on. A
  partial free leaves the remainder active.
- A free of an address with no tracked alloc is still applied to the running
  total — HapRay does this, and dropping it would understate a real
  `free`-heavy capture — but it is counted in
  `mem.native.free.unpaired.count` so the reader can see the total is not
  fully explained by paired events.
- Events are ordered by `(start_ts, id)`. Upstream orders by `start_ts` alone;
  the tie-break is ours, so a capture with equal timestamps is still
  byte-stable.

### Running total, peak and trough

- The running total starts at `0` and moves by each event's signed size.
- The **peak** is the highest value seen, with the timestamp and id of the
  event that produced it; ties keep the earliest event. The **trough** is the
  lowest, reported because a trough far below zero means the capture started
  mid-lifetime (allocs before the trace began) and every absolute number
  should be read with that in mind.
- Peak and end are reported in **absolute trace nanoseconds** and as offsets
  from the first app event (`relativeNs`), so a caller can window them against
  frames without knowing the trace origin.

### Unreleased at an instant

At time `T`, replay the events with `start_ts <= T` and keep the active
allocation stack per address. Unreleased bytes are the sum of the remaining
sizes.

- Aggregation is per `callchain_id`, then per `(pid, tid)` inside it, matching
  HapRay: rows are `{callchainId, pid, process, tid, thread, file, symbol,
  size, count, firstRelativeNs, category, subCategory}`.
- `count` is the number of active allocations merged into the row; `size` is
  their summed remaining bytes; `firstRelativeNs` is the earliest of them.
- Rows are sorted by `size` descending, then `callchainId`, then `pid`, then
  `tid` — a total order, so equal sizes never depend on map iteration.
- An active allocation with `callchain_id` null or `0` cannot be attributed; its
  bytes are reported once as `mem.native.unreleased.unattributed.bytes` rather
  than silently disappearing.
- An allocation whose `addr` is null can never be freed and is excluded from
  the unreleased set (it is still counted in the running total), with
  `mem.native.alloc.unaddressed.count` naming how many.

### Classification

Ported from HapRay's `tools/static_analyzer/res/perf/kind.json` (7 kinds, 22
components, 125 path rules) as a checked-in TypeScript constant:

1. exact path match, in file order;
2. regex match, in file order;
3. the bundle-path rule (`/proc/*/data/storage/*/bundle/…` → `APP_SO` for
   `.so` and `libs/`, `APP_ABC` for `.abc`);
4. basename exact match;
5. default `SYS_SDK`.

The symbol refines an `APP_ABC` match: `name:[url:bundle|package|version|path:line:col]`
uses the package as the sub-category, and a KMP `kfun:package.class.fn` symbol
uses the package. A thread with no file and no symbol classifies as
`category: UNKNOWN`, `categoryName: 'Thread'`, sub-category = thread name,
matching upstream's fallback.

**Divergence:** upstream matches exact paths with `if file_path in cfg` but
loads that dict from the same list it also regex-matches, so a rule that
contains a regex metacharacter lands in *both* tables and exact-match precedence
is accidental. Here each rule is either exact or a regex, decided once by a
documented test (any of `$ .* .+ d+`), so precedence is stable.

### Timeline

`mem.native.timeline` buckets events into fixed `bucketNs` windows (default
1 s, minimum 1 ms) anchored at the first app event, and reports per bucket:
alloc bytes, free bytes, net delta, and the cumulative total at the end of the
bucket. Buckets with no events are omitted, not emitted as zeros: an empty
bucket means the capture recorded nothing, which is different from a zero
delta and must not be confused with it. The bucket containing the peak is
marked `isPeak: true`.

### Metrics

| id | unit | meaning |
| --- | --- | --- |
| `mem.native.events.count` | count | app events read |
| `mem.native.alloc.count` / `.bytes` | count / bytes | allocations |
| `mem.native.free.count` / `.bytes` | count / bytes | frees |
| `mem.native.total.peak` | bytes | highest running total |
| `mem.native.total.trough` | bytes | lowest running total |
| `mem.native.total.end` | bytes | running total at the last event |
| `mem.native.unreleased.peak` | bytes | active bytes at the peak instant |
| `mem.native.unreleased.end` | bytes | active bytes at the end |
| `mem.native.unreleased.unattributed.bytes` | bytes | active bytes with no callchain |
| `mem.native.alloc.unaddressed.count` | count | allocations with no address |
| `mem.native.free.unpaired.count` | count | frees with no tracked alloc |
| `mem.native.callchains.count` | count | distinct callchains in the unreleased set |
| `mem.native.peak.offset` | ms | peak timestamp from the first app event |
| `mem.native.degraded` | count | proxy when no native data exists |
| `mem.native.statistic.fallback` | count | proxy flag when only statistics exist |

Provenance: `{ collector: 'hiprofiler', table: 'native_hook', rows: events }`.
Every byte figure is `exact` when derived from `native_hook`; the statistic
fallback marks its metrics `proxy` and carries the reason.

### Evidence

One `native_memory` item per unreleased row at the peak (top 10 by size) and at
the end (top 10), each with `point` (`peak` / `end`), `size`, `count`,
`relativeMs`, `category`, `subCategory`, `file`, `symbol`, `thread`, and
drill-downs to `mem.native.callchain` (the full frame stack),
`mem.native.unreleased` (the whole list at that point) and `frames.all` for the
window around the instant.

Evidence `key` is `native-memory:<point>:<callchainId>:<pid>:<tid>`, so the two
points never collide. Severity is `warn` for a row at or above 5% of the peak
unreleased total and `info` otherwise; the threshold is a concentration
signal, not a judgment.

### Degraded paths

- No `native_hook` and no `native_hook_statistic` rows → one
  `mem.native.degraded` proxy and one `no_data` evidence naming
  `--hiprofiler --plugins nativehook` and the debuggable-app requirement.
- `native_hook` empty but `native_hook_statistic` present → end-of-capture
  unreleased per callchain from `apply_size - release_size`, `proxy`
  fidelity, reason: "statistics carry no per-allocation timestamp, thread or
  address, so peak, timeline and per-thread split are unavailable". No zero is
  ever emitted for a metric that cannot be derived.
- App pids resolve to no process in the trace → degraded with that reason, as
  the other analyzers do.

## Library surface

```ts
// packages/core/src/query/native-hook.ts
export interface NativeHookEvent { id, callchainId, ipid, itid, eventType,
  subTypeId, startTs, endTs, dur, addr, heapSize, allHeapSize, currentSizeDur,
  lastLibId, lastSymbolId }
export interface NativeHookFrame { id, callchainId, depth, ip, symbolId,
  fileId, offset, symbolOffset, vaddr }
export interface NativeHookStatistic { id, callchainId, ipid, ts, type,
  subTypeId, applyCount, releaseCount, applySize, releaseSize, lastLibId,
  lastSymbolId }
export class NativeHookQuery {
  hasData(): boolean;
  hasStatistics(): boolean;
  events(pids: readonly number[], range?: TimeRange): NativeHookEvent[];
  frames(callchainIds: readonly number[]): Map<number, NativeHookFrame[]>;
  statistics(pids: readonly number[]): NativeHookStatistic[];
  dataDict(ids: readonly number[]): Map<number, string>;
}

// packages/core/src/analyze/native-memory.ts
export interface UnreleasedRow { callchainId, pid, process, tid, thread, file,
  symbol, size, count, firstRelativeNs, category, categoryName, subCategory }
export interface NativeTimelineBucket { startNs, endNs, allocBytes,
  freeBytes, deltaBytes, totalBytes, isPeak }
export class NativeMemoryAnalyzer implements Analyzer { /* id: 'native-memory' */ }
export function pairNativeMemory(events, opts): NativeMemoryResult;
export function classifyNativePath(filePath, symbol, thread): NativeCategory;
```

`pairNativeMemory` is exported so the pairing and peak logic is testable
without a database; the analyzer builds the events from `NativeHookQuery` and
calls it.

## Fidelity and honesty rules

- `heap_size` is bytes as the hook recorded them. No sampling extrapolation, no
  estimated allocation overhead, no rounding into MB.
- Peak and trough are properties of the events in the capture window. A trace
  that starts after allocations happened begins at 0 and may trough negative;
  that is reported, not clamped.
- The statistic fallback never claims a peak, a timeline or a per-thread split.
- Every array is sorted deterministically: events `(start_ts, id)`, rows
  `(size desc, callchainId, pid, tid)`, timeline `(startNs)`.
- All queries return `[]` on absent tables; no analyzer throws on a missing
  table.

## Testing

- Fixture database with `native_hook`, `native_hook_frame`, `native_hook_statistic`,
  `data_dict`, `process`, `thread`:
  - alloc/free pairing across two addresses, LIFO reuse of one address, and a
    partial free that leaves a remainder;
  - peak value/time and trough with a negative start;
  - unreleased at peak and end, merged per `(pid, tid)`, with unattributed bytes
    counted once;
  - free of an unknown address applied to the total and counted unpaired;
  - classification: exact path, regex, bundle `.so`, bundle `.abc` with ArkTS
    symbol refinement, KMP symbol, basename fallback, default `SYS_SDK`, thread
    fallback;
  - timeline buckets with a gap (omitted, not zero) and the peak bucket flag;
  - statistic-only fallback: proxy fidelity, no peak metric, reason present;
  - absent tables → `mem.native.degraded` and `[]` from every query;
  - determinism: two runs byte-identical, equal sizes ordered by callchain.
- Named queries: row shapes, `[]` on absent tables, argument validation.
- Engine: `native-memory` in the default list; every emitted tool literal
  registered.
- Full suite and both typechecks; recorded traces have empty `native_hook`, so
  `native-memory` must degrade there and the existing e2e counts shift by
  exactly one metric and one evidence item.

## Exit criteria

1. On a fixture with known alloc/free events, peak, trough and both unreleased
   totals equal a hand-computed answer.
2. LIFO pairing and partial frees behave as documented, with unpaired frees
   counted rather than hidden.
3. A capture without native data reports `mem.native.degraded`; a
   statistics-only capture reports proxy metrics and never a peak.
4. `mem.native.unreleased`, `mem.native.callchain`, `mem.native.timeline` and
   `mem.native.categories` are queryable, deterministic and listed by
   `ohos-perf tools`.
5. `report` renders a `Native memory` section; reruns stay byte-identical.
6. Full suite and both typechecks green; release `0.6.0` updates changelog,
   README, skill, site and roadmap.

## Later workstreams (roadmap context)

`0.7.0` W4 hilog · `0.8.0` W5 scenario runner · `0.9.0` W6 UI capture/diff ·
`0.10.0` W7 static HAP · `0.11.0` W8 symbols · meminfo/GPU/DMA parsing as its
own later item.
