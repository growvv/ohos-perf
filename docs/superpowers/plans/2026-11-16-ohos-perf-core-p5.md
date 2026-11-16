# ohos-perf P5 Rich Memory and Device-Wide Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two remaining honest gaps against the capability matrix — `js.heap` claims a `memory-plugin` it cannot drive, and every `collect` requires an app even though `hidumper`/`uitest` read the whole screen — and add the `memory-plugin` collector whose `process_measure` table carries exact per-process memory.

**Architecture:** A fourth hiprofiler plugin template (`memory`) joins the existing four. It is driven through the same `buildHiprofilerConfig` path, so no new transport or ingest code appears; the converted database carries `process_measure` rows, which a new `MemMeasureQuery` reads and a `MemoryMeasureAnalyzer` turns into `mem.*` metrics with `fidelity: 'exact'`. Separately, `CollectOptions.app` becomes optional, with the capability gate deciding which collectors a request can actually satisfy.

**Tech Stack:** TypeScript (ESM), Vitest, `node:sqlite`, commander, npm workspaces. No new runtime dependencies.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` §7 (the `mem.*` and `js.heap` rows), §3.3 (collector layout), §11 P5.

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- Determinism contract (D5): identical inputs produce byte-identical JSON; every output array has an explicit, documented order.
- CLI contract: human-readable by default; `--json` equals the API structure; any failure produces **empty stdout, one stderr line, exit 1**.
- Collectors perform no analysis: they validate, capture, and `recv`. Parsing and metric derivation live in pure functions the analyzer calls.
- Every collector removes its fixed device path before recording and requires the tool's own success marker; `hdc` exit 0 is never evidence of success.
- The public value surface of core is pinned by `packages/core/test/types.test.ts`; every new value export must be added to `VALUE_EXPORTS`, and every declared type must be exported.
- **A capability is reported available only when the package can actually drive it.** This is the rule P5 exists to restore: `js.heap` currently reports available on a device where nothing consumes `memory-plugin`, which is a claim the package cannot honour.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Measured device facts (HUAWEI Mate 60, BRA-AL00, HarmonyOS 7.0.0.111)

These were verified on the attached device while writing this plan; the tasks depend on them verbatim.

| Fact | Evidence |
| --- | --- |
| `hiprofiler_cmd --list` reports 15 plugins | `cpu-plugin`, `gpu-plugin`, `diskio-plugin`, `ftrace-plugin`, `hidump-plugin`, `hilog-plugin`, `hiperf-plugin`, `hisysevent-plugin`, `memory-plugin`, `network-plugin`, `process-plugin`, `xpower-plugin`, `ffrt-profiler`, `network-profiler`, `nativehook` |
| `memory-plugin` needs `statistics_interval`, `report_process_tree`, `report_sysmem` to produce per-process rows | with an empty `config_data` the capture yields only `stat` (485 rows); with those three fields it yields `process_measure` (13068 rows) |
| `process_measure` schema | `type, ts, dur, value, filter_id`; values are joined through `process_measure_filter` (`id, name, ipid`) |
| `process_measure_filter` names | `mem.vm.size`, `mem.rss`, `mem.rss.anon`, `mem.rss.file`, and further `mem.*` keys |
| `process_measure` timestamps are **microseconds** | `ts: 817469134282415` for a ~3 s capture is µs-since-boot, not ns; a naive ns comparison puts every row outside the trace window |
| `paged_memory_sample`, `smaps`, `sys_mem_measure` stay empty with this config | 0 rows each — do not claim them |
| `uitest uiRecord record` needs AAMS | plain shell answers `Can not connect to AAMS, RET_ERR_CONNECTION_EXIST`; `ui.gesture` therefore stays unimplemented |
| HapRay has no `memory-plugin` config either | its `HIPROFILER_CMD_TEMPLATE` carries a `{memory_config}` placeholder that is never filled |
| `hdc file recv -cwd / <rel-device> <abs-local>` needs the local path relative to the server cwd | passing a Windows absolute path produced `path:D:/Application/Git/E:/…`; the project's `Hdc.recv` already handles this |

### Execution corrections (2026-11-16, during Tasks 3, 5 and 6)

Three facts above were re-verified on the same device during execution and did
not hold. The implementation and its tests follow the corrections below; the
rows above are left as written so this plan records what was believed when it
was written.

| Plan said | Measured during execution | Consequence |
| --- | --- | --- |
| `process_measure` timestamps are microseconds (table row above, Review Focus 2) | They are **nanoseconds** on the trace clock: `trace_range.start_ts` equals `MIN(process_measure.ts)` exactly (`818480085343198`), and a 3 s capture spans `1.996e9` | No ×1000 conversion; `MemMeasureQuery` copies `ts`/`dur` unchanged, and `collect-memory.device.test.ts` pins every row inside `trace_range` |
| `mem.*` filter values are bytes | They are **KiB**: `mem.rss` 664420 against live `VmRSS: 664584 kB`, and `mem.vm.size` 106161468 against `VmSize: 106161468 kB` exactly | `MemoryMeasureAnalyzer` multiplies by 1024 once and reports `mem.measure.rss.*` in bytes, pinned by `analyze-mem-measure.test.ts` |
| `process_measure_filter.ipid` is a pid | It is the trace's internal **ipid**: sceneboard has `pid=6500` but `ipid=117` | `MemMeasureQuery.forIpids` plus translation through `ProcessQuery.byPid`; comparing pids directly would read another process's rows |

## Out of scope

- **`js.heap` analysis.** The tables exist (`js_heap_info`, `js_heap_nodes`, …) but are populated only by an ArkTS-side `memory-plugin` mode that HapRay itself does not configure. P5 makes the capability **honest** (report unavailable with a reason) rather than implementing a heap walker.
- **`ui.gesture`.** `uitest uiRecord` requires the AAMS test framework, which is not available over plain shell. The capability stays reported unavailable with that reason.
- **`coverage`.** No known plugin; it already reports the binary-only verdict.
- **`ohos-perf emulator {list,start,stop,create}`.** Emulator lifecycle management is a separate surface with its own acceptance criteria; it does not belong in a collection plan.

## Review Focus

1. **A capability must not claim what the package cannot drive.** `js.heap` is the existing violation; the fix must make the matrix say "no plugin the collector drives" rather than quietly dropping the row. A dropped row is `capability not probed`, which reads as "we did not ask", not "this is unavailable". Owned by Task 1.
2. **`process_measure` timestamps are microseconds.** Treating them as nanoseconds puts every row outside the window and yields an empty result that looks like an idle app. The conversion must be explicit and tested at the boundary. Owned by Task 3.
3. **An app-less capture must not fabricate app metrics.** With `--hidumper` alone there is no pid; app-scoped analyzers must degrade with a reason rather than attribute device-wide render counters to an empty app. Owned by Task 5.
4. **A memory-plugin capture with an empty `config_data` succeeds and produces nothing.** `stat` rows appear, `process_measure` does not. The collector must record what it got so a zero reads as a measurement, never as a quiet app. Owned by Task 2.
5. **The capability gate is the only validator for optional collectors.** Once `app` is optional, a request for `--hiperf` with no app must fail before the first device call, not inside the collector after hitrace began. Owned by Task 4.

---

### Task 1: Make `js.heap` honest

**Files:**
- Modify: `packages/core/src/device/capability.ts` (the `js.heap` rule)
- Test: `packages/core/test/capability.test.ts`

**Interfaces:**
- Consumes: the existing `Rule` shape (`id`, `collector`, `plugin?`, `binary?`, `unavailableReason?`).
- Produces: `js.heap` reports `available: false` with a reason naming the missing driver, on every device — including one whose `hiprofiler_cmd --list` contains `memory-plugin`.

- [x] **Step 1: Write the failing test**

In `packages/core/test/capability.test.ts`, using the existing `inputs(...)` helper with a plugin list that includes `memory-plugin`:

```ts
it('reports js.heap unavailable even when the daemon lists memory-plugin', async () => {
  // The plugin exists on the device but nothing in this package consumes its
  // js_heap_* tables, so "available" would be a claim the package cannot
  // honour. The reason must name what is missing, not just say "no".
  const caps = await matrix({ hiprofilerPlugins: ['memory-plugin'] });
  expect(caps.get('js.heap')).toMatchObject({
    available: false,
    reason: expect.stringContaining('no analyzer'),
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/core/test/capability.test.ts -t "js.heap unavailable"`
Expected: FAIL — `available` is `true` because `memory-plugin` is in the list.

- [x] **Step 3: Drop the plugin claim and state the reason**

In `capability.ts`, replace `hiprofiler('js.heap', 'memory-plugin')` with a rule that has no `plugin` and an explicit `unavailableReason` — the package drives no heap analyzer, so the plugin's presence says nothing. Keep the id in the type and the matrix; a dropped row would read as "not probed".

- [x] **Step 4: Run it and the whole capability suite**

Run: `npx vitest run packages/core/test/capability.test.ts`
Expected: PASS, including the existing plugin-list assertions for the other four.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/device/capability.ts packages/core/test/capability.test.ts
git commit -m "fix(core): report js.heap unavailable until an analyzer consumes it"
```

---

### Task 2: The `memory` hiprofiler plugin template

**Files:**
- Modify: `packages/core/src/collectors/hiprofiler/templates.ts` (add `memoryPlugin`)
- Modify: `packages/core/src/device/device.ts` (`HIPROFILER_PLUGIN_NAMES`, the plugin loop)
- Test: `packages/core/test/collector-hiprofiler-templates.test.ts`, `packages/core/test/device.test.ts`

**Interfaces:**
- Consumes: `HiprofilerPlugin` from `config.ts`.
- Produces:
  - `export function memoryPlugin(opts: { statisticsIntervalMs?: number }): HiprofilerPlugin` — `pluginName: 'memory-plugin'`, `configData` carrying `statistics_interval`, `report_process_tree: true`, `report_sysmem: true`.
  - `HIPROFILER_PLUGIN_NAMES` gains `'memory'`, so `collect({ hiprofiler: { plugins: ['memory'] } })` is accepted.

- [x] **Step 1: Write the failing template test**

```ts
it('configures memory-plugin so it emits per-process rows', () => {
  // Measured: an empty config_data yields only `stat`; these three fields are
  // what makes `process_measure` appear.
  const plugin = memoryPlugin({ statisticsIntervalMs: 500 });
  expect(plugin.pluginName).toBe('memory-plugin');
  expect(plugin.configData).toContain('statistics_interval: 500');
  expect(plugin.configData).toContain('report_process_tree: true');
  expect(plugin.configData).toContain('report_sysmem: true');
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/core/test/collector-hiprofiler-templates.test.ts -t "memory-plugin"`
Expected: FAIL — `memoryPlugin` is not exported.

- [x] **Step 3: Implement `memoryPlugin` and register the name**

Follow `xpowerPlugin` for shape. Validate `statisticsIntervalMs` is a positive safe integer, throwing `HIPROFILER_BAD_SAMPLE_INTERVAL` (the existing code) so a bad value fails before the device is touched. In `device.ts`, add `'memory'` to `HIPROFILER_PLUGIN_NAMES` and to the plugin dispatch loop.

- [x] **Step 4: Run the template and device tests**

Run: `npx vitest run packages/core/test/collector-hiprofiler-templates.test.ts packages/core/test/device.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/collectors/hiprofiler/templates.ts packages/core/src/device/device.ts packages/core/test/collector-hiprofiler-templates.test.ts packages/core/test/device.test.ts
git commit -m "feat(core): add the memory hiprofiler plugin"
```

---

### Task 3: `MemMeasureQuery` and the microseconds boundary

**Files:**
- Create: `packages/core/src/query/mem-measure.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/query-mem-measure.test.ts`

**Interfaces:**
- Consumes: a `QueryHandle` whose database may or may not carry `process_measure`.
- Produces:
  - `export interface ProcessMeasure { tsNs: number; durNs: number; filterId: number; name: string; ipid: number; value: number }`
  - `export class MemMeasureQuery { hasTable(): boolean; all(range?: TimeRange): ProcessMeasure[]; forPids(pids: number[], range?: TimeRange): ProcessMeasure[]; filters(): Array<{ id: number; name: string; ipid: number }> }`
  - Rows are ordered by `ts, filter_id`; `tsNs`/`durNs` are the stored microseconds multiplied by 1000, so every consumer works in one clock base.

- [x] **Step 1: Write the failing tests**

```ts
it('converts microsecond timestamps to nanoseconds', () => {
  // process_measure stores µs-since-boot; a consumer comparing against trace
  // `ts` (ns) would put every row outside the window without this.
  const q = new MemMeasureQuery(dbWith({ ts: 817469134282415, dur: 505478125 }));
  const [row] = q.all();
  expect(row.tsNs).toBe(817469134282415 * 1000);
  expect(row.durNs).toBe(505478125 * 1000);
});

it('joins the filter name so a row is readable without a second query', () => {
  const [row] = new MemMeasureQuery(dbWith({ filterId: 1 })).all();
  expect(row.name).toBe('mem.rss');
});

it('returns [] when the scene has no process_measure table', () => {
  expect(new MemMeasureQuery(emptyDb()).all()).toEqual([]);
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/test/query-mem-measure.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the query**

One `SELECT` joining `process_measure` to `process_measure_filter` on `filter_id = filter.id`, with `hasTable` guarding the whole thing. Map in one row→interface function; multiply µs by 1000 in exactly one place, with a comment naming the unit.

- [x] **Step 4: Export and run**

Add the class and interface to `index.ts` and to `VALUE_EXPORTS` if the type test requires it.
Run: `npx vitest run packages/core/test/query-mem-measure.test.ts packages/core/test/types.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/query/mem-measure.ts packages/core/src/index.ts packages/core/test/query-mem-measure.test.ts
git commit -m "feat(core): read process_measure with a microsecond boundary"
```

---

### Task 4: Optional `app` in `collect`

**Files:**
- Modify: `packages/core/src/device/device.ts` (`CollectOptions.app`, validation, gate)
- Modify: `packages/cli/src/program.ts` (`--app` no longer `requiredOption`)
- Modify: `packages/cli/src/commands.ts` (`CollectRequest.app`)
- Test: `packages/core/test/device.test.ts`, `packages/cli/test/program.test.ts`

**Interfaces:**
- Consumes: the existing capability gate.
- Produces: `CollectOptions.app?: string`. `hidumper` and `uitest` work with no app; `hiperf`, `procfs`, `coldStart` and `hiprofiler`'s `nativehook` still require one and fail with `COLLECT_APP_REQUIRED` before the first device call.

- [x] **Step 1: Write the failing tests**

```ts
it('captures hidumper and uitest with no app at all', async () => {
  const h = extraCollectors();
  const scene = await h.device().collect({
    durationMs: 1000, sceneRoot: root, hidumper: true, uitest: true,
  }).then((s) => s.ingest());
  scene.close();
  expect(h.started.sort()).toEqual(['hidumper', 'hitrace', 'uitest']);
});

it('rejects hiperf with no app before any device call', async () => {
  const h = extraCollectors();
  await expect(h.device().collect({ durationMs: 1000, sceneRoot: root, hiperf: {} }))
    .rejects.toMatchObject({ code: 'COLLECT_APP_REQUIRED' });
  expect(h.started).toEqual([]);
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/test/device.test.ts -t "no app"`
Expected: FAIL — `app` is required by the type, and the existing validation rejects the first case.

- [x] **Step 3: Make `app` optional and move the requirement to the collectors that need it**

In `device.ts`, change `app?: string` on `CollectOptions` (it inherits from `TraceCollectOptions`, so check that too) and guard the `BARE_NAME`/`pidof` paths on `app !== undefined`. Keep the `COLLECT_APP_REQUIRED` check for `hiperf`, `procfs`, `coldStart` and `nativehook`. In `program.ts`, change `requiredOption('--app')` to `option('--app')` and let the action's error path report a missing app for the modes that need one.

- [x] **Step 4: Run both suites**

Run: `npx vitest run packages/core/test/device.test.ts packages/cli/test/program.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/device/device.ts packages/cli/src/program.ts packages/cli/src/commands.ts packages/core/test/device.test.ts packages/cli/test/program.test.ts
git commit -m "feat: allow an app-less capture for the device-wide collectors"
```

---

### Task 5: The memory-measure analyzer

**Files:**
- Create: `packages/core/src/analyze/mem-measure.ts`
- Modify: `packages/core/src/analyze/types.ts` (`AnalyzeContext.memMeasure?`)
- Modify: `packages/core/src/analyze/engine.ts` (`defaultAnalyzers`)
- Modify: `packages/cli/src/deps.ts` (context wiring)
- Test: `packages/core/test/analyze-mem-measure.test.ts`

**Interfaces:**
- Consumes: `MemMeasureQuery`, `AnalyzeContext`.
- Produces: `export class MemoryMeasureAnalyzer implements Analyzer` with `id: 'mem-measure'`, `requires: ['mem.native_hook']`, emitting:
  - `mem.rss.peak` (`unit: 'bytes'`, `fidelity: 'exact'`, provenance `{ collector: 'hiprofiler', rows, device }`)
  - `mem.rss.avg` (same shape)
  - `mem.measure.degraded` (`fidelity: 'proxy'`, `degraded.reason`) when no `process_measure` rows exist for the app.

- [x] **Step 1: Write the failing tests**

```ts
it('derives peak and average rss from process_measure rows', async () => {
  const result = await new MemoryMeasureAnalyzer().run(ctxWith([rss(1_000), rss(3_000)]));
  expect(metricOf(result, 'mem.rss.peak').value).toBe(3_000);
  expect(metricOf(result, 'mem.rss.avg').value).toBe(2_000);
  expect(metricOf(result, 'mem.rss.peak').fidelity).toBe('exact');
});

it('degrades rather than reporting a zero when the capture has no rows', async () => {
  const result = await new MemoryMeasureAnalyzer().run(ctxWith([]));
  expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
  expect(result.metrics[0].degraded?.reason).toContain('process_measure');
});

it('never attributes a device-wide row to the app when no pid is known', async () => {
  const result = await new MemoryMeasureAnalyzer().run(ctxWith([rss(5_000)], { pids: [] }));
  expect(result.metrics.map((m) => m.id)).toEqual(['mem.measure.degraded']);
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/core/test/analyze-mem-measure.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement the analyzer**

Filter to the app's pids, then to `name === 'mem.rss'`; peak is `max`, average is the integer mean (`Math.round`). Sort metrics by `id` and evidence by the D5 order, as every other analyzer does. The degraded path is the documented answer to "the capture produced nothing", never a zero.

- [x] **Step 4: Wire it in and run the whole suite**

Add `new MemoryMeasureAnalyzer()` to `defaultAnalyzers()`, add `memMeasure` to `AnalyzeContext`, and populate it in `deps.ts` from `new MemMeasureQuery(db)` (the memory tables live in the **trace** database, since `memory-plugin` writes an `.htrace` that converts to `trace.db`).
Run: `npm test`
Expected: PASS with a new total.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/analyze packages/cli/src/deps.ts packages/core/test/analyze-mem-measure.test.ts
git commit -m "feat: analyze process_measure into exact rss metrics"
```

---

### Task 6: Real-device acceptance for memory collection

**Files:**
- Create: `packages/core/test/collect-memory.device.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a skipped-unless-a-device-is-attached test that captures 3 s with `hiprofiler: { plugins: ['memory'] }`, converts, and asserts `process_measure` is non-empty with at least one `mem.rss` filter row.

- [x] **Step 1: Write the test**

Follow `collect-hiprofiler.device.test.ts`: reuse its `attachedHdc()` skip guard, capture with `plugins: ['memory']`, then query the converted `trace.db` for `SELECT COUNT(*) FROM process_measure` and for a `mem.rss` filter join.

- [x] **Step 2: Run it on the attached device**

Run: `npm run test:device`
Expected: PASS. Paste the row counts into the task report — they are the evidence that the template's three fields are the difference between `stat`-only and `process_measure`.

- [x] **Step 3: Commit**

```bash
git add packages/core/test/collect-memory.device.test.ts
git commit -m "test: accept memory collection on a real device"
```

---

### Task 7: CLI, skill and docs

**Files:**
- Modify: `packages/cli/src/program.ts` (help text for `--hiprofiler --plugins memory`; `--app` optional)
- Modify: `skill/ohos-perf/SKILL.md`
- Modify: `README.md`, `site/index.html`
- Test: `packages/cli/test/skill.test.ts`, `packages/cli/test/program.test.ts`

**Interfaces:**
- Consumes: the finished surface.
- Produces: documented behaviour for `--plugins memory`, app-less capture, and the honest `js.heap` verdict; test counts updated to the measured suite total.

- [x] **Step 1: Update the docs and the help text**

`README.md` drops `js.heap` from "Not implemented yet" only if Task 1 changed it to "unavailable with a reason" — it stays listed, but as an honest capability rather than a gap. Add `memory` to the plugin list, and note that `hidumper`/`uitest` need no app.

- [x] **Step 2: Update the test counts**

Run `npm test`, take the totals from the output, and replace every stale count in README and site. The clean-checkout split must be re-measured, not guessed: move `spike/out` aside, run `npm run test:unit` and `npm run test:device`, record both, restore.

- [x] **Step 3: Run the doc-reading tests**

Run: `npx vitest run packages/cli/test/skill.test.ts packages/cli/test/program.test.ts`
Expected: PASS.

- [x] **Step 4: Run the package typecheck scripts — not a hand-written tsc**

Run: `npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: both exit 0. These use `tsconfig.test.json` and therefore cover the test files; a hand-run `tsc -p tsconfig.json` does not, and that mistake shipped a red CI once.

- [x] **Step 5: Commit**

```bash
git add README.md site/index.html skill/ohos-perf/SKILL.md packages/cli/src/program.ts
git commit -m "docs: document memory collection and the honest js.heap verdict"
```

---

## Execution notes

- `memory-plugin` writes an `.htrace` that converts into `trace.db` (not a second database), so the analyzer reads `ctx.db` directly.
- `process_measure` rows exist for **every** process, not just the app's; `forPids` is what narrows them, and an empty pid list must degrade rather than report the whole device as the app.
- The device currently has one debuggable app (`com.example.image`); the app-less tests need no app at all, which is the point of Task 4.
- `js.heap` and `ui.gesture` stay unimplemented after P5. The difference is that they will say **why**, which is what the capability matrix exists for.
