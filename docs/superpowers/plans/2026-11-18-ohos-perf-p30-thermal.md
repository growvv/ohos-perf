# P30 — Thermal analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** port HapRay parity row 39 — a collector that samples `hidumper -s ThermalService -a '-t'` during a capture, and an analyzer that reports each sensor's start/end/peak/mean/rise — without HapRay's silent skip when the data is absent.

**Architecture:** a new `ThermalCollector` writes `thermal.jsonl`, one record per sample (`elapsedMs` plus readings that keep both the raw device value and the normalized Celsius value). The `ThermalAnalyzer` reads that artifact from `AnalyzeContext`, computes per-sensor statistics with measured gaps preserved, and emits `no_data` with a reason when the scene carries no capture — the opposite of HapRay's `return None`. The collector is wired into `collect`, into scenario steps (`COLLECTOR_NAMES`), and into `analyze` through the same declared-collector gate every other artifact uses.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9, the existing `Hdc` seam. No new dependencies.

**Spec:** HapRay at `bd5c98a`:
`perf_testing/hapray/core/collection/data_collector.py` (`parse_thermal_output`,
`_thermal_collection_worker`) and
`perf_testing/hapray/analyze/thermal_analyzer.py`.
Measured device output (Mate 60, 2026-11-18) has nine sensors
(`Battery`, `ambient`, `charger`, `dot`, `rfboard`, `shell_back`, `shell_frame`,
`shell_front`, `system_h`); millidegree readings like `31000` are 31.000 °C.
HapRay's own test records a `modem` sensor that reports plain Celsius (`27`),
so the unit rule is per reading, not per device.

## Global Constraints

- ESM only; no new runtime dependencies.
- `npm run verify` (build core, both typechecks, unit suite) must pass before
  every commit; the CLI's `dist` is rebuilt before `verify` after CLI edits.
- A device report is data from outside the package: every field is checked. A
  sensor with no reading is absent, never 0 °C.
- Determinism: analyzer output is sorted (metrics by id, evidence by
  `(kind, startNs, id)`); the same `thermal.jsonl` produces byte-identical
  analysis.
- Every new error is an `OhosPerfError` whose message names the value that
  failed. No silent defaults; no silent skip.
- The collector must not extend a capture beyond `durationMs` by more than one
  device call.
- New core exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.
- Version `0.25.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. `hidumper -s ThermalService -a '-t'` prints only the header (service
   absent) → the collector fails `THERMAL_NO_OUTPUT` naming the command, writes
   no file, and the scene is not presented as captured.
2. A sensor appears in some samples and not others → its statistics use the
   readings it has; the missing sample is a gap, not 0 °C.
3. One sensor reports millidegrees and another plain Celsius → each reading
   records which unit it was and its normalized value; no double conversion.
4. Sensor names that slug identically (`GPU-0`, `GPU 0`) → distinct metric ids,
   deterministic and collision-free.
5. A scenario step shorter than the 5 s default interval → exactly one sample,
   and an empty reading list is still a failed capture, not an empty section.

---

## File Structure

- Create `packages/core/src/thermal/parse.ts` — device output parser and
  reading types.
- Create `packages/core/src/collectors/thermal.ts` — sampler, JSONL artifact,
  artifact reader.
- Modify `packages/core/src/ingest/scene.ts` — `thermalFile`.
- Modify `packages/core/src/ingest/metadata.ts` — `capture.thermal`.
- Modify `packages/core/src/device/device.ts` — collect option, orchestration,
  artifact restore/removal, metadata.
- Create `packages/core/src/analyze/thermal.ts` — statistics, metrics,
  evidence, degraded path.
- Modify `packages/core/src/analyze/types.ts` — `thermal` on the context.
- Modify `packages/core/src/analyze/engine.ts` — register the analyzer.
- Modify `packages/core/src/report/metric.ts` — `celsius` unit.
- Modify `packages/core/src/report/evidence.ts` — `thermal` kind.
- Modify `packages/core/src/report/model.ts` — section title.
- Modify `packages/core/src/index.ts` — exports.
- Modify `packages/cli/src/{program,commands,deps}.ts` — `--thermal`,
  `--thermal-interval`, output, analyze context.
- Modify `packages/core/src/scenario/{schema,runner}.ts` — `thermal` as a step
  collector.
- Tests: `thermal-parse`, `collector-thermal`, `analyze-thermal`, `device`,
  `scenario-schema`, `scenario-runner`, CLI `collect`/`deps`/`program`,
  `doc-counts`, `doc-measured`, `parity`.

---

### Task 1: Parse the ThermalService output

**Files:**
- Create: `packages/core/src/thermal/parse.ts`
- Test: `packages/core/test/thermal-parse.test.ts`

**Interfaces:**
- Produces:
```ts
export type ThermalUnit = 'celsius' | 'millidegree_celsius';
export interface ThermalReading {
  readonly sensor: string;
  /** The device's own number, unchanged. */
  readonly raw: number;
  readonly unit: ThermalUnit;
  /** `raw / 1000` for millidegrees, else `raw`; rounded to 2 decimals. */
  readonly celsius: number;
}
export function parseThermalOutput(text: string): ThermalReading[];
```

- [ ] **Step 1: Write the failing tests**

Cases, in `packages/core/test/thermal-parse.test.ts`:
- the nine-sensor real output from the plan header parses to nine readings,
  `Battery.celsius === 31`, `dot.celsius === 29.43`, all
  `unit === 'millidegree_celsius'`.
- HapRay's recorded sample: `Type: modem\nTemperature: 27` yields
  `{sensor:'modem', raw:27, unit:'celsius', celsius:27}`.
- header lines and unrelated text are ignored.
- `Temperature: not-a-number` drops only that pair.
- a `Temperature:` before any `Type:` is ignored.
- duplicate `Type` in one output: the last reading wins.
- readings are sorted by sensor name (plain lexicographic), so the output is
  stable regardless of device order.
- `''` and header-only text return `[]`.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/thermal-parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseThermalOutput`**

Rules: trim each line; `Type:`/`Temperature:` prefixes are case-sensitive as
the device prints them; parse the temperature with `Number` and require a
finite number; `Math.abs(raw) >= 1000` selects millidegrees (recorded rule);
`celsius` is rounded to 2 decimals with `round2HalfEven`; dedupe by sensor with
the last value winning; return sorted by `sensor`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/thermal-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/thermal/parse.ts packages/core/test/thermal-parse.test.ts
git commit -m "feat(thermal): parse hidumper ThermalService output"
```

---

### Task 2: The thermal collector and its artifact

**Files:**
- Create: `packages/core/src/collectors/thermal.ts`
- Modify: `packages/core/src/ingest/scene.ts` (`thermalFile`)
- Test: `packages/core/test/collector-thermal.test.ts`

**Interfaces:**
- Consumes: `parseThermalOutput`, `ThermalReading`.
- Produces:
```ts
export const THERMAL_COMMAND = "hidumper -s ThermalService -a '-t'";
export interface ThermalRecord {
  readonly elapsedMs: number;
  readonly readings: readonly ThermalReading[];
}
export interface ThermalCapture {
  readonly records: readonly ThermalRecord[];
  /** Lines in the file that were not valid records. */
  readonly invalidLines: number;
}
export class ThermalCollector {
  constructor(deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> });
  collect(
    hdc: Hdc,
    target: string,
    opts: { durationMs: number; intervalMs?: number },
    layout: SceneLayout,
  ): Promise<{ samples: number }>;
}
export function readThermalRecords(layout: SceneLayout): ThermalCapture | undefined;
```
- `SceneLayout.thermalFile: string` = `<root>/thermal.jsonl`.

- [ ] **Step 1: Write the failing tests**

In `collector-thermal.test.ts`, using a fake `Hdc` whose `shellFor` returns
canned output and a fake clock whose `sleep` advances `now`:
- one device call at elapsed 0; with `durationMs: 10000`, `intervalMs: 5000`,
  three samples at `elapsedMs` `[0, 5000, 10000]`;
- each line of `thermal.jsonl` is a `ThermalRecord` with sorted readings;
- `durationMs: 3000`, default interval → exactly one sample (review focus 5);
- empty or header-only output → rejects `THERMAL_NO_OUTPUT`, no file is
  written (review focus 1);
- `intervalMs: 0` / negative / `durationMs: 0` → `THERMAL_BAD_INTERVAL` /
  `THERMAL_BAD_DURATION`, no device call;
- a stale `thermal.jsonl` is removed before capturing;
- `readThermalRecords` returns `undefined` when the file is absent, counts a
  malformed line as `invalidLines` while returning the valid records, and
  rejects a record whose `readings` is not an array of readings.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/collector-thermal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Sampling loop: validate options; remove stale file; `start = now()`; loop:
call `hdc.shellFor(target, THERMAL_COMMAND, remaining)`; parse; if
`readings.length === 0` throw `THERMAL_NO_OUTPUT` naming the command,
`elapsedMs`, and the device stderr (truncated); push `{elapsedMs, readings}`;
advance `now` by `sleep`; stop when `now - start >= durationMs`. Default
interval 5000 ms, minimum 100 ms, both constants exported for tests. Write the
JSONL once, after the loop (never a partial artifact). `mkdirSync(layout.root)`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/collector-thermal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collectors/thermal.ts packages/core/src/ingest/scene.ts \
  packages/core/test/collector-thermal.test.ts
git commit -m "feat(thermal): sample ThermalService into thermal.jsonl"
```

---

### Task 3: Wire the collector into `collect`

**Files:**
- Modify: `packages/core/src/device/device.ts`, `packages/core/src/ingest/metadata.ts`
- Test: `packages/core/test/device.test.ts`

**Interfaces:**
- `CollectOptions.thermal?: boolean | { intervalMs?: number }`.
- Scene metadata `capture.thermal?: { samples: number }` (positive integer;
  the collector cannot succeed with zero samples), validated in `isCapture`.
- The collector list gains `'thermal'` after `'hilog'`, before `'jsheap'`.

- [ ] **Step 1: Write the failing tests**

In `device.test.ts`, with its existing fake device dependencies:
- `thermal: true` adds one run, calls the collector with the capture duration
  and default interval, records `collectors: [..., 'hilog', 'thermal']` and
  `capture.thermal.samples`;
- `thermal: { intervalMs: 1000 }` forwards the interval;
- omitting `thermal` removes a pre-existing `thermal.jsonl` and does not list
  the collector;
- a failed thermal capture restores the previous `thermal.jsonl` byte-for-byte
  while keeping the previous `scene.json`;
- `readSceneMetadata` rejects `capture.thermal.samples` of 0 or a non-integer.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/device.test.ts`
Expected: FAIL — thermal is not a recognized collector.

- [ ] **Step 3: Implement**

Follow the `hilog` block exactly: `wantsThermal` computed beside the other
`wants*` flags; `remember(layout.thermalFile)` before capture; push the run
in the fixed position and read the result positionally; remove the file when
the collector did not run on the success path; add the metadata field. The
collector is injected through `deps.thermal` like `deps.hilog`, so the test
can stub it.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/device.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/device/device.ts packages/core/src/ingest/metadata.ts \
  packages/core/test/device.test.ts
git commit -m "feat(collect): --thermal through device orchestration"
```

---

### Task 4: The thermal analyzer

**Files:**
- Create: `packages/core/src/analyze/thermal.ts`
- Modify: `packages/core/src/analyze/types.ts`, `engine.ts`,
  `packages/core/src/report/{metric,evidence,model}.ts`
- Test: `packages/core/test/analyze-thermal.test.ts`

**Interfaces:**
- `MetricUnit` gains `'celsius'`; `EvidenceKind` gains `'thermal'`;
  `AnalyzeContext.thermal?: ThermalCapture`.
- `ThermalAnalyzer implements Analyzer`, `id = 'thermal'`, `requires = []`
  (the analyzer decides from what the scene carries, like `ui`/`coverage`).
- Produces metrics (ids sorted):
  - `thermal.samples.count` (count, exact)
  - `thermal.sensors.count` (count, exact)
  - `thermal.duration.ms` (ms, exact; last `elapsedMs` minus first)
  - `thermal.interval.median.ms` (ms, exact; median of consecutive deltas,
    emitted only with at least two samples)
  - `thermal.records.invalid` (count, exact; 0 is a measurement)
  - per sensor `<slug>`: `thermal.<slug>.start.celsius`,
    `.end.celsius`, `.peak.celsius`, `.mean.celsius`, `.rise.celsius`
    (celsius, exact; `mean` rounded to 2 decimals with `round2HalfEven`)
- Evidence: one `kind: 'thermal'`, severity `info`, per sensor, signals
  `{sensor, samples, startCelsius, endCelsius, peakCelsius, meanCelsius,
  riseCelsius}`, explain `"<sensor> rose <rise> °C over <n> sample(s) (<start>
  → <end>, peak <peak>)"`, `key: 'thermal:<sensor>'`, no drill-down.
- No capture: `thermal.degraded` proxy (0, `degraded.fallback:
  'no thermal measurement'`) plus a `no_data` evidence whose reason names
  `--thermal`.
- `SECTION_TITLES.thermal = 'Thermal'`.

- [ ] **Step 1: Write the failing tests**

In `analyze-thermal.test.ts`, building `AnalyzeContext` like the other
analyzer tests:
- three samples of `Battery` at 31 → 31.5 → 32 and one sensor present only in
  samples 1 and 3 → start/end/peak/mean/rise match the readings, and the
  two-reading sensor uses its own count (review focus 2);
- a `modem` reading and a `Battery` reading keep their units and values
  (review focus 3);
- `GPU-0` and `GPU 0` get distinct metric ids (review focus 4);
- metrics are sorted by id and evidence by the engine's order; two runs over
  the same input are deep-equal;
- no `ctx.thermal` → one proxy metric and one `no_data` item, and no
  `celsius` metric claims a temperature;
- `invalidLines: 2` reports `thermal.records.invalid === 2`;
- records declared but empty → degraded reason names the empty file.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/analyze-thermal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Slug rule: lowercase, every run of characters outside `[a-z0-9]` becomes `_`,
leading/trailing `_` trimmed, empty becomes `sensor`; when two sensors produce
the same slug, append `_2`, `_3` in sensor-name sort order. Statistics iterate
records in order and readings by sensor; a missing sensor contributes no
value. `provenance: { collector: 'thermal', table: 'thermal.jsonl', rows:
records.length, device: ctx.deviceId }`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/analyze-thermal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/thermal.ts packages/core/src/analyze/types.ts \
  packages/core/src/analyze/engine.ts packages/core/src/report/metric.ts \
  packages/core/src/report/evidence.ts packages/core/src/report/model.ts \
  packages/core/test/analyze-thermal.test.ts
git commit -m "feat(analyze): per-sensor thermal statistics"
```

---

### Task 5: CLI and scenario integration

**Files:**
- Modify: `packages/cli/src/{program,commands,deps}.ts`,
  `packages/core/src/scenario/{schema,runner}.ts`,
  `packages/core/src/index.ts`, `packages/core/test/types.test.ts`
- Test: `packages/cli/test/{collect-cli,deps,program}.test.ts`,
  `packages/core/test/{scenario-schema,scenario-runner}.test.ts`

**Interfaces:**
- `collect --thermal`, `--thermal-interval <seconds>` (positive finite,
  0.1–3600; converted to integer ms).
- `CollectRequest.thermal?: boolean | { intervalMs?: number }`;
  `CollectOutput.thermal?: { samples: number }`; the samples line includes
  `thermal <n>` after `hilog`.
- `COLLECTOR_NAMES` gains `'thermal'`; `RunnerCollectOptions.thermal?: boolean`;
  a step requesting it forwards `{ intervalMs: undefined }` (the default).
- The analyze path reads `readThermalRecords(layout)` only when
  `declared('thermal')` and passes `thermal` into the context.
- Exports: `ThermalCollector`, `THERMAL_COMMAND`, `parseThermalOutput`,
  `readThermalRecords`, `ThermalAnalyzer`, and the types.

- [ ] **Step 1: Write the failing tests**

- `collect --thermal --thermal-interval 1` forwards
  `{ thermal: { intervalMs: 1000 } }`; an invalid interval exits 1 before the
  device is touched;
- text output includes `thermal 3` when three samples were taken;
- a scenario step listing `thermal` forwards it to `device.collect`, and an
  unknown collector name still lists the allowed names including `thermal`;
- the analyze seam reads `thermal.jsonl` when scene.json declares `thermal`,
  and ignores a stray file when it does not;
- `VALUE_EXPORTS` includes the new value exports.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/cli/test packages/core/test/scenario-schema.test.ts packages/core/test/scenario-runner.test.ts`
Expected: FAIL — option/collector not recognized.

- [ ] **Step 3: Implement**

Mirror `hilog` in every file; parse the interval with the same
"invalid → exit 1, empty stdout" contract the other options use.

- [ ] **Step 4: Run to verify green**

Run: `npm run build -w packages/cli && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test packages/core/src/scenario \
  packages/core/src/index.ts packages/core/test
git commit -m "feat(thermal): --thermal in collect, scenarios and analyze"
```

---

### Task 6: Ledger, docs, site, release 0.25.0

**Files:**
- Modify: `packages/core/src/parity.ts`, `packages/core/test/parity.test.ts`,
  `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`,
  `packages/core/README.md`, `packages/core/package.json`,
  `packages/cli/package.json`, lockfile,
  `packages/cli/test/doc-counts.test.ts`, and the quoted analyze counts.

**Interfaces:**
- Consumes: everything above.
- Produces: row 39 `ported` with empty reason and `analyzer: 'ThermalAnalyzer'`;
  counts 38 ported / 0 partial / 0 missing / 1 out; 22 analyzers / 10
  collectors; release notes.

- [ ] **Step 1: Move the ledger row and the counts**

Row 39 becomes `ported`; `parity.test.ts` asserts `missing === 0` and the
`missing` list is empty. `doc-counts.test.ts`: expected counts 22/10, words
map gains `ten` and `twenty-two`.

- [ ] **Step 2: Measure the new analyze counts**

Build, then run the measured-count suites; update README's "80 metrics and 99
evidence items" / "79 metrics and 185 evidence items" and the site's two
quotations to the measured values (the thermal analyzer adds a degraded metric
and a `no_data` item to every scene without a capture).

- [ ] **Step 3: Write the release prose**

- README: analyzer count, collector count, a "Thermal" section — HapRay's
  `return None` means "not measured" reads as "no thermal problem"; ours emits
  `no_data` naming `--thermal`. Unit rule, per-sensor statistics, per-step
  scenario capture, and the `thermal.jsonl` artifact shape.
- Site: 22 analyzers / 10 collectors everywhere, thermal in the analyzer list,
  P30 card (en + zh), eyebrow P1–P30.
- `CHANGELOG.md`: 0.25.0.
- SKILL.md: read `thermal.*` metrics, treat `thermal.degraded` as not measured,
  never call a missing sensor 0 °C.
- Core README and package description: 22 analyzers / 10 collectors.

- [ ] **Step 4: Bump and verify**

Both package versions and the CLI's core pin to `0.25.0`; refresh the lockfile;
`npm run verify`; `npm run test:device` (serial).

- [ ] **Step 5: Live smoke, review, then release**

`collect --app <debug-bundle> --duration 12 --thermal --thermal-interval 2`,
then `analyze` on the scene and confirm a `thermal` section with the device's
nine sensors and rise values. Run the whole-branch review (fresh agent) before
tagging; fix Critical/Important red-first. Then commit, tag `v0.25.0`, push,
publish both packages with the token userconfig, poll the registry, fresh
install smoke, GitHub release, confirm CI/pages.
