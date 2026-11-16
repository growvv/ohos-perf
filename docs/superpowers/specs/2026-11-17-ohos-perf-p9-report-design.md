# P9 — Report artifact layer (HapRay parity W1)

**Status:** approved for implementation (2026-11-17)
**Goal of the series:** functional parity with ArkAnalyzer-HapRay, then beyond it.
P9 is the first workstream of the HapRay gap inventory
(`.superpowers/sdd/p9-hapray/gap-analysis.md`, W1): typed report model,
self-contained offline HTML, deterministic JSON/CSV and a dependency-free XLSX
export. Releases as `0.4.0`.

## Why this phase

Today the product's output is an agent contract: `analyze --json` is a flat
`{metrics, evidence}` document and `query --json` serves drill-down rows. There
is no human artifact at all. HapRay's most visible output is a single-file
dashboard plus spreadsheets; its weaknesses are an untyped payload, a vendored
3 MB front-end stack, an SQLite database embedded in HTML, pandas index columns
in spreadsheets and a `-1` sentinel in comparisons.

P9 closes the artifact gap without inheriting those weaknesses: one typed model
produces every artifact, the HTML is script-free and offline, CSV is
first-class, and XLSX has an explicit column contract.

## Scope

Shippable in `0.4.0`:

- `runAnalyzerSections()` in the engine: the same `AnalyzeResult` as
  `runAnalyzers()` plus per-analyzer section grouping (measured or degraded).
- A versioned `ReportModel` (`schemaVersion: 1`) built purely from typed inputs:
  generator, app, device, window, sections, totals, optional comparison.
- `ohos-perf report <scene-dir> --out <dir> [--app <pkg>] [--baseline <input>]
  [--json]`, writing:
  - `report.json` — the full model, formatted exactly like `analyze --json`
    (2-space JSON, trailing newline);
  - `summary.json` — one compact roll-up per section plus totals;
  - `report.html` — one self-contained file: inline CSS, zero scripts, zero
    external resources, every section including degraded ones;
  - `metrics.csv` and `evidence.csv` — deterministic, RFC 4180 quoting;
  - `report.xlsx` — a minimal stored-ZIP workbook with `Summary`, `Metrics`,
    `Evidence` and (when `--baseline` is given) `Compare` sheets.
- A comparison section driven by the existing typed `compareResults()`:
  `improved`/`regressed`/`unchanged`/`added`/`removed`/`incomparable`, never a
  `-1` sentinel.
- Degradation shown, not hidden: a section whose analyzer was skipped for a
  missing capability renders its `<id>.degraded` proxy metric, its reason, and
  appears in the report-wide degraded banner.

Out of scope for P9 (explicitly deferred):

- Step/scenario nesting and multi-version trends: they need W5 (scenario
  runner) before the model can carry steps honestly.
- Charts of any kind. The first release ships honest tables; a renderer is a
  later increment, not a prerequisite for a usable report.
- HTML re-render from saved geometry (`update`-equivalent): the same inputs
  produce the same files, so re-running `report` is the update path.
- `static`, `hilog`, `ui`, `memory-native`, `symbols` sections: they arrive
  with W7, W4, W6, W3 and W8. The model already carries arbitrary section ids,
  so each workstream only adds an analyzer.

## Model

```ts
interface ReportModel {
  schemaVersion: 1;
  generator: { name: string; version: string };   // '@ohos-perf/core', CLI version
  scenario: {
    app: { packageName: string; processNames: string[] };
    device: string;
    window: TimeRange;                            // ns
    startedAtNs?: number;                         // from scene.json when present
  };
  sections: ReportSection[];
  totals: {
    metrics: number;
    evidence: number;
    bySeverity: { info: number; warn: number; critical: number };
    measured: number;                             // section counts
    degraded: number;
  };
  comparison?: BaselineComparison;                // the existing typed comparison
}

interface ReportSection {
  id: string;                    // analyzer id, e.g. 'frames', 'threads'
  title: string;                 // human title from a fixed table
  status: 'measured' | 'degraded';
  degradedReason?: string;       // the engine's explain text when skipped
  metrics: Metric[];
  evidence: Evidence[];
}
```

Ordering rules are the existing determinism rules: sections sorted by analyzer
id, metrics by id, evidence by `(kind, window.startNs, id)`. `buildReport()`
does not sort input in place; it copies and sorts.

## Artifact contracts

### report.json

`JSON.stringify(model, null, 2) + '\n'`. No wall-clock timestamp, no absolute
paths, no host-dependent values: the same analysis inputs and the same package
version produce byte-identical files on every platform.

### summary.json

```ts
{
  schemaVersion: 1,
  app: string,
  device: string,
  window: TimeRange,
  sections: Array<{
    id, title, status, degradedReason?,
    metrics: number, evidence: number
  }>,
  totals: { metrics, evidence, bySeverity, measured, degraded },
  comparison?: Record<DeltaStatus, number>
}
```

### metrics.csv columns

`section,id,value,unit,fidelity,degraded_reason,window_start_ns,window_end_ns,collector,table,rows,device`

- `value` is the metric's `value` rendered as text (numbers keep their JS
  string form, so `0.5` stays `0.5`).
- Empty cells for absent optional fields. Booleans do not occur.
- Fields containing `,`, `"`, `\n` or `\r` are quoted with doubled inner
  quotes; rows end with `\n` (documented; deterministic on every platform).

### evidence.csv columns

`section,id,kind,severity,process,thread,frame_no,pid,window_start_ns,window_end_ns,explain,signals`

- `signals` is `JSON.stringify()` of an object whose keys are sorted
  lexicographically, so analyzer construction order cannot leak.
- `drillDown` is not flattened into CSV: it is structured and stays in JSON.

### report.html

- `<!doctype html>`, UTF-8, `lang="en"`.
- One inline `<style>`; **no `<script>` element at all**, no `<link>`, no
  `@import`, no `url(`, no `http://` or `https://` string. The page renders
  identically in a browser with networking disabled.
- Header: app package, device, window, generator version, schema version,
  metric/evidence totals.
- Degraded banner: every degraded section id with its reason, above the
  sections.
- Comparison section (when present): one row per metric with baseline, current,
  delta, %, fidelity and a status chip.
- One `<section id="<analyzer-id>">` per section: title, status badge, metric
  table (id, value, unit, fidelity, provenance, degraded reason), evidence list
  with severity, kind, subject, explain and signals. Evidence collapses into a
  native `<details>` element; no JavaScript is needed or used.
- Every interpolated string is HTML-escaped (`& < > " '`).
- Deterministic: same model → same bytes (`\n` line endings).

### report.xlsx

A minimal workbook written by a pure-TypeScript stored-ZIP writer:

- Fixed entry order; stored (method 0), no compression; DOS timestamp pinned to
  the ZIP epoch (1980-01-01 00:00); UTF-8 names. Same model → same bytes.
- Sheets: `Summary` (key/value), `Metrics`, `Evidence`, `Compare` (only when a
  comparison exists). All sheet names are ≤31 characters.
- Cells: finite numbers as numeric cells, everything else as inline strings
  with XML escaping. No styles, no formulas, no charts, no pandas index column.
- Excel treats a workbook with these four parts (`[Content_Types].xml`,
  `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, worksheets)
  as valid; the writer emits exactly those parts.

## CLI

```
ohos-perf report <scene-dir> --out <dir> [--app <pkg>] [--baseline <input>] [--json]
```

- `<scene-dir>` is a captured scene (same loader as `analyze`); the analysis is
  recomputed with section grouping in one pass.
- `--baseline` accepts a scene directory or an `analyze --json` file, exactly
  like `compare`.
- `--out` is created recursively; existing files are overwritten. The command
  never deletes anything else in the directory.
- Human output:

  ```
  report  <out>/report.html
  artifacts  report.html report.json summary.json metrics.csv evidence.csv report.xlsx
  sections  13 measured, 1 degraded
  totals    57 metrics, 12 evidence (info 3, warn 8, critical 1)
  comparison  improved 2, regressed 1, unchanged 5, added 0, removed 0, incomparable 3
  ```

  The comparison line appears only with `--baseline`; the degraded line appears
  only when a section is degraded.
- `--json` prints the same manifest object the deps layer returns:
  `{ outDir, files, sections: {total, measured, degraded}, metrics, evidence,
  comparison? }`.
- Any failure is exit 1, empty stdout, one stderr line — the established
  contract.

## Fidelity and honesty rules

- Every metric keeps `fidelity` and `provenance`; the HTML and CSV show them
  next to the value. A `proxy` never renders as if it were measured.
- A degraded section is labeled `degraded` in the model, the HTML badge, the
  summary and the CLI line. Its `<id>.degraded` zero metric is shown with its
  reason, not omitted.
- The report is built in one analysis pass; it cannot disagree with
  `analyze --json` because it consumes the same `AnalyzeResult` (a test pins
  this).
- No browser power estimate, no score, no LLM narrative, no invented savings.
  P9 is an artifact layer, not a new measurement.

## Testing

- Engine: a skipped analyzer produces one `AnalyzerSection` with
  `status: 'degraded'`; the merged result is deep-equal to `runAnalyzers()`.
- Model: grouping, titles, totals, degraded reasons, comparison passthrough,
  no absolute paths or timestamps in JSON, determinism.
- CSV: exact header, quoting, sorted signals, `\n` endings.
- HTML: all section ids present, degraded banner, comparison chips, no
  `<script`/`http`/`url(`, escaping of `<img src=x onerror=...>`-style text.
- XLSX: ZIP magic, deterministic bytes, extract stored entries in the test and
  verify workbook relationships, sheet XML values, numeric vs inline strings,
  no `Compare` sheet without a comparison.
- CLI: program-level tests with a stubbed deps (human, JSON, error), plus a
  deps-level integration test over a temporary scene that asserts the six files
  exist, that a rerun is byte-identical, and that `metrics.csv` rows match the
  model.
- Full suite + both package typechecks before release, as in P7/P8.

## Exit criteria

1. `ohos-perf report <scene> --out <dir>` writes `report.html`, `report.json`,
   `summary.json`, `metrics.csv`, `evidence.csv`, `report.xlsx`.
2. Running it twice on the same scene produces byte-identical files.
3. The HTML opens offline and contains every analyzer section, including the
   degraded ones with their reasons; it contains no scripts and no external
   resources.
4. `metrics.csv` has one row per metric with section, provenance and fidelity.
5. `--baseline` adds a typed comparison to the model, the HTML, the summary and
   the `Compare` sheet, with no sentinel values.
6. The full test suite and both typechecks are green; the skill adapter lists
   `report` and its test includes it in the known-command set.

## Later workstreams (roadmap context)

`0.5.0` W2 frame load/stutter · `0.6.0` W3 native memory · `0.7.0` W4 hilog ·
`0.8.0` W5 scenario runner · `0.9.0` W6 UI capture/diff · `0.10.0` W7 static
HAP · `0.11.0` W8 symbols. Each adds analyzers/collectors feeding this report
model; W5 adds the `steps` dimension and multi-version trends.
