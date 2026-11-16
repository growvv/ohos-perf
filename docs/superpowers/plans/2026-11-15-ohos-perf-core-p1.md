# ohos-perf P1 Main Analyzers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: complete (verified 2026-11-16).** All 10 tasks shipped. Re-verified: every query method the Interfaces blocks declare exists in `packages/core/src/query/`; the plan's real-trace smoke numbers match the fixture exactly; the HapRay parity goldens run in the unit project.

**Goal:** Add the P1 analysis wave — fault tree, binder IPC, redundant threads, procfs memory, and startup — with typed queries, provenance/fidelity, and field-level parity against HapRay on the recorded traces.

**Architecture:** Extend the read-only query layer (sched, thread_state, instant, callstack, perf, binder, startup), port HapRay's SQL and post-processing into pure TS functions, wrap each in an `Analyzer` that emits `Metric`/`Evidence`, and add a small engine that skips analyzers whose required capabilities are missing by emitting a degraded metric instead of a fabricated zero. Procfs and startup add a collector plus scene metadata; the CLI gains `collect` and runs all analyzers in `analyze`.

**Tech Stack:** TypeScript (ESM), `node:sqlite`, Vitest, Node `^22.13.0 || >=23.4.0`, no native dependencies.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` (§3, §5, §9, §11 P1)

## Global Constraints

- Node engines: `^22.13.0 || >=23.4.0`; ESM only; no new runtime dependencies; SQLite only through `QueryHandle`.
- Source of truth for ported logic: HapRay `9386e4e` at `E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing`. Port SQL verbatim, including `LEFT JOIN` and filters; rewrite only the pandas/dict post-processing.
- **License:** HapRay is Apache-2.0. Every file with ported logic carries a header `Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.` Add `THIRD_PARTY_NOTICES.md` and `LICENSES/Apache-2.0.txt` in Task 3. The rest of the project stays MIT.
- Every metric carries `provenance` (collector, table, rows, device) and `fidelity`; never emit `NaN`/`Infinity`/`null` values.
- Analyzers are pure: no IO, no `Date.now()`, no randomness. All arrays sorted explicitly; group-by iteration must not depend on insertion order for observable output.
- Evidence ids hash only kind/subject/window. When multiple evidence items in one analyzer can share those (per-signal, per-pair, per-analyzer-degradation), pass a unique `key` to `evidence()`; it is hashed but not stored in the output.
- Missing capability is a degraded metric (`id: '<analyzer>.degraded'`), never a silent empty result and never a throw.
- Read-only databases: never create indexes or write to a scene's `trace.db`.
- Real-trace tests use `spike/out/emu_big.db` and `spike/out/real_device.db` (gitignored) and `it.skipIf` when absent; their HapRay goldens are committed.
- Each task ends with `npm test` green and one commit containing code, tests, and exports.

## P1 Table DDL (verified against `trace_streamer` output)

Use these exact column sets in test fixtures; production code must tolerate the columns listed here and ignore extras.

```sql
CREATE TABLE instant (ts INT, name TEXT, ref INT, wakeup_from INT, ref_type TEXT, value REAL);
CREATE TABLE sched_slice (id INT, ts INT, dur INT, ts_end INT, cpu INT, itid INT, ipid INT, end_state TEXT, priority INT, arg_setid INT);
CREATE TABLE thread_state (id INT, ts INT, dur INT, cpu INT, itid INT, tid INT, pid INT, state TEXT, arg_setid INT);
CREATE TABLE callstack (id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT, depth INT, cookie INT, parent_id INT, argsetid INT, chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT, trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT);
CREATE TABLE args (id INT, key INT, datatype INT, value INT, argset INT);
CREATE TABLE data_dict (id INT, data TEXT);
CREATE TABLE perf_thread (id INT, thread_id INT, process_id INT, thread_name TEXT);
CREATE TABLE perf_sample (id INT, callchain_id INT, timeStamp INT, thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT, thread_state TEXT);
CREATE TABLE perf_callchain (id INT, callchain_id INT, depth INT, ip INT, vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT, source_file_id INT, line_number INT);
CREATE TABLE perf_files (id INT, file_id INT, serial_id INT, symbol TEXT, path TEXT);
CREATE TABLE app_startup (id INT, call_id INT, ipid INT, tid INT, start_time INT, end_time INT, start_name INT, packed_name TEXT);
CREATE TABLE thread (id INT, itid INT, tid INT, name TEXT, start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT);
CREATE TABLE process (id INT, ipid INT, pid INT, name TEXT, start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT);
CREATE TABLE trace_range (start_ts INT, end_ts INT);
CREATE TABLE frame_slice (id INT, ts INT, vsync INT, ipid INT, itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT, flag INT, depth INT, frame_no INT);
```

Notes: `instant` has **no `id` column** and is ordered by `ts, ref, wakeup_from`. `thread_state` does have an `id` but the accessor deliberately ignores it and orders by `ts, itid, state`; per-thread state arrays stay `ts`-ascending, which is what HapRay's consumer observes. `args.key` and `args.value` are `data_dict` ids; `datatype = 1` marks `value` as an id to resolve through `data_dict`, while `key` is **always** resolved through `data_dict`. `perf_sample.thread_id` joins `perf_thread.thread_id`, not `thread.id`.

## Review Focus

1. **Empty or unknown app pids:** `--app` names may not exist and pids may be omitted. Every analyzer must return a `no_data`/degraded explanation, not an SQL error and not a confident zero. (Pinned in Tasks 3, 4, 6, 9.)
2. **Binder half-transactions:** a request without a response, a response without a request, or events without `transaction id` must contribute no latency; averages/max must never become `NaN`. (Task 4.)
3. **pid vs ipid:** fingerprints use pid, trace tables use ipid. Resolve through `process` and keep the lowest-`id` tie-break; a pid passed as an ipid must not silently analyze another process. (Tasks 1, 2, 3, 9.)
4. **Determinism of aggregates:** equal-count groups have no inherent order; every public array needs an explicit secondary key, and float sums need a fixed order. (Tasks 4, 6.)
5. **Partial procfs/startup data:** missing `smaps_rollup`, some failed samples, an empty `app_startup` table, or a missing start marker must degrade individual outputs, never invent 0 PSS/0 ms. (Tasks 7, 8, 9.)

---

### Task 1: Trace query layer for P1

**Files:**
- Create: `packages/core/src/query/sched.ts`, `packages/core/src/query/thread-state.ts`, `packages/core/src/query/callstack.ts`, `packages/core/src/query/perf.ts`, `packages/core/src/query/binder.ts`, `packages/core/src/query/startup.ts`
- Modify: `packages/core/src/query/process.ts` (add `byPid`), `packages/core/src/index.ts`
- Test: `packages/core/test/query-sched-state.test.ts`, `packages/core/test/query-callstack-perf.test.ts`, `packages/core/test/query-binder-startup.test.ts`

**Interfaces:**
- Produces:
  - `SchedQuery.all(range?): SchedSlice[]` (`ORDER BY ts, id`); `forItids(itids: number[], range?): SchedSlice[]`
  - `InstantQuery.wakeups(range): WakeupEvent[]` — `instant.name IN ('sched_wakeup','sched_waking') AND ref_type='itid' AND wakeup_from IS NOT NULL AND ref IS NOT NULL`, `ORDER BY ts, ref, wakeup_from` (the table has no `id`)
  - `ThreadStateQuery.all(range?)`, `forItids(itids, range?)` — `ORDER BY ts, itid, state` (the table has no `id`)
  - `CallstackQuery.all(range?)`, `matching(pattern: string, opts?: { range?: TimeRange; limit?: number })`, `withArgs(range?)` — args resolved through `args`+`data_dict` (key always via `data_dict`; value via `data_dict` iff `datatype=1`); `ORDER BY ts, id`
  - `PerfQuery.hasSamples(): boolean`, `threads(pids: number[]): PerfThread[]`, `samples(threadIds: number[], range): PerfSampleRow[]`, `callchains(threadIds: number[], range, maxChainsPerThread?: number): PerfCallchain[]`
  - `BinderQuery.events(): BinderEvent[]` — `callstack.name LIKE '%binder%' LEFT JOIN args ON callstack.argsetid=args.argset`, keys/values resolved via `data_dict` as stated above, `code` parsed as hex when the first token starts with `0x`; `ORDER BY id`
  - `StartupQuery.all(range?)`, `forIpids(ipids: number[])` over `app_startup`
  - `ProcessQuery.byPid(pid: number): ProcessInfo | undefined` (lowest `id` tie-break)
- Row interfaces use camelCase and non-nullable fields through `num()`/`str()`; nullable perf columns (`qps`, `avgIntervalMs`) stay `number | null`.

- [x] **Step 1: Write failing query tests**

For each query, build a tiny DB with the real DDL (copy `PRAGMA table_info` output from Task plan context), insert NULLs and out-of-order timestamps, and assert: camelCase mapping, NULL→0/'' via `num`/`str`, `ORDER BY ts, id`, range bounds inclusive, and `[]` for missing optional tables (`perf_thread`, `perf_callchain`, `perf_files`, `app_startup`).
Binder test data must include `data_dict` rows for a key, a string value with `datatype=1`, and `code = "0x10 Java Layer Dependent"`; assert the arg key is the dictionary text and `code === 16`.
Real-trace smoke (`it.skipIf(!existsSync('spike/out/emu_big.db'))`): `new SchedQuery(db).all()` has 60053 rows, `ThreadStateQuery.all()` 121076, `CallstackQuery.all()` 35415, `BinderQuery.events()` 3583; emu_big has 21 threads for pid 16702 and real_device 18 for pid 6115.

- [x] **Step 2: Run tests, see them fail**

Run: `npx vitest run packages/core/test/query-sched-state.test.ts packages/core/test/query-callstack-perf.test.ts packages/core/test/query-binder-startup.test.ts`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement the queries**

Follow `query/frames.ts` and `query/process.ts` patterns: one `SELECT_*` constant, one row→interface mapper, filters applied in SQL with parameters, optional tables guarded by a private `hasTable(name)`.
`CallstackQuery.withArgs` reads callstack rows and their args in one query, grouping by `callstack.id`; `matching` interpolates only a SQL `LIKE` pattern supplied by the caller (never a shell), with `LIMIT ?`.
`PerfQuery.callchains` mirrors `_query_callchains_batch` (`core/common/thread_wakeup_chain.py:94-183`): at most 50 chain ids per thread, 20 chains per result, frames ordered by depth, symbols resolved through `perf_files` with the same two-step lookup.

- [x] **Step 4: Run tests, make them pass**

Run the command from Step 2. Expected: PASS.

- [x] **Step 5: Export and commit**

Add the new classes/types to `packages/core/src/index.ts` (explicit named exports, no `export *`), run `npm test`, then:

```bash
git add packages/core/src/query packages/core/src/index.ts packages/core/test/query-sched-state.test.ts packages/core/test/query-callstack-perf.test.ts packages/core/test/query-binder-startup.test.ts
git commit -m "feat: add P1 trace query layer"
```

---

### Task 2: Analysis engine, app identity, and HapRay fixtures

**Files:**
- Create: `packages/core/src/analyze/engine.ts`, `packages/core/src/analyze/context.ts`, `packages/core/test/analyze-engine.test.ts`, `packages/core/test/fixtures/hapray/*.json`, `scripts/parity/hapray_reference.py`, `scripts/parity/README.md`
- Modify: `packages/core/src/analyze/types.ts`, `packages/core/src/report/evidence.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/parity-fixtures.test.ts`

**Interfaces:**
- Produces:
  - `AnalyzeContext` gains optional query fields only: `threads?: ThreadQuery`, `sched?: SchedQuery`, `instant?: InstantQuery`, `threadStates?: ThreadStateQuery`, `callstacks?: CallstackQuery`, `perf?: PerfQuery`, `binder?: BinderQuery`, `startup?: StartupQuery`. (`procfs` is added in Task 7 and `metadata` in Task 9, when their types exist — adding them here would not compile.)
  - `runAnalyzers(analyzers: readonly Analyzer[], ctx: AnalyzeContext): Promise<AnalyzeResult>` — sorts analyzers by `id`; for each, `const check = ctx.caps.satisfies(analyzer.requires)`; when `!check.ok`, emits metric `{ id: `${analyzer.id}.degraded`, value: 0, unit: 'count', fidelity: 'proxy', degraded: { reason: `missing ${check.missing.map(s => s.id).join(', ')}: ${check.missing.map(s => s.reason ?? 'unavailable').join('; ')}`, fallback: 'analyzer skipped' }, provenance: { collector: 'capability-matrix', device: ctx.deviceId } }` plus one `degraded_capability` evidence; otherwise runs it. Concatenates results, sorts metrics by `id` and evidence by `(kind, window.startNs, id)`, throws `OhosPerfError('DUPLICATE_METRIC_ID')` on collisions.
  - `resolveAppIdentity(processes: ProcessQuery, packageName: string): AppIdentity` — exact `byName`, `pids: [pid]` when found else `[]`; `processNames` is `[packageName]`.
  - `defaultAnalyzers(): Analyzer[]` — initially `[new FrameAnalyzer()]`; later tasks append.
- Golden files: `fault-tree.emu_big.json`, `binder.emu_big.json`, `threads.emu_big.json`, `thread-wakeup.emu_big.json`, `fault-tree.real_device.json`, `threads.real_device.json`, `thread-wakeup.real_device.json`. The first four (plus `fault-tree.real_device.json`, `threads.real_device.json`) are the `step1` payload, not the outer `{step1: ...}` wrapper; the two `thread-wakeup.*` files are already bare arrays (HapRay's `ThreadWakeup` output) and are copied as-is. `binder.real_device.json` is `{}`.
- `evidence()` gains an optional `key?: string` that is appended to the hash material only when present, so existing evidence ids stay byte-identical. The engine passes `key: analyzer.id`; later analyzers pass their per-item discriminator.

- [x] **Step 1: Write failing engine tests**

Use three fake analyzers: one available, one requiring `mem.native_hook` (unavailable), one requiring `perf.pmu` (unavailable with a reason). Assert: degraded metric id/value/unit/fidelity and `degraded.reason` contains the capability id and device reason; two `degraded_capability` evidence items exist and their ids are distinct (same subject and window, different `key`); available metrics are merged and sorted by id; two analyzers emitting the same id throw `DUPLICATE_METRIC_ID`; the input context and analyzer objects are not mutated.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-engine.test.ts`
Expected: FAIL — `engine.ts` missing.

- [x] **Step 3: Implement the engine and context additions**

Use `metric()`/`evidence()` builders. Evidence subject process: `ctx.app.processNames.find(n => n !== '') ?? ctx.app.packageName`; window `ctx.window`; `signals: { missing: missing.join(',') }`; drillDown `{ label: 'Capability matrix', tool: 'caps.get', args: { ids: missing }, returns: 'CapabilityState[]', estRows: missing.length }`.
`AnalyzeContext` new fields are optional so existing tests and callers keep compiling.

- [x] **Step 4: Add goldens and the reference script**

Copy the already generated payloads from `spike/out/reference/` (FaultTreeAnalyzer.json → fault-tree.emu_big.json, IpcBinderAnalyzer.json → binder.emu_big.json, ThreadAnalyzer.json → threads.emu_big.json, ThreadWakeup.emu_big.json → thread-wakeup.emu_big.json; same for `.real.json` and `ThreadWakeup.real_device.json`). Strip the outer `step1` key.
`scripts/parity/hapray_reference.py` must accept `--hapray-root`, `--trace`, `--pids`, `--out-dir`; build a temp scene with `hiperf/step1/pids.json`, run `FaultTreeAnalyzer`, `IpcBinderAnalyzer`, `ThreadAnalyzer`, and `analyze_all_threads_wakeup_chain`; write the same file names. `scripts/parity/README.md` records the HapRay rev `9386e4e`, the venv used, and the exact commands for both traces (app pids `16702` / `6115`).
`parity-fixtures.test.ts` only asserts the files parse and contain the expected top-level keys, so a corrupted fixture fails early.

- [x] **Step 5: Run all tests and commit**

Run: `npm test`. Expected: 291 + new tests PASS.
Then commit engine, context, goldens, script, tests.

---

### Task 3: Fault-tree analyzer + first parity test + license notices

**Files:**
- Create: `packages/core/src/analyze/fault-tree.ts`, `packages/core/test/analyze-fault-tree.test.ts`, `THIRD_PARTY_NOTICES.md`, `LICENSES/Apache-2.0.txt`
- Modify: `packages/core/src/analyze/types.ts` (add `db?: QueryHandle`), `packages/core/src/analyze/engine.ts` (`defaultAnalyzers`), `packages/core/src/report/evidence.ts` (kind `fault_pattern`), `packages/core/src/index.ts`, `packages/core/test/parity-hapray.test.ts`
- Test: `packages/core/test/parity-hapray.test.ts`

**Interfaces:**
- Produces: `computeFaultTree(db: QueryHandle, opts: { appPids: number[] }): FaultTreeSignals` — exact shape from `fault_tree_analyzer.py:34-60`; `FaultTreeAnalyzer implements Analyzer` (`id: 'fault-tree'`, `requires: ['trace.binder']`).
- `AnalyzeContext` gains `db?: QueryHandle` (the trace database). The new analyzers need raw SQL that the typed query layer does not expose; when `ctx.db` is absent, `run` returns one `no_data` evidence explaining that the trace database handle was not provided, and no metrics. `ctx.db` is optional so every existing context and test still compiles.
- Metrics: `fault.<category>.<name>`; nested values flatten (`fault.RS.ProcessedNodes.ts`, `.count`, `fault.RS.AnimateSize.nodeSizeSum`, `.totalAnimationSizeSum`); `soft_decoder` is emitted as `1`/`0` with unit `none`. All `fidelity: 'exact'`; provenance collector `'hitrace+streamer'`, table `'callstack'` (perf-based audio counters use table `'perf_sample'`).
- Evidence: one `fault_pattern` per non-zero signal (skip zero counters, skip `soft_decoder=false`), severity `info`, subject process = the analyzed app name for arkui and `render_service` for RS, `signals: { category, count }`, explain `"<category> <name>: <count>"`; drillDown `{ tool: 'callstack.matching', args: { pattern }, returns: 'CallstackEvent[]' }` with the HapRay LIKE pattern.

- [x] **Step 1: Write failing unit tests**

Tiny DB with `process`, `thread`, `callstack`, `trace_range`, `perf_sample`; app pid has one thread, one `H:HandleOnAreaChangeEvent` row, one `ProcessedNodes: 42` row at start+2s, one `H:Animate [nodeSize, totalAnimationSize]` `[3, 5]` row for render_service. Assert `computeFaultTree(db, { appPids: [pid] })` equals the exact nested object; `computeFaultTree(db, { appPids: [] })` returns arkui zeros without throwing; `soft_decoder` false when `av_codec_servic*` has no rows.
Analyzer test: metric ids/values, `fault.RS.ProcessedNodes.ts` is 2.0 (seconds from start), non-zero evidence only, evidence sorted, and provenance device from ctx.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-fault-tree.test.ts`
Expected: FAIL.

- [x] **Step 3: Port the analyzer**

Port `fault_tree_analyzer.py:112-417` query by query. Substitute app pids with `?` placeholders; when `appPids` is empty, return 0 for app-scoped counters without executing `IN ()`. `ProcessedNodes.ts` is `(row.ts - trace_range.start_ts) / 1e9` for the row with the **maximum** count (ties keep the first by `ts`). `AnimateSize` sums every matching render_service row. `tableRowCounts` is not needed; use the row count returned by each query for `provenance.rows`.
`THIRD_PARTY_NOTICES.md` names ArkAnalyzer-HapRay, its Apache-2.0 license, the upstream URL, the rev, and the ported files; copy the Apache-2.0 text into `LICENSES/Apache-2.0.txt`. Add the header to `fault-tree.ts` and to the Task 1 query files that carry ported SQL (`sched.ts`, `callstack.ts`, `perf.ts`, `binder.ts`).

- [x] **Step 4: Add parity test**

`parity-hapray.test.ts`: skip if `spike/out/emu_big.db` absent. Open read-only, `computeFaultTree(db, { appPids: [16702] })`, compare deep-equal to `fault-tree.emu_big.json`; repeat for `real_device.db` with `[6115]`. Run it. Expected: PASS with exactly 51/56/63/34 and the real-device 4/84/4/1 values.

- [x] **Step 5: Wire into defaults, run all, commit**

Append `new FaultTreeAnalyzer()` to `defaultAnalyzers()`; export the analyzer and `FaultTreeSignals`; `npm test`; commit.

---

### Task 4: Binder analyzer + parity

**Files:**
- Create: `packages/core/src/analyze/binder.ts`, `packages/core/test/analyze-binder.test.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/report/evidence.ts` (kind `binder_hotspot`), `packages/core/src/index.ts`, `packages/core/test/parity-hapray.test.ts`

**Interfaces:**
- Produces: `computeBinderAnalysis(db: QueryHandle, opts: { appPids: number[] }): BinderAnalysis` with:
  - `transactions: BinderTransaction[]` (`transactionId: string | number`, `caller/callee: { pid: number | null; tid: number | null; procName: string | null; threadName: string | null }`, `requestTs/responseTs: number | null`, `latencyMs: number | null`)
  - `processStats`, `threadStats`, `interfaceStats` exactly mirroring `ipc_binder_analyzer.py` field names/types; `qps`/`avgIntervalMs` are `number | null`.
  - `BinderAnalyzer implements Analyzer` (`id: 'binder'`, `requires: ['trace.binder']`); it calls `computeBinderAnalysis(ctx.db, ...)` and, when `ctx.db` is absent, returns one `no_data` evidence and no metrics.
- Metrics: `binder.transactions.count` (every transaction with a transaction id, including orphans), `binder.latency.avg`, `binder.latency.max`, `binder.process.pairs`, `binder.thread.pairs`, `binder.interfaces.count`; unit `count`/`ms`; exact fidelity; provenance table `'callstack'`. The latency/pair/interface metrics are emitted only when at least one completed request/response pair exists; otherwise emit `binder.transactions.count` plus one `no_data` evidence explaining that no transaction could be paired. Never emit 0 latency for unpaired traffic.
- Evidence: top 5 process pairs by count, then key ascending, kind `binder_hotspot`, severity `info`, subject `{ process: callerProc }`, signals `{ calleeProc, count, avgLatencyMs, maxLatencyMs, qps }`; drillDown `{ tool: 'binder.processStats', args: { callerProc, calleeProc }, returns: 'BinderProcessStat' }`.

- [x] **Step 1: Write failing unit tests**

Synthetic DB: two request/response pairs for txn 1 and 2, one orphan request for txn 3, one event without `transaction id`, one response with only `destination process`. Assert: only txns 1/2 have latency; transaction 3 included with `latencyMs: null`; the no-id event is absent from transactions; process/thread/interface aggregates sum to 2; null latency never enters aggregates; empty app pids filters everything without throwing.
Use HapRay's real classifier keywords: request names contain `binder transaction` (including `binder transaction async`); response names contain `binder reply` or `binder async rcv`; response wins when a name contains both. Use `H:binder transaction` / `H:binder reply` in the fixture, and add one name containing both to pin the response-wins rule.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-binder.test.ts`
Expected: FAIL.

- [x] **Step 3: Port the analyzer**

Port `ipc_binder_analyzer.py:120-725` function by function. Preserve:
- event filtering by app pids via `thread.id → process pid`, destination process, and calling tid;
- request = earliest request event, response = latest response event per txn (Python `min`/`max` on ts);
- `latency = (response.ts - request.ts) / 1e6`, only when both exist;
- both aggregations use `mean` over latencies and QPS over request timestamps; Python `round` is only applied at report time, not in the stats — do not round inside `computeBinderAnalysis`.
- Sorting: stats count desc, then caller/callee (or code) ascending; `transactions` by `(requestTs ?? 0, String(transactionId))` ascending. These are the only deliberate differences from Python's unstable tie order.
- `code`: integer encoded as `0x<hex>` in interface stats, string codes kept as-is.
`computeBinderAnalysis` must never emit `NaN`: guard every mean.

- [x] **Step 4: Parity test**

Open emu_big, call `computeBinderAnalysis(db, { appPids: [16702] })`, compare to `binder.emu_big.json`:
- `processStats`, `threadStats`, `interfaceStats` compared as maps keyed by their identity fields, so tie ordering is irrelevant;
- numbers compared with `toBeCloseTo(expected, 6)`, counts/strings/null exactly;
- expected totals pinned: 6 process pairs, 28 thread pairs, 4 interfaces, first pair `pbench.baseline → render_service` count 106, avg latency 0.843066.
Real-device golden is empty (`step1` is `{}`), so skip it for binder; the analyzer must return empty arrays for `real_device.db` + `[6115]`.

- [x] **Step 5: Wire, test, commit**

Add `new BinderAnalyzer()` to defaults; export; `npm test`; commit.

---

### Task 5: Thread wakeup chain + parity

**Files:**
- Create: `packages/core/src/analyze/threads-wakeup.ts`, `packages/core/test/analyze-thread-wakeup.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test/parity-hapray.test.ts`

**Interfaces:**
- Produces:
  - `analyzeThreadWakeup(db: QueryHandle, opts: { appPids: number[]; timeRange?: TimeRange; maxThreads?: number }): ThreadWakeupResult[]`
  - `ThreadWakeupResult { threadId: number; threadInfo: { threadName: string; startTs: number | null; endTs: number | null }; totalInstructions: number; wakeupThreads: ThreadWakeupThread[] }`
  - `ThreadWakeupThread { itid: number; tid: number | null; threadName: string | null; pid: number | null; processName: string | null; instructionCount: number; isSystemThread: boolean; wakeupDepth: number; threadStates: Array<{ ts: number; dur: number; state: string }>; callchains: Array<{ functions: Array<{ symbol: string; name: string; filePath: string }> }> }`
  - Results sorted by `threadId`; `wakeupThreads` in wakeup-chain order (start thread depth 0 first).
- Port targets: `thread_wakeup_chain.py` (`_build_perf_thread_id_map`, `_query_thread_states_batch`, `_query_callchains_batch`, `_build_instant_cache`, `_build_perf_sample_cache`, `_build_tid_to_info_cache`, `analyze_all_threads_wakeup_chain`) and the used branches of `frame_wakeup_chain.find_wakeup_chain`, `map_itid_to_perf_thread_id`, `frame_utils.is_system_thread`, `frame_core_load_calculator.calculate_thread_instructions`. Do **not** port `ensure_perf_trace_indexes` (it writes to the DB).

- [x] **Step 1: Write failing unit tests**

Synthetic DB with two app threads and one render_service thread: `instant` rows waking app thread 1 from app thread 2 at t-10ms, and thread 2 from system thread at t-20ms; assert depths `[0,1,2]` and order. `perf_sample` absent → every `instructionCount` is 0 and `isSystemThread` follows the ported keyword rules. Empty app pids returns `[]`. A DB missing `perf_thread` must not throw.
Real-trace counts: emu_big `[16702]` yields 21 results, real_device `[6115]` yields 18; do not assert callchain contents here (the golden does).

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-thread-wakeup.test.ts`
Expected: FAIL.

- [x] **Step 3: Port the call graph**

Keep the same constants (`search_start = frame_start - 50_000_000`, `max_depth = 20`, max 50 chain ids / 20 callchains per thread). Use a `Map<number, Array<[number, number]>>` for the instant cache and sort candidates by `ts` descending; prefer app-process wakers when `appPid` matches. Instruction calculation is the binary-search sum over `perf_sample` event counts, split by `isSystemThread`; with no samples both maps are empty and every count is 0.
Thread states use HapRay's overlap predicate `ts < rangeEnd AND ts + COALESCE(dur, 0) > rangeStart` and per-itid `ts` ordering — do **not** call `ThreadStateQuery.forItids(itids, range)`, whose inclusive `ts >= start AND ts <= end` filter is a different predicate (it happens to match on these traces, but the port must be faithful).
Time range: explicit `opts.timeRange` wins; otherwise mimic HapRay's fallback chain `trace_range → frame_slice → callstack_events → trace` (the last two named tables may not exist in our fixtures; skip absent tables), with `frame_slice` extended by `max(ts + COALESCE(dur, 0))`; if none, throw `THREAD_NO_TIME_RANGE`.
`threadInfo.startTs/endTs` come from the `thread` row via `ThreadQuery`, mapping its `0`-means-absent values to `null`; both `thread.start_ts` and `thread.end_ts` are NULL on every row of both fixture traces, so they serialize as `null`, matching HapRay (whose query never selects them). Do not substitute `0`.

- [x] **Step 4: Parity test**

Compare `analyzeThreadWakeup` to `thread-wakeup.emu_big.json` and `.real_device.json`: sort both sides by `threadId`, then compare `threadId`, `threadInfo.threadName`, `totalInstructions`, and every wakeup-thread field exactly. The committed goldens project the two arrays to `thread_states_count` / `callchains_count`, so compare each wakeup thread's `threadStates.length` and `callchains.length` to those counts rather than deep-comparing array contents. Pinned: thread 16702 has `wakeupDepth` 0 and 21 app threads exist; real device 18.

- [x] **Step 5: Run all, commit**

`npx vitest run packages/core/test/analyze-thread-wakeup.test.ts packages/core/test/parity-hapray.test.ts` then `npm test`; commit.

---

### Task 6: Thread scoring and ThreadAnalyzer

**Files:**
- Create: `packages/core/src/analyze/threads-score.ts`, `packages/core/test/analyze-threads.test.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/report/evidence.ts` (kind `thread_redundancy`), `packages/core/src/index.ts`, `packages/core/test/parity-hapray.test.ts`, `THIRD_PARTY_NOTICES.md`
- License: `// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.` at the top of `threads-score.ts`, and add its upstream sources (`thread_optimization.py`, `thread_utils.py`, `thread_analyzer.py`) to the notices table.

**Interfaces:**
- Produces: `computeThreadAnalysis(results: ThreadWakeupResult[]): ThreadAnalysis` with `redundantThreadsSummary`, `summary`, `belowThresholdPatterns`. The three payloads keep HapRay's **snake_case field names verbatim** (`redundancy_types`, `total_redundant_thread_patterns`, `max_score`, …) so the golden comparison is direct; only the three top-level property names are camelCase. `ThreadAnalyzer implements Analyzer` (`id: 'threads'`, `requires: ['trace.sched', 'trace.thread_state']`). It obtains `ThreadWakeupResult[]` via `analyzeThreadWakeup(ctx.db, { appPids: ctx.app.pids })` — deliberately **not** `timeRange: ctx.window`, because the CLI window is `0..MAX_SAFE_INTEGER` and HapRay derives its range from `trace_range`; passing the open window would change thread-state counts. When `ctx.db` is absent, it returns one `no_data` evidence and no metrics.
- Metrics: `thread.patterns.count`, `thread.redundant.count`, `thread.instructions.total`, `thread.redundant.instructions`, `thread.redundant.instructions.ratio` (value is HapRay's 0–1 ratio × 100, unit `%`). Fidelity exact except the ratio: `'exact'`.
- Evidence: one `thread_redundancy` per pattern in `redundantThreadsSummary.redundantThreads`, severity `warn`, subject `{ process: <analyzed app name>, thread: thread_name }`, window `ctx.window`, signals `{ score, redundantCount, waitingRatio, instructions }`, explain from the pattern's `type_label`; drillDown `{ tool: 'threads.pattern', args: { threadName }, returns: 'RedundantThreadPattern' }`. If there are no patterns, emit one `no_data` evidence (not zero metrics only).

- [x] **Step 1: Write failing tests**

Synthetic `computeThreadAnalysis` input with one duplicated pattern (`ace.bg_1`, `ace.bg_2` → pattern `ace.bg`) and one singleton below threshold; assert pattern key normalization, score aggregation, sorting by score desc then name, and that `OS_*` patterns are ignored. Analyzer test: metrics values, ratio as percentage, no_data evidence when zero patterns, evidence ids distinct.
Pinned real values: emu_big has 0 patterns and 9 below-threshold entries; real_device has 0 patterns and 2 below-threshold entries (`hiprofilerd` max score 40).

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-threads.test.ts`
Expected: FAIL.

- [x] **Step 3: Port scoring**

Port `thread_utils.py` (pattern key, ignore `OS_`, callchain sample, frame counts, memory estimate, `num`) and all of `thread_optimization.py` (`per_thread_redundancy_score`, `thread_redundancy_features`, `analyze_optimization_opportunities`). Preserve thresholds and the exact `score_breakdown` keys. Python's `round(x, 6)` applies to the summary outputs; mirror it with a deterministic `round6` helper. Sorting: `redundant_threads` by `redundancy_score` descending then `thread_name` ascending; `below_threshold_patterns` by `thread_name` ascending.

- [x] **Step 4: Parity test**

Compare `computeThreadAnalysis(analyzeThreadWakeup(...))` to `threads.emu_big.json` / `threads.real_device.json`. Normalize both sides first: sort `redundant_threads` and `below_threshold_patterns` by `thread_name` (HapRay emits them in trace insertion order; our public output sorts by name for determinism), then deep-equal strings/arrays and use `toBeCloseTo(..., 6)` for floats. Compare `summary` as an object with tolerance. Empty app pids → empty analysis, no throw.

- [x] **Step 5: Wire, test, commit**

Add `new ThreadAnalyzer()` to defaults; export; `npm test`; commit.

---

### Task 7: procfs collector

**Files:**
- Create: `packages/core/src/collectors/procfs.ts`, `packages/core/test/collector-procfs.test.ts`
- Modify: `packages/core/src/analyze/types.ts` (add `procfs?: ProcfsSample[]`), `packages/core/src/ingest/scene.ts` (`procfsFile: join(root, 'procfs.jsonl')` in `SceneLayout`), `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `ProcfsStatus { vmRssBytes: number; vmHwmBytes: number; threads: number }`
  - `SmapsRollup { pssBytes: number; privateDirtyBytes: number; swapPssBytes: number }`
  - `ProcfsSample { ts: number; pid: number; status: ProcfsStatus; smaps?: SmapsRollup }`
  - `parseProcfsStatus(text: string): ProcfsStatus | undefined` and `parseSmapsRollup(text: string): SmapsRollup | undefined` (pure, exported for tests)
  - `readProcfsSamples(path: string): ProcfsSample[]`, `writeProcfsSamples(path: string, samples: ProcfsSample[]): void`
  - `ProcfsCollector` with `id: 'procfs'`, `provides: ['mem.procfs']`, `collect(hdc, target, opts: { app: string; durationMs: number; intervalMs?: number }, layout): Promise<ProcfsSample[]>`; constructor injection `{ now?: () => number; sleep?: (ms: number) => Promise<void> }` for tests (defaults `Date.now` and a real timer).
- Validation: `app` matches `/^[A-Za-z0-9_.]+$/` (`PROCFS_BAD_APP`); `durationMs` in `(0, 2_147_483_647]`; `intervalMs` integer ≥ 100. Resolve pid with `pidof <app>`; take the first positive integer on the first non-empty line; none → `PROCFS_NO_PID` with the raw output. Each iteration runs `cat /proc/<pid>/status` and `cat /proc/<pid>/smaps_rollup`; a nonzero exit or unparsable status skips that sample. Zero successful samples → `PROCFS_NO_SAMPLES` including the last error. The JSONL file is written with one JSON object per line in sample order; the directory is created if needed.

- [x] **Step 1: Write failing tests**

Parser fixtures: realistic `status` text with `VmRSS: 123456 kB`, `VmHWM: 234567 kB`, `Threads: 42`; `smaps_rollup` with `Pss`, `Private_Dirty`, `SwapPss`; missing fields → `undefined`. Collector fake Hdc sequence: pidof `"742\n"`, 3 status/smaps responses, `now` stepping 0/500/1000, sleep recording; duration 1000/interval 500 → 3 samples at expected ts and pid. Rejection cases: `app: 'com.demo; rm -rf /'` → `PROCFS_BAD_APP`; interval 99 → `PROCFS_BAD_INTERVAL`; empty pidof → `PROCFS_NO_PID`; all cat calls failing → `PROCFS_NO_SAMPLES`. Missing `smaps_rollup` → samples without `smaps`.
`SceneLayout` test: `createSceneLayout('/x').procfsFile` is `/x/procfs.jsonl` (use `join` in the assertion).

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/collector-procfs.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement collector + serialization**

Parse kB lines with `/^(VmRSS|VmHWM|Threads):\s+(\d+)(?:\s+kB)?$/m`; multiply every kB-valued field by 1024 (`VmRSS`, `VmHWM`, `Pss`, `Private_Dirty`, `SwapPss`), so all `*Bytes` fields hold bytes. `readProcfsSamples` returns `[]` for a missing file; malformed lines are skipped (never throw on one bad line). Use `writeFileSync` with `JSON.stringify` per sample.
Sampling loop: if the first sample fails, keep trying until the duration ends (the app may not have started yet); count successes.

- [x] **Step 4: Test, export, commit**

Run the test; add exports; `npm test`; commit.

---

### Task 8: Memory analyzer

**Files:**
- Create: `packages/core/src/analyze/memory.ts`, `packages/core/test/analyze-memory.test.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/report/evidence.ts` (kind `memory_growth`), `packages/core/src/index.ts`

**Interfaces:**
- Produces: `MemoryAnalyzer implements Analyzer` (`id: 'memory'`, `requires: ['mem.procfs']`), reading `ctx.procfs`.
- Metrics: `mem.rss.peak` (bytes), `mem.rss.mean` (bytes), `mem.samples` (count); `mem.pss.peak` and `mem.pss.mean` **only when at least one sample has `smaps`**. Provenance collector `'procfs'`, rows = sample count, device. Fidelity `'exact'`. Mean uses sample order (ts ascending) and rounds to the nearest byte.
- Evidence: one `memory_growth` (severity `info`) when last RSS > first RSS, signals `{ firstRssBytes, lastRssBytes, deltaBytes, growthPercent }`; no evidence when RSS is flat or shrinking. One `no_data` when `ctx.procfs` is absent/empty, explaining how to collect (`ohos-perf collect --procfs`), never `[]` metrics silently.

- [x] **Step 1: Write failing tests**

Three samples 100/150/120 MB → peak 150 MB, mean 123.33 MB, growth evidence with delta 20 MB and ~20%. PSS present in two samples only → PSS metrics include only those two. No `smaps` → PSS metrics absent, no zero. Empty → only `no_data` evidence and no metrics. Ordering independence: same samples shuffled by ts are sorted by ts before computing first/last.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-memory.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement analyzer**

`meanBytes` guards `samples.length === 0`; percentages guard `first > 0`. Do not infer leak thresholds: growth is reported as a fact, severity stays `info`.

- [x] **Step 4: Wire, test, commit**

Append to defaults; export; `npm test`; commit.

---

### Task 9: Startup analysis and scene metadata

**Files:**
- Create: `packages/core/src/analyze/startup.ts`, `packages/core/src/ingest/metadata.ts`, `packages/core/test/analyze-startup.test.ts`
- Modify: `packages/core/src/analyze/types.ts` (`metadata?: SceneMetadata`), `packages/core/src/analyze/engine.ts`, `packages/core/src/report/evidence.ts` (kind `startup`), `packages/core/src/ingest/scene.ts` (`metadataFile`), `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `SceneMetadata { version: 1; app: { packageName: string; processNames: string[] }; pids: number[]; deviceId: string; startedAtNs?: number; capture?: { startedAtMs: number; durationMs: number; collectors: string[] } }`
  - `writeSceneMetadata(layout, meta)`, `readSceneMetadata(layout): SceneMetadata | undefined` (missing/malformed → undefined)
  - `StartupAnalyzer implements Analyzer` (`id: 'startup'`, `requires: ['trace.frames']`)
- Semantics, in order:
  1. Resolve app ipids from `ctx.processes` for every pid in `ctx.app.pids`; query `startup.all()` filtered to those ipids with `startTime > 0 && endTime >= startTime`. If any: `startup.count` = rows, `startup.duration` = `(max(endTime) - min(startTime)) / 1e6` ms, fidelity `'exact'`, provenance table `'app_startup'`.
  2. Else if `ctx.metadata?.startedAtNs` is set: take the first actual (`type === 0`) frame with `ts >= startedAtNs`; duration = `(frame.ts + frame.dur - startedAtNs) / 1e6`, fidelity `'approximate'`, `degraded: { reason: 'app_startup table is empty; derived from start marker and first frame', fallback: 'marker-to-first-frame' }`, provenance table `'frame_slice'`.
  3. Else: no metrics, one `startup`/`no_data` evidence explaining both sources were absent.
- Clock: `startedAtNs` is device uptime nanoseconds (`/proc/uptime`), the same base as trace `ts`; never use host `Date.now()` for it. `startedAtMs` in metadata is host wall-clock, for humans only.

- [x] **Step 1: Write failing tests**

Synthetic DB with `app_startup` rows (`start_time=1e9`, `end_time=2.5e9`, ipid matching the app pid) → duration 1500 ms, count 1, exact. No table rows + metadata `startedAtNs=1e9` + first actual frame at `1.2e9` dur 50ms → 250 ms approximate with degraded. No rows and no marker → no_data, no metrics. Expect-frame-only fallback ignored. `readSceneMetadata` on a malformed JSON returns `undefined`.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/core/test/analyze-startup.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement metadata + analyzer**

`writeSceneMetadata` uses `writeFileSync(join(root,'scene.json'), JSON.stringify(meta, null, 2) + '\n')`, creating the root. `readSceneMetadata` catches parse errors and validates `version === 1`. Filtering by ipid: build `ipidByPid` from `ProcessQuery.all()`; `ctx.app.pids` are **pids** — never compare them with `startup.ipid` directly.

- [x] **Step 4: Wire, test, commit**

Append to defaults; export; `npm test`; commit.

---

### Task 10: CLI collect + full analyze wiring + docs

**Files:**
- Create: `packages/cli/src/collect.ts`, `packages/cli/test/collect.test.ts`
- Modify: `packages/core/src/device/device.ts`, `packages/core/src/collectors/types.ts`, `packages/cli/src/{commands,program,deps,index}.ts`, `packages/cli/test/{program,index,commands}.test.ts`, `README.md`, `site/index.html`
- Test: `packages/cli/test/index.test.ts` (end-to-end)

**Interfaces:**
- `CollectOptions` gains `procfs?: boolean | { intervalMs?: number }`; `coldStart?: { ability: string }`.
- `Device.collect().ingest()`:
  1. if `procfs` requested and `opts.app` is missing → `COLLECT_APP_REQUIRED`;
  2. read `startedAtNs` from `cat /proc/uptime` (first token × 1e9) before any capture;
  3. when `coldStart` is set, run `aa start -a <ability> -b <app>` (validate both names with `/^[A-Za-z0-9_.]+$/`);
  4. run hitrace and (when requested) `ProcfsCollector` with `Promise.all`; both receive the same `durationMs`;
  5. write `scene.json` with `{ version: 1, app, pids: [pid] or [], deviceId, startedAtNs, capture }`;
  6. convert and open the scene as today.
- CLI: `ohos-perf collect --app <pkg> --duration <seconds> --out <dir> [--procfs] [--cold-start <ability>] [--json]`; duration parses seconds (`10` or `10s`) to ms and rejects `0`/negative; output JSON `{ sceneDir, device: { id, kind } }`, human output `scene  <dir>`.
- CLI `analyze`: build the full context (all queries, `db: scene.traceDb`, procfs samples from `layout.procfsFile`, metadata from `layout.metadataFile`, `resolveAppIdentity` from `--app`), run `defaultAnalyzers()`, and keep `--json` byte-stable. Replace the hand-built one-capability matrix with an offline matrix derived from table presence: `trace.frames`, `trace.sched`, `trace.binder`, `trace.thread_state` when those tables exist, `startup.app_startup` when `app_startup` exists, `mem.procfs` only when `procfs.jsonl` exists; every available state uses collector `'hitrace'` (or `'procfs'`) and fidelity `'exact'`. Without this, every new analyzer degrades in CLI runs.
- Docs: README P1 status, metric id list, `collect` quickstart; site capability/feature copy no longer says binder/threads/memory/startup are P1. Replace `LICENSES/Apache-2.0.txt` with the full canonical Apache-2.0 text including section 4(a)-(d) and the APPENDIX — the Task 3 copy came from TypeScript's condensed variant and is incomplete; the full text is available at `node_modules/expect-type/LICENSE` (drop its first copyright line).

- [x] **Step 1: Write failing collect tests**

Fake CliDeps.collect that records options; `program.test.ts` asserts flags map to `{ app, durationMs: 10000, out, procfs: true, coldStart: 'EntryAbility' }`; `collect.test.ts` covers seconds parsing and invalid values. Device test with fake Hdc/collectors asserts `Promise.all` concurrency (both collectors see the same start time), `scene.json` contents, and that a hitrace failure still rejects (no silent success). `index.test.ts` adds an `analyze --json` run on `spike/out/emu_big.db` (skip if absent) with `--app pbench.baseline`: metrics include `fault.arkui.HandleOnAreaChangeEvent`, `binder.transactions.count`, `thread.patterns.count`; run twice and assert byte-identical stdout.

- [x] **Step 2: Run, see fail**

Run: `npx vitest run packages/cli/test/collect.test.ts packages/cli/test/program.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement core collection changes**

Do not let a procfs failure masquerade as a trace failure: `Promise.all` rejects with the first failure, which is correct because a partial scene must not be presented as complete. Validate before spawning any hdc call. Keep `hitrace` behavior unchanged when `procfs` is absent.

- [x] **Step 4: Implement CLI wiring**

`realDeps().collect` resolves the output directory with `resolve()`, calls `connect()`, `device.collect(...).ingest()`, closes the scene, and returns the path. `analyze` constructs `new SchedQuery(scene.traceDb)` etc.; pass `procfs` only when the file exists; pass `metadata` when `readSceneMetadata` succeeds. Preserve the existing failure contract: empty stdout, stderr message, exit 1.

- [x] **Step 5: Update docs and site**

README: P1 implemented list, metric ids, `collect` example, note that binder/threads/fault-tree are parity-tested against HapRay rev `9386e4e`, memory/startup have no HapRay equivalent. Site: change the P1 sentence and the L5/L2 layer copy to match (collectors: procfs; analyzers: fault tree, binder, threads, memory, startup); keep P1 items that are still missing (hiperf/hiprofiler/hidumper/uitest collectors, baseline comparison, skill adapter) truthful.

- [x] **Step 6: Full verification and commit**

Run: `npm test`, `npm run typecheck -w @ohos-perf/core`, `npm run typecheck -w @ohos-perf/cli`, `npm run build -w @ohos-perf/core`, `npm run build -w @ohos-perf/cli`.
Expected: all green; 291 + new tests; single `analyze --json` output parses; two runs byte-identical.
Commit code, tests, docs, site.

---

## Self-Review Notes

- Spec §5 rows covered: binder (Task 4), threads (Tasks 5–6), fault-tree (Task 3), memory procfs (Tasks 7–8), startup (Task 9), empty-frame/vsync/ui/gc/flamegraph remain future work (not P1).
- §9 degradation behavior is centralized in Task 2 and exercised per analyzer.
- §10 test strategy: parity goldens (Tasks 3, 4, 5, 6), determinism (Task 10), degradation (Tasks 2, 8, 9), capability-driven skipping (Task 2).
- Startup has no HapRay analyzer; parity is explicitly not claimed. Memory procfs has no HapRay equivalent on the emulator; tests pin parser/aggregation instead.
- Type consistency: all analyzers consume `AnalyzeContext` fields defined in Task 2; query classes are defined in Task 1 before use; `EvidenceKind` additions are listed in the task that needs them.
