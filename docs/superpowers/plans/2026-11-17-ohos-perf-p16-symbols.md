# P16 Symbol Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix frame symbol resolution so it never invents a name, add typed symbol statistics and unresolved-symbol evidence, render an offline flamegraph artifact, and pass `--so-dir` through to the device-side converter.

**Architecture:** `PerfQuery` (`src/query/perf.ts`) resolves each frame through `perf_files` exactly and through `data_dict` as the honest fallback, deleting the file-only symbol fallback that fabricates names. A `symbols` analyzer (`src/analyze/symbols.ts`) turns that into metrics and evidence; `src/report/flamegraph-svg.ts` renders folded stacks to a self-contained SVG, which `report` writes beside its other artifacts. `Streamer` gains an optional `--So_dir` argument, threaded from `collect --so-dir`.

**Tech Stack:** TypeScript ESM, `node:sqlite`, zero runtime dependencies. SVG is string-built; no d3, no CDN, no script.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p16-symbols-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`.
- Determinism (D5): identical inputs produce byte-identical artifacts. No `Date.now()`, no absolute host path inside a report document, no locale-dependent sort. Every sort is by string comparison or numeric comparison written out explicitly.
- Every refusal is a typed `OhosPerfError` with a code.
- `packages/core/src/index.ts` is the public surface: every new exported value goes into `packages/core/test/types.test.ts`'s `VALUE_EXPORTS`, and core must be rebuilt (`npm run build -w @ohos-perf/core`) before the CLI sees it.
- Unit suite: `npm run test:unit`. Typecheck: `npm run typecheck -w @ohos-perf/core` and `-w @ohos-perf/cli`.
- The device capability matrix keeps exactly 23 rows; P16 adds no capability id.
- Symbol resolution must never produce a symbol for a frame whose `symbol_id` is `-1` unless `data_dict` names it.

## Review Focus

- **A frame with `symbol_id = -1` in a file whose first `perf_files` row is a real symbol.** The shipped code reports that neighbour's name; after this phase it must report the `data_dict` text (`libfoo.so+0x1cce24`) and count as unresolved.
- **A `perf.db` with no `data_dict` table.** Resolution must fall back to the raw `name` column and the query must not throw.
- **A `perf_files` row whose `symbol` is NULL or empty.** The exact match exists but names nothing; resolution must fall through to `data_dict` rather than emit `''`.
- **A `perf.db` where `perf_callchain.name` is already a symbol string** (a hand-built fixture, or a future converter). Treating a non-numeric `name` as a `data_dict` id would blank every symbol; the lookup must miss cleanly and the raw text must survive.
- **`collect --so-dir` pointing at a path that does not exist.** It must fail before any device call, not after a 30-second capture.
- **A flamegraph with one stack, and a stack deeper than the SVG's fixed height.** Both must render; neither may produce negative coordinates or drop weight.

---

### Task 1: Correct symbol resolution

**Files:**
- Modify: `packages/core/src/query/perf.ts`
- Test: `packages/core/test/query-perf-symbols.test.ts` (create)
- Test: `packages/core/test/query-callstack-perf.test.ts` (update the two tests that pin the file fallback)

**Interfaces:**
- Consumes: `QueryHandle`, `num`/`str` from `./rows`.
- Produces:
  ```ts
  /** One resolved frame. `resolved` is false when the recorder had no symbol. */
  export interface PerfFunction {
    symbol: string;
    name: string;
    filePath: string;
  }
  export interface PerfLeafAttribution {
    symbol: string;
    filePath: string;
    samples: number;
    /** True when `symbol` is a `file+0xoffset` reference, not a name. */
    unresolved: boolean;
  }
  export interface SymbolStat {
    symbol: string;
    filePath: string;
    samples: number;
    unresolved: boolean;
  }
  export function isUnresolvedSymbol(symbol: string): boolean;
  // on PerfQuery:
  symbolStats(threadIds: readonly number[], range: TimeRange): SymbolStat[];
  unresolvedSymbols(threadIds: readonly number[], range: TimeRange): SymbolStat[];
  ```
  `isUnresolvedSymbol(s)` is true when `s` is empty or matches `/^[^ ]+\+0x[0-9a-f]+$/`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/query-perf-symbols.test.ts`. Build the database with the real DDL from `analyze-flamegraph.test.ts` (`perf_thread`, `perf_sample`, `perf_callchain`, `perf_files`) plus `data_dict(id INT, data TEXT)`. The fixture must mirror the measured capture:

```ts
// File 2 has three symbols; serial 1 is a real name and serial 0 sorts first.
// The frame at depth 0 has symbol_id -1, so the shipped file-only fallback
// would call it "dlopen". data_dict says what it really is.
d.exec(`INSERT INTO perf_files VALUES
  (0, 2, 0, 'dlopen', '/system/lib/ld-musl.so'),
  (1, 2, 1, 'dladdr', '/system/lib/ld-musl.so'),
  (2, 3, 0, 'JDImageLoad', '/lib/libjdimage.so')`);
d.exec(`INSERT INTO data_dict VALUES
  (488, 'start'),
  (9675, 'ld-musl.so+0xa2df8'),
  (9800, 'libjdimage.so+0x1cce24')`);
```

Tests, each asserting real behavior:

1. `isUnresolvedSymbol` — true for `''`, `'libfoo.so+0x1cce24'`, `'entry.hap+0x22b621e'`; false for `'dladdr'`, `'base::Thread::ThreadMain()'`, `'libfoo.so'`, `'a b+0x1'`.
2. An exact `(file_id, serial_id)` hit wins: a frame with `file_id 2, symbol_id 1, name 488` reports `dladdr`, and `unresolved` is false.
3. A `symbol_id = -1` frame never inherits its file's first symbol: with `file_id 2, symbol_id -1, name 9675`, `leafAttribution` reports `ld-musl.so+0xa2df8` and `unresolved: true` — **not** `dlopen`. This is the regression test for the measured defect.
4. A missing exact row falls through to `data_dict`: `file_id 3, symbol_id 9, name 9800` → `libjdimage.so+0x1cce24`.
5. An exact row with an empty `symbol` falls through to `data_dict`; with `data_dict` also empty the symbol is `''` and the chain contributes no leaf row (existing behavior, pinned).
6. The file path still resolves from `file_id` alone for an unresolved frame (measured: one path per `file_id`), so the unresolved row names its library.
7. No `data_dict` table: resolution falls back to the raw `name` and does not throw.
8. `name` that is already a symbol (`'start'`) is not treated as a `data_dict` id: the lookup misses and `'start'` survives as the symbol.
9. `symbolStats` — two chains, weights 5 and 7 on `dladdr`, 3 on an unresolved leaf; rows are `[{dladdr, …, 12, false}, {…, 3, true}]`, sorted by `(-samples, symbol, filePath)`.
10. `symbolStats` rows sum to `eventCount(threadIds, range)` exactly, unresolved rows included; `unresolvedSymbols` is the subset with `unresolved: true` and its weight is therefore *part of* that sum, not additional to it.
11. `symbolStats([])` and a database without the perf tables both return `[]`.

Update `packages/core/test/query-callstack-perf.test.ts`: the perf fixture there has no `data_dict` table, so every frame still resolves to its raw name and both existing expectations keep their values. Each gains the new field: `{ symbol: 'raw3', filePath: '', samples: 12, unresolved: false }` (a bare `raw3` is a name, not an offset reference) and `{ symbol: 'Other()', filePath: '/lib/libbar2.so', samples: 3, unresolved: false }`. Rename the second test from `resolves the leaf through perf_files exact and file-only matches` to `resolves the leaf through the exact perf_files row`, since the file-only symbol fallback no longer exists.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --project unit packages/core/test/query-perf-symbols.test.ts`
Expected: FAIL — `isUnresolvedSymbol` and `symbolStats` are not exported.

- [ ] **Step 3: Implement**

In `chainFunctions`, replace the file-only fallback:

```ts
// perf_callchain.name is a data_dict id, not a symbol (measured: all 484,630
// frames of a real capture resolve through data_dict). The exact
// (file_id, serial_id) row is authoritative where it exists and names
// something; otherwise data_dict is the honest answer, which for an
// unsymbolized address is "libfoo.so+0x1cce24". The previous file-only
// fallback attributed such frames to whichever symbol sorted first in their
// file, which fabricated 7.14% of a real capture's leaf weight.
```

Load `data_dict` once per call for the distinct `name` ids (a `SELECT id, data FROM data_dict WHERE id IN (…)`, guarded by a `hasTable('data_dict')` check, ordered by id for determinism). Build `symbols: Map<number, PerfFunction>` from exact rows only, keyed `${file_id}:${serial_id}`, skipping rows whose symbol is empty. Build `paths: Map<number, string>` from the same rows, first non-empty path per `file_id`. Resolution per frame:

```ts
const exact = frame.file_id != null && frame.symbol_id != null
  ? exactSymbols.get(`${num(frame.file_id)}:${num(frame.symbol_id)}`)
  : undefined;
const fromDict = dataDict.get(num(frame.name));
const symbol = exact !== undefined ? exact.symbol : fromDict ?? rawSymbol;
const filePath = frame.file_id == null ? '' : paths.get(num(frame.file_id)) ?? '';
```

`leafAttribution` sets `unresolved: isUnresolvedSymbol(leaf.symbol)` and keys rows by `(symbol, filePath, unresolved)` so a resolved and an unresolved row with the same text stay distinct.

`symbolStats` reuses `chainWeights` and `chainFunctions` exactly as `leafAttribution` does, but returns every leaf including empty-symbol ones (they become `unresolved: true`) so the rows sum to the whole window. `unresolvedSymbols` is `symbolStats(...).filter((row) => row.unresolved)` — a **subset**, so a caller must not add the two together; the identity the analyzer asserts is `symbol.samples.count + symbol.unresolved.count === eventCount(...)`, where `symbol.samples.count` is the resolved subset only.

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run --project unit packages/core/test/query-perf-symbols.test.ts packages/core/test/query-callstack-perf.test.ts packages/core/test/analyze-flamegraph.test.ts`
Expected: PASS. The flamegraph tests may need their fixture's `data_dict` added; if a test fails because the fixture lacks `data_dict`, add it — the fixture is synthetic and the new resolution is the behavior under test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/perf.ts packages/core/test/query-perf-symbols.test.ts packages/core/test/query-callstack-perf.test.ts
git commit -m "fix(core): resolve frame symbols through data_dict, never a neighbour"
```

---

### Task 2: The symbols analyzer

**Files:**
- Create: `packages/core/src/analyze/symbols.ts`
- Modify: `packages/core/src/analyze/engine.ts` (register in `defaultAnalyzers`)
- Modify: `packages/core/src/report/evidence.ts` (`EvidenceKind` gains `'symbol_stats' | 'unresolved_symbol'`)
- Modify: `packages/core/src/report/model.ts` (`SECTION_TITLES` gains `symbols: 'Symbols'`)
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)
- Test: `packages/core/test/analyze-symbols.test.ts` (create)

**Interfaces:**
- Consumes: `PerfQuery.symbolStats`, `PerfQuery.unresolvedSymbols`, `PerfQuery.eventCount`, `AnalyzeContext`, `metric`, `evidence`.
- Produces:
  ```ts
  export class SymbolsAnalyzer implements Analyzer {
    readonly id = 'symbols';
    readonly requires: CapabilityId[]; // ['perf.samples']
    run(ctx: AnalyzeContext): Promise<AnalyzeResult>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/analyze-symbols.test.ts`, reusing the fixture shape from Task 1 (copy the DDL constants; do not import across test files). Cover:

1. Metrics on a fixture with resolved and unresolved leaves: `symbol.samples.count`, `symbol.unresolved.count`, `symbol.unresolved.share` (a percentage), `symbol.files.count`, `symbol.top.symbol`, `symbol.top.samples` — all `fidelity: 'exact'`, provenance `collector: 'hiperf'`, `table: 'perf_callchain'`, windowed.
2. The identity: `symbol.samples.count + symbol.unresolved.count === eventCount(threadIds, window)`.
3. One `symbol_stats` evidence item per top-10 resolved symbol, with `signals` `{symbol, file, samples, share}` and a `drillDown` naming `symbol.stats`.
4. One `unresolved_symbol` evidence item per top-10 unresolved leaf, `signals` `{symbol, file, samples}` (the `symbol` is the `file+0xoffset` reference), explain naming `--so-dir`.
5. Degraded proxy (`symbols.degraded`) when there are no samples or no perf query, with a reason mentioning `--hiperf`.
6. Evidence ids are unique when two symbols share a name but differ in file.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/core/test/analyze-symbols.test.ts`

- [ ] **Step 3: Implement**

Follow `flamegraph.ts`'s structure exactly: the no-samples branch returns one degraded proxy metric and no evidence; otherwise resolve `threadIds` from `ctx.perf.threads(ctx.app.pids)`, call `symbolStats`, split on `unresolved`, and build metrics with `byMetricId` sorting. Evidence keys: the symbol for `symbol_stats`, `${symbol}\u0000${filePath}` for `unresolved_symbol`, so same-named items never collide. Register `new SymbolsAnalyzer()` in `defaultAnalyzers()` after `new RsSkipAnalyzer()`.

- [ ] **Step 4: Run and confirm pass**

Run: `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/analyze-symbols.test.ts && npm run test:unit`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit** — `feat(core): report symbol statistics and unresolved symbols`

---

### Task 3: The offline flamegraph artifact

**Files:**
- Create: `packages/core/src/report/flamegraph-svg.ts`
- Create: `packages/core/src/report/flamegraph-html.ts`
- Create: `packages/core/src/report/escape.ts` (moved from `html.ts`/`ui-html.ts`)
- Modify: `packages/core/src/report/html.ts`, `packages/core/src/report/ui-html.ts` (import the moved `escapeHtml`)
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/types.test.ts`
- Test: `packages/core/test/report-flamegraph.test.ts` (create)

**Interfaces:**
- Consumes: `FoldedStack` from `../query/perf`.
- Produces:
  ```ts
  export const FLAMEGRAPH_FILES: readonly ['flamegraph.svg', 'flamegraph.html'];
  export function renderFlamegraphSvg(stacks: readonly FoldedStack[]): string;
  export interface FlamegraphPageInput {
    readonly stacks: readonly FoldedStack[];
    readonly app: string;
    readonly window: TimeRange;
    readonly unresolvedShare: number | null;
    readonly symbolized: boolean | null;
  }
  export function renderFlamegraphHtml(input: FlamegraphPageInput): string;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/report-flamegraph.test.ts`. Cover:

1. Two stacks (`a;b 3`, `a;c 2`) produce three rectangles, and their widths sum to the 5-unit total at the root.
2. Every rectangle carries a `<title>` with the frame, weight and share.
3. A name containing `<`, `&` and `"` is escaped; the escaped form appears and the raw form does not.
4. No `<script`, no `http://` or `https://` reference.
5. A single stack (`only 1`) renders one rectangle with full width.
6. A 40-frame-deep stack renders 40 rectangles with non-negative `y` and increasing depth.
7. Two calls with the same stacks return byte-identical strings.
8. An empty stack list renders a valid document stating there is nothing to draw (no NaN in the output).
9. `renderFlamegraphHtml` states the unresolved share and, when `symbolized === false`, says symbolization was not requested; when `null`, it says the capture's symbol state is unknown rather than claiming either.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/core/test/report-flamegraph.test.ts`

- [ ] **Step 3: Implement**

`renderFlamegraphSvg` lays stacks out as a classic flame graph: walk each stack root-to-leaf, keep a `Map<string, number>` of `path -> weight`, and for each distinct frame path emit `<rect x="…" y="…" width="…" height="…">` with `y = FRAME_HEIGHT * depth` and `x`/`width` derived from the cumulative weight of preceding sibling paths at that depth. Sort sibling paths by `(-weight, path)` so layout is deterministic. Use `FRAME_HEIGHT = 18`, a palette of six colours selected by `depth % 6` (a fixed array, so the colour never depends on the name), and `fill` values from that array only. Widths are computed in units and scaled by `WIDTH / total`. Truncate the label to 60 characters with a trailing `…`, and put the full name in `<title>`.

`escapeHtml` already exists twice, privately, in `src/report/html.ts:12` and `src/report/ui-html.ts:8` — this task would make three. Move it to a new `src/report/escape.ts` exporting `escapeHtml`, import it from both existing files, and export it from `src/index.ts` (adding it to `VALUE_EXPORTS`). One implementation, three callers, and the two existing renderers keep their byte-identical output because the function body does not change.

Include `xmlns="http://www.w3.org/2000/svg"` — that is a namespace declaration, not a network fetch, so the no-external-reference test asserts on `<script` and `href=` instead of on `http`.

`renderFlamegraphHtml` embeds the SVG inline and adds a header card with the app, window, stack count, total weight and the symbol-source sentence from the tests.

- [ ] **Step 4: Run and confirm pass** — `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/report-flamegraph.test.ts`

- [ ] **Step 5: Commit** — `feat(core): render folded stacks to an offline flamegraph`

---

### Task 4: Write the artifact from `report`

**Files:**
- Modify: `packages/cli/src/deps.ts`
- Modify: `packages/cli/src/commands.ts` (if the manifest type needs no change, leave it)
- Test: `packages/cli/test/report-deps.test.ts` (update), `packages/cli/test/flamegraph-report.test.ts` (create)

**Interfaces:**
- Consumes: `renderFlamegraphSvg`, `renderFlamegraphHtml`, `FLAMEGRAPH_FILES`, `PerfQuery.foldedStacks`, `SymbolsAnalyzer`'s metrics.
- Produces: `report` writes `flamegraph.svg` and `flamegraph.html` when the scene has samples, and lists them in its manifest.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/flamegraph-report.test.ts`: build a scene directory with `scene/trace.db` (the `frame_slice`/`process` fixture `report-deps.test.ts` uses, so the analyzer run succeeds) plus `scene/perf.db` carrying the perf tables and `data_dict`. No `scene.json` is needed — `openOfflineScene` treats an absent descriptor as a legacy hand-built scene. Assert:

1. `realDeps().report({ sceneDir, outDir })` writes `flamegraph.svg` and `flamegraph.html` and the returned `files` contains both, after the six existing artifacts.
2. The SVG contains the fixture's leaf symbol and no `<script`.
3. A scene with a `perf.db` but no `perf_sample` rows writes neither file and does not fail.
4. Two runs produce byte-identical SVGs.

Update `report-deps.test.ts`: its `FILES` constant stays the six artifacts for the sample-less fixture it uses, which is exactly the "no samples → no flamegraph" case, so it doubles as the regression test for assertion 3. Add the two names to any test that does expect a flamegraph.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/cli/test/flamegraph-report.test.ts`

- [ ] **Step 3: Implement**

In `deps.ts`'s `report`, after the existing artifacts: open the scene's perf database, call `new PerfQuery(perfDb).foldedStacks(threadIds, window)` with the app's thread ids (the same derivation `analyzeContext` uses), and when the result is non-empty push both files. The unresolved share comes from the model's `symbols` section metrics (look up `symbol.unresolved.share`), and `symbolized` comes from `scene.json`'s `capture.hiperf.symbolized` when present.

- [ ] **Step 4: Run and confirm pass** — `npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli && npx vitest run --project unit packages/cli/test/flamegraph-report.test.ts && npm run test:unit`

- [ ] **Step 5: Commit** — `feat(cli): write an offline flamegraph with the report`

---

### Task 5: `--so-dir` through collect

**Files:**
- Modify: `packages/core/src/ingest/streamer.ts`
- Modify: `packages/core/src/ingest/metadata.ts`
- Modify: `packages/core/src/device/device.ts`
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/program.ts`, `packages/cli/src/deps.ts`
- Test: `packages/core/test/streamer.test.ts` (update), `packages/core/test/device-so-dir.test.ts` (create), `packages/cli/test/collect-so-dir.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export function buildConvertArgv(inputPath: string, outputDbPath: string, soDir?: string): string[];
  // Streamer: convert(inputPath, outputDbPath, soDir?)
  export interface SceneMetadata { /* capture.hiperf gains: */ symbolized?: boolean }
  // TraceCollectOptions gains: soDir?: string
  ```

- [ ] **Step 1: Write the failing tests**

`streamer.test.ts`: `buildConvertArgv('a.htrace','b.db','/so')` equals `['a.htrace','-e','b.db','--So_dir','/so']`; omitting `soDir` keeps the existing two-argument shape byte-identical.

`device-so-dir.test.ts`: a fake `Streamer` records every `convert` call. `collect({ hiperf: {}, soDir: '/so' })` calls `convert` for the perf file with `/so`; `collect({ hiperf: {} })` passes `undefined`; `collect({ soDir: '/so' })` without `hiperf` throws `COLLECT_SO_DIR_WITHOUT_HIPERF` before any collector runs; `collect({ hiperf: {}, soDir: '/does/not/exist' })` throws `COLLECT_BAD_SO_DIR` before any device call. Assert on the recorded calls and on the error codes.

`collect-so-dir.test.ts`: the CLI forwards `--so-dir`; the human output mentions it; `--so-dir` without `--hiperf` exits 1 naming the flag.

- [ ] **Step 2: Run and confirm failure** — the three commands from Step 1.

- [ ] **Step 3: Implement**

`buildConvertArgv` appends `['--So_dir', soDir]` when `soDir` is defined. `Streamer.convert` threads it to `spawnSpec`. `Device.collect` validates before the capability gate: a `soDir` without `hiperf` is `COLLECT_SO_DIR_WITHOUT_HIPERF`; a `soDir` that is not an existing directory is `COLLECT_BAD_SO_DIR` (use `statSync`). Pass it to the perf `convert` call and write `symbolized: true` into `capture.hiperf` when set. `metadata.ts`: add `symbolized?: boolean` to the `capture.hiperf` type, accept it in `isCapture` with a boolean clause, and copy it in the parsed-metadata construction. CLI: `collect --so-dir <dir>`, forwarded into the collect request.

- [ ] **Step 4: Run and confirm pass** — `npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli && npm run test:unit`

- [ ] **Step 5: Commit** — `feat(core): pass --so-dir to the device symbolizer`

---

### Task 6: The `symbol.stats` query and documentation

**Files:**
- Modify: `packages/core/src/query/registry.ts`
- Modify: `packages/core/src/index.ts` (if new types are exported)
- Modify: `packages/core/test/types.test.ts`
- Test: `packages/core/test/query-symbol-stats.test.ts` (create), `packages/core/test/drilldown.test.ts` (update if it pins the tool list)
- Modify: `README.md`, `site/index.html`, `skill/ohos-perf/SKILL.md`, `CHANGELOG.md`
- Modify: `package.json`, `packages/core/package.json`, `packages/cli/package.json`, `package-lock.json` (0.11.0)

**Interfaces:**
- Consumes: `PerfQuery.symbolStats`.
- Produces: a named query `symbol.stats` with args `startNs`, `endNs`; rows `{symbol, filePath, samples, share, unresolved}`.

- [ ] **Step 1: Write the failing tests**

`query-symbol-stats.test.ts`: the query is listed by `queryDefinitions()`; unknown arguments are `QUERY_BAD_ARGS`; rows are ordered by `(-samples, symbol, filePath)`; `share` is a percentage of the window's app-thread weight; rows agree with `frame.load.symbols` on the same fixture; an empty app returns `[]`.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/core/test/query-symbol-stats.test.ts`

- [ ] **Step 3: Implement**

Register the definition beside `frame.load.symbols`, using `requiredRange` and `perfThreadIds` exactly as that one does, and `shareOf` for the percentage. Then update the docs: README (status line and test count, the roadmap row for P16 as shipped in `0.11.0`, a `## Symbols` section stating the resolution rule and the measured defect it fixes, the metric table rows, the quickstart with `--so-dir` and the flamegraph artifact, the parity tally, the Chinese section), site (hero, stat card, a `Shipped · v0.11.0` card, roadmap narrative, quickstart), SKILL.md (a `## Symbols` section with the resolution order, the unresolved definition and the new query), CHANGELOG (a `## 0.11.0` entry naming the defect with its measured numbers), and the three manifests plus the lockfile at `0.11.0`.

- [ ] **Step 4: Run and confirm pass**

Run: `npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli && npm run test:unit && npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: whole suite green, both typechecks clean.

- [ ] **Step 5: Commit** — `docs: document symbol intelligence and release 0.11.0`
