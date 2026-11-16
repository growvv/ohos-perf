# P9 Report Artifact Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every analysis producible as a typed, deterministic artifact bundle — report JSON, summary, script-free offline HTML, CSV and a dependency-free XLSX — exposed as `ohos-perf report`.

**Architecture:** The engine gains a section-aware result so the report knows which analyzer produced which metric. A pure core module builds a versioned `ReportModel` from typed inputs and renders every artifact as a string or byte array; the CLI deps layer is the only place that touches the filesystem. No new runtime dependencies.

**Tech Stack:** TypeScript (ESM), Node built-ins only (`node:zlib` is not needed — the XLSX ZIP uses stored entries), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p9-report-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`; the CLI keeps its existing dependency set.
- Determinism (D5): identical inputs and package version produce byte-identical files on every platform. No `Date.now()`, no absolute paths, no locale-dependent sorting, `\n` line endings.
- The report is built from the same single `AnalyzeResult` that `analyze` emits; it must not run analyzers twice.
- Capability honesty: degraded sections are labeled and explained, never omitted or rendered as measured zeros.
- Every new/changed behavior is test-first (RED → GREEN), and the full suite (`npm test`) plus both package typechecks run green before the release task.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

- A metric or evidence string containing HTML (`<script>`, quotes, `&`) must render escaped in HTML and correctly quoted in CSV; a naive concatenation must not be able to inject markup or break a row.
- A report rendered twice from the same scene must be byte-identical, including the XLSX ZIP bytes (fixed timestamps, fixed entry order).
- A degraded analyzer must appear in the degraded banner, the section badge, the summary, and the CLI counts — not just as a zero metric.
- `--baseline` pointing at an unreadable or malformed input must fail with exit 1 and empty stdout, never produce a partial bundle.
- An empty analysis (zero metrics, zero evidence) must still produce a valid bundle with a valid HTML page and workbook, not crash or omit files.

---

### Task 1: Section-aware engine run

**Files:**
- Modify: `packages/core/src/analyze/engine.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/analyze-engine.test.ts`

**Interfaces:**
- Consumes: existing `runAnalyzers(analyzers, ctx)` behavior and its tests.
- Produces:
  ```ts
  export interface AnalyzerSection {
    readonly analyzerId: string;
    readonly status: 'measured' | 'degraded';
    readonly result: AnalyzeResult;
  }
  export interface AnalyzerRun {
    readonly result: AnalyzeResult;
    readonly sections: AnalyzerSection[];
  }
  export async function runAnalyzerSections(
    analyzers: readonly Analyzer[], ctx: AnalyzeContext,
  ): Promise<AnalyzerRun>;
  ```
  `runAnalyzers()` becomes a thin wrapper returning `.result`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/analyze-engine.test.ts` (reuse the file's existing fake-analyzer and context helpers):

```ts
it('reports one section per analyzer, marking a skipped analyzer degraded', async () => {
  const run = await runAnalyzerSections([new OkAnalyzer(), new NeedsMissingCap()], ctx);
  expect(run.sections.map((s) => [s.analyzerId, s.status])).toEqual([
    ['needs-missing', 'degraded'],
    ['ok', 'measured'],
  ]);
  const degradedSection = run.sections[0];
  expect(degradedSection.result.metrics.map((m) => m.id)).toEqual(['needs-missing.degraded']);
  expect(degradedSection.result.evidence.map((e) => e.kind)).toEqual(['degraded_capability']);
  expect(run.result).toEqual(await runAnalyzers([new OkAnalyzer(), new NeedsMissingCap()], ctx));
});
```

If the file's existing analyzer fakes have different names, adapt the names only; the assertions stay.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/core/test/analyze-engine.test.ts`
Expected: FAIL — `runAnalyzerSections` is not exported.

- [ ] **Step 3: Implement**

In `engine.ts`, add the interfaces, move the loop body into `runAnalyzerSections` (pushing an `AnalyzerSection` per analyzer in addition to merging `result` arrays), and make `runAnalyzers` delegate. Sections are ordered by analyzer id because the loop already sorts. Validation (duplicate ids, sorting) stays exactly as it is. Export the new names from `packages/core/src/index.ts` next to `runAnalyzers`.

- [ ] **Step 4: Run the test and then the whole core suite**

Run: `npx vitest run --project unit packages/core/test/analyze-engine.test.ts`
Expected: PASS.
Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/engine.ts packages/core/src/index.ts packages/core/test/analyze-engine.test.ts
git commit -m "feat(core): return per-analyzer sections from the engine"
```

---

### Task 2: Report model and summary

**Files:**
- Create: `packages/core/src/report/model.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/report-model.test.ts`

**Interfaces:**
- Consumes: `AnalyzerSection` from Task 1; existing `Metric`, `Evidence`, `BaselineComparison`, `AppIdentity`, `TimeRange`.
- Produces:
  ```ts
  export const REPORT_SCHEMA_VERSION = 1;
  export interface ReportGenerator { name: string; version: string }
  export interface ReportScenario {
    app: { packageName: string; processNames: string[] };
    device: string; window: TimeRange; startedAtNs?: number;
  }
  export interface ReportSection {
    id: string; title: string; status: 'measured' | 'degraded';
    degradedReason?: string; metrics: Metric[]; evidence: Evidence[];
  }
  export interface ReportTotals {
    metrics: number; evidence: number;
    bySeverity: { info: number; warn: number; critical: number };
    measured: number; degraded: number;
  }
  export interface ReportModel {
    schemaVersion: 1; generator: ReportGenerator; scenario: ReportScenario;
    sections: ReportSection[]; totals: ReportTotals;
    comparison?: BaselineComparison;
  }
  export interface ReportInput {
    generator: ReportGenerator; app: AppIdentity; device: string;
    window: TimeRange; startedAtNs?: number;
    sections: readonly AnalyzerSection[];
    comparison?: BaselineComparison;
  }
  export interface ReportSummary {
    schemaVersion: 1; app: string; device: string; window: TimeRange;
    sections: Array<{ id: string; title: string; status: 'measured' | 'degraded';
      degradedReason?: string; metrics: number; evidence: number }>;
    totals: ReportTotals;
    comparison?: Record<DeltaStatus, number>;
  }
  export const SECTION_TITLES: Readonly<Record<string, string>>;
  export function buildReport(input: ReportInput): ReportModel;
  export function summarizeReport(model: ReportModel): ReportSummary;
  export function renderReportJson(model: ReportModel): string;
  export function renderSummaryJson(summary: ReportSummary): string;
  ```

`SECTION_TITLES` must cover: `binder` "IPC binder", `components` "Component reuse", `empty-frame` "Empty frames", `fault-tree` "Fault tree", `flamegraph` "Flamegraph", `frames` "Frames", `gc` "GC pressure", `mem-measure` "Memory measurement", `memory` "Memory trend", `render` "Render", `rs-skip` "RenderService skips", `startup` "Startup", `threads` "Threads", `vsync` "VSync". An unknown id titles as the id itself.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/report-model.test.ts` with five tests:

1. groups metrics and evidence under their analyzer section, sorted by section id inside the model, metrics by id and evidence by `(kind, startNs, id)` regardless of input order;
2. titles known analyzers from `SECTION_TITLES` and falls back to the id;
3. a degraded section carries `status: 'degraded'` and `degradedReason` equal to its `degraded_capability` evidence `explain`, and totals count it in `degraded`;
4. copies `comparison` verbatim and computes severity totals;
5. `renderReportJson` is `JSON.stringify(model, null, 2) + '\n'`, contains no absolute path (`expect(json).not.toContain('E:\\\\')`) and two calls are identical.

Use small literal metrics/evidence built with the existing `metric()` / `evidence()` helpers.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `model.ts`**

Pure functions only. Copy input arrays before sorting; never mutate analyzer results. `degradedReason` is the `explain` of the section's first `degraded_capability` evidence. Totals count the section's sorted arrays. `startedAtNs` is included only when defined (`...({} : { startedAtNs })`). Export from `index.ts`.

- [ ] **Step 4: Green**

Run: `npx vitest run --project unit packages/core/test/report-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/model.ts packages/core/src/index.ts packages/core/test/report-model.test.ts
git commit -m "feat(core): build a typed, versioned report model"
```

---

### Task 3: Deterministic CSV exports

**Files:**
- Create: `packages/core/src/report/csv.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/report-csv.test.ts`

**Interfaces:**
- Consumes: `ReportModel` from Task 2.
- Produces: `renderMetricsCsv(model: ReportModel): string` and `renderEvidenceCsv(model: ReportModel): string`.

Metrics header (exact):
`section,id,value,unit,fidelity,degraded_reason,window_start_ns,window_end_ns,collector,table,rows,device`

Evidence header (exact):
`section,id,kind,severity,process,thread,frame_no,pid,window_start_ns,window_end_ns,explain,signals`

Quoting: a field is quoted when it contains `,`, `"`, `\n` or `\r`; inner quotes double. Rows end `\n`. `signals` keys are sorted lexicographically before `JSON.stringify`. Absent optional values are empty cells. Metric `value` is `String(value)`.

- [ ] **Step 1: Write the failing tests** in `packages/core/test/report-csv.test.ts`

1. exact header lines and one row per metric/evidence in model order;
2. quoting: a metric with a `degraded.reason` containing `a,"b"` yields `"a,""b"""`;
3. signals are sorted (`{b:2,a:'x'}` → `"{"a":"x","b":2}"` — the cell is quoted because it contains `"`);
4. rows end with `\n` and there is no `\r`;
5. output is identical across two calls.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-csv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `csv.ts`**, export from `index.ts`.

- [ ] **Step 4: Green**

Run: `npx vitest run --project unit packages/core/test/report-csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/csv.ts packages/core/src/index.ts packages/core/test/report-csv.test.ts
git commit -m "feat(core): render report metrics and evidence as CSV"
```

---

### Task 4: Offline HTML report

**Files:**
- Create: `packages/core/src/report/html.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/report-html.test.ts`

**Interfaces:**
- Consumes: `ReportModel` from Task 2.
- Produces: `renderReportHtml(model: ReportModel): string`.

Requirements from the spec: `<!doctype html>`, inline `<style>`, zero `<script>`/`<link>`/`@import`/`url(`/`http`, a header, a degraded banner listing every degraded section with its reason, an optional comparison table, one `<section id="<analyzer-id>">` per section with metrics table and `<details>` evidence, escaped interpolations, `\n` endings.

- [ ] **Step 1: Write the failing tests** in `packages/core/test/report-html.test.ts`

1. contains every section id as `<section id="...">` and every metric id;
2. a degraded section renders `degraded` and its reason; the banner lists its id;
3. escaping: a metric id or explain containing `<script>alert(1)</script>` appears as escaped text and the document contains no literal `<script>`;
4. offline: no `<link`, no `http://`, no `https://`, no `url(`, no `@import`;
5. comparison: with a comparison, rows carry class names `improved`/`regressed` and values; without one, no `id="comparison"` section;
6. two calls produce identical strings.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-html.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `html.ts`**

Single exported function; private `escapeHtml` replacing `& < > " '` in that order. Build lines in an array joined with `\n`. Inline CSS covers layout, tables, severity colors (`info`/`warn`/`critical`), status chips, and a print block. No JavaScript. Export from `index.ts`.

- [ ] **Step 4: Green**

Run: `npx vitest run --project unit packages/core/test/report-html.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/html.ts packages/core/src/index.ts packages/core/test/report-html.test.ts
git commit -m "feat(core): render a script-free offline HTML report"
```

---

### Task 5: Dependency-free XLSX writer

**Files:**
- Create: `packages/core/src/report/xlsx.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/report-xlsx.test.ts`
- Test helper: `packages/core/test/helpers/zip.ts`

**Interfaces:**
- Consumes: `ReportModel` from Task 2.
- Produces: `renderReportXlsx(model: ReportModel): Uint8Array`; test helper `readStoredZip(bytes: Uint8Array): Map<string, Uint8Array>`.

XLSX structure (stored ZIP, method 0, DOS time 0, DOS date 0x21, UTF-8 flag 0x0800, fixed entry order):
`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml` (Summary), `sheet2.xml` (Metrics), `sheet3.xml` (Evidence), plus `sheet4.xml` (Compare) only when `model.comparison` exists. Summary is key/value rows: schema, generator, app, device, window start/end ns, metrics, evidence, measured, degraded. Workbook uses `<sheet name="Summary" sheetId="1" r:id="rId1"/>` etc. Cells: finite numbers numeric, everything else `t="inlineStr"`, XML-escaped.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/helpers/zip.ts` parses local file headers sequentially (signature `50 4b 03 04`), returning name → bytes, stopping at the central directory signature `50 4b 01 02`.

In `report-xlsx.test.ts`:
1. bytes start with `PK\x03\x04` and `readStoredZip` yields the seven fixed parts, with `sheet4` present only with a comparison;
2. determinism: two renders are byte-equal;
3. `sheet2.xml` contains a numeric cell for a metric value (`<v>42</v>`) and an inline string for a metric id;
4. `workbook.xml` lists exactly `Summary, Metrics, Evidence` without a comparison and adds `Compare` with one;
5. XML escaping: a metric id `a<b&c` appears as `a&lt;b&amp;c`.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-xlsx.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `xlsx.ts` and `helpers/zip.ts`**

Implement CRC32 over bytes, little-endian writers, local header + data + central directory + end-of-central-directory. Keep all helpers private. Sheet XML: rows `<row r="N">`, columns `A`, `B`, … via a private `columnName(index)`. Export only `renderReportXlsx`.

- [ ] **Step 4: Green**

Run: `npx vitest run --project unit packages/core/test/report-xlsx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/xlsx.ts packages/core/src/index.ts packages/core/test/report-xlsx.test.ts packages/core/test/helpers/zip.ts
git commit -m "feat(core): write a dependency-free deterministic XLSX report"
```

---

### Task 6: `ohos-perf report` command

**Files:**
- Modify: `packages/cli/src/commands.ts` (request/output types, `runReport`)
- Modify: `packages/cli/src/deps.ts` (share context assembly, implement `report`)
- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/test/commands.test.ts` and `packages/cli/test/deps.test.ts` fakes (add `report` to the deps literal)
- Test: `packages/cli/test/report-cli.test.ts`, `packages/cli/test/report-deps.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 exports; existing `analyzeScene`/`readAnalysisFile`/`openOfflineScene` and `compareResults`.
- Produces:
  ```ts
  export interface ReportRequest {
    sceneDir: string; outDir: string; app?: string; baseline?: string;
  }
  export interface ReportOutput {
    outDir: string; files: string[];
    sections: { total: number; measured: number; degraded: number };
    metrics: number; evidence: number;
    comparison?: Record<DeltaStatus, number>;
  }
  export async function runReport(deps: CliDeps, req: ReportRequest,
    opts: { json?: boolean }): Promise<CliResult>;
  ```
  and `CliDeps.report(req: ReportRequest): Promise<ReportOutput>`.

- [ ] **Step 1: Write the failing program-level tests** in `report-cli.test.ts`

Using the `deps(overrides)` pattern from `compare-cli.test.ts`:
1. human output prints the report path, the artifact list in the fixed order (`report.html report.json summary.json metrics.csv evidence.csv report.xlsx`), section counts and totals;
2. with a comparison, a `comparison  improved …` line appears; without one it does not;
3. `--json` prints `JSON.stringify(output, null, 2) + '\n'`;
4. a deps throw yields `{ stdout: '', stderr: '<message>\n', exitCode: 1 }`;
5. the program parses `report <scene> --out <dir> --app x --baseline y` into the right request (drive `buildProgram` with a fake io and assert the deps call), and requires `--out`.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project unit packages/cli/test/report-cli.test.ts`
Expected: FAIL — `runReport` not exported.

- [ ] **Step 3: Implement `runReport`, types, and the program command**

Follow `runAnalyze`/`runCompare` exactly for formatting and failure mapping. Human output:
```
report  <out>/report.html
artifacts  <files joined by space>
sections  <measured> measured, <degraded> degraded
totals    <metrics> metrics, <evidence> evidence
comparison  improved N, regressed N, unchanged N, added N, removed N, incomparable N
```
Print `sections` as `sections  <total> measured` when nothing is degraded; print the degraded form only when `degraded > 0`. `report` goes after `compare` in `program.ts`.

- [ ] **Step 4: Write the failing deps integration test** in `report-deps.test.ts`

Build a temp scene directory with `createTraceDb` from `../test/helpers/trace-db` (and a minimal `scene.json` with `version: 1, app, pids, deviceId`), then call the real production wiring's `report` (the same construction `deps.test.ts` uses for `analyze`). Assert:
1. all six files exist in `--out`;
2. a second run into a second directory is byte-identical for every file;
3. `metrics.csv` has one line per metric in `report.json` plus the header;
4. `--baseline` against an `analyze --json` file adds `comparison` to `report.json` and a `Compare` sheet (assert `report.xlsx` differs from the no-baseline run);
5. a malformed baseline file fails and leaves only previously existing files untouched (no partial bundle: the scene is analyzed before the baseline is read, so the out dir must remain empty).

- [ ] **Step 5: Run and watch them fail, then implement the deps layer**

Run: `npx vitest run --project unit packages/cli/test/report-deps.test.ts`
Expected: FAIL.

Refactor `analyzeScene` into `analyzeSceneDetailed` returning `{ run, app, device, startedAtNs }` and keep `analyzeScene` as a wrapper. `deps.report` builds the model with `generator: { name: '@ohos-perf/core', version: packageVersion() }`, renders every artifact, writes them with `mkdir(..., { recursive: true })` + `writeFile`, and returns `ReportOutput`. Files are written only after the baseline is loaded and compared, so a bad baseline leaves the output directory untouched.

- [ ] **Step 6: Green**

Run: `npx vitest run --project unit packages/cli/test/report-cli.test.ts packages/cli/test/report-deps.test.ts`
Expected: PASS. Then run `npm test`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): add the report command and artifact writer"
```

---

### Task 7: Docs, skill and site command lists

**Files:**
- Modify: `README.md`
- Modify: `skill/ohos-perf/SKILL.md`
- Modify: `packages/cli/test/skill.test.ts` (add `report` to `COMMANDS`)
- Modify: `packages/cli/test/index.test.ts` and any command inventory assertions that enumerate commands
- Modify: `CHANGELOG.md` (Unreleased entry)

**Interfaces:**
- Consumes: the CLI surface from Task 6. Produces no code API.

- [ ] **Step 1: Update the skill test first**

Add `'report'` to `COMMANDS`; run `npx vitest run --project unit packages/cli/test/skill.test.ts` and watch it fail only if the skill text references `ohos-perf report` before the allowlist is updated — if it does not yet, add the skill section first, then run. The final state must pass.

- [ ] **Step 2: Document the command**

- `skill/ohos-perf/SKILL.md`: a short section under the analysis workflow — "produce a human report: `ohos-perf report <scene> --out reports/run1 [--baseline reports/base]`; artifacts are report.html/report.json/summary.json/metrics.csv/evidence.csv/report.xlsx; degraded sections are named in `summary.json`".
- `README.md`: add `report` to the command overview/quickstart area and a subsection describing the artifacts and determinism rule.
- `CHANGELOG.md`: under `## Unreleased`, add the report layer entry.

- [ ] **Step 3: Run the affected tests and the full suite**

Run: `npx vitest run --project unit packages/cli/test/skill.test.ts`
Expected: PASS.
Run: `npm test`
Expected: PASS (count grows; update README/site counts only at release, not here).

- [ ] **Step 4: Commit**

```bash
git add README.md skill/ohos-perf/SKILL.md packages/cli/test/skill.test.ts CHANGELOG.md
git commit -m "docs: document the report command and artifacts"
```

---

### Task 8: Release 0.4.0 and roadmap/site update

**Files:**
- Modify: `packages/core/package.json`, `packages/cli/package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`, `site/index.html`.

No product code changes. Do not tag or publish until Steps 1–3 are green.

- [ ] **Step 1: Full verification**

Run: `npm test`
Run: `npm run typecheck -w @ohos-perf/core`
Run: `npm run typecheck -w @ohos-perf/cli`
Expected: all green; record the exact test counts from the output.

- [ ] **Step 2: Bump and document**

Set both package versions and the CLI's core dependency to `0.4.0` in `package.json`/`package-lock.json`. Move `## Unreleased` to `## 0.4.0 — 2026-11-17`. Update README counts and roadmap: P9 row becomes `shipped in 0.4.0`. Update `site/index.html`: hero counts, the P9 card (add a "Shipped · v0.4.0" card describing the model/HTML/CSV/XLSX and the offline/deterministic guarantees), roadmap status, and the badge/meta version.

- [ ] **Step 3: Commit, tag, push, GitHub release**

```bash
git add -A
git commit -m "chore(release): 0.4.0"
git tag v0.4.0
git push origin master --tags
gh release create v0.4.0 --title "v0.4.0 — report artifacts" --notes "<summary + test counts + artifacts + attribution line>"
```

The release body ends with:
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`

- [ ] **Step 4: Verify CI and Pages**

Watch the CI run for the tagged commit (`gh run list --limit 10`) and the Pages deployment; a failure is fixed before moving to the next workstream.

---

## Self-review notes

- Spec coverage: model, summary, HTML, JSON, CSV, XLSX, comparison, degradation, CLI, determinism, skill/docs, release — every spec section maps to a task.
- Type consistency: `AnalyzerSection`/`AnalyzerRun` (Task 1) feed `ReportInput.sections` (Task 2); all renderers take `ReportModel`; `ReportOutput.comparison` uses the existing `Record<DeltaStatus, number>` shape.
- No step decides nothing; no task carries code the tests already determine beyond the ZIP format, which is an external contract the spec pins.
