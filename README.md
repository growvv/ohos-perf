# ohos-perf

**HarmonyOS performance, made measurable.**

[![ci](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml)
[![pages](https://github.com/growvv/ohos-perf/actions/workflows/pages.yml/badge.svg)](https://growvv.github.io/ohos-perf/)
[![license: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg)](LICENSE)

A TypeScript toolkit for HarmonyOS performance analysis. It turns an attached device
into structured, evidence-backed data: capability probing, ten collectors,
`trace_streamer` ingest, typed queries over the resulting SQLite
databases, twenty-three analyzers, metrics with provenance, an evidence graph,
baseline comparison, and a CLI designed to be called by agents.

- Website: <https://growvv.github.io/ohos-perf/>
- Design: [`design/2026-11-14-ohos-perf-core-design.md`](design/2026-11-14-ohos-perf-core-design.md)
- P0 plan: [`docs/superpowers/plans/2026-11-14-ohos-perf-core-p0.md`](docs/superpowers/plans/2026-11-14-ohos-perf-core-p0.md)

[![ohos-perf overview](site/assets/poster.jpg)](https://growvv.github.io/ohos-perf/#demo)

## Why

HapRay and DevEco Studio are excellent at producing a verdict, but their pipelines
are closed, and an emulator cannot produce every signal. ohos-perf exposes each
stage as a typed seam and makes three promises:

1. **No fabricated numbers.** Every capability is probed and carries a `reason`
   when unavailable; every metric carries `fidelity` (`exact`, `approximate`,
   `proxy`) and `provenance` (collector, table, rows scanned, device).
2. **Deterministic output.** The same input produces byte-identical JSON across
   runs. Metrics are sorted by `id`; evidence is sorted by
   `(kind, window.startNs, id)`.
3. **No native dependencies.** Node's built-in `node:sqlite`, an ESM package, and
   a checked public surface. No native build step, no Python, no bundled binary.

## Status

**P1 through P36 are complete**: 2461 tests (2450 unit, 11 in the device
project), two workspace typechecks and two builds, all green on the declared
minimum Node (`22.13.0`). On a clean checkout — `npm install && npm run build`,
with the gitignored `spike/out/emu_big.db` and `spike/out/real_device.db`
fixtures and any attached device absent — `npm run test:unit` reports **2422
passed, 28 skipped (3 files)**, and all eleven device tests skip, so the
combined clean checkout is **2433 passed, 39 skipped**. (Skip the build and 30
files fail to resolve `@ohos-perf/core`, which is published as `dist`.) With both fixtures present and a
device attached every test runs.
The fixture-dependent suites are `e2e-offline`, `drilldown-e2e`,
`parity-hapray`, `analyze-thread-wakeup`, `query-binder-startup`,
`query-callstack-perf`, `query-sched-state`, the CLI `index` end-to-end
tests and the CLI `doc-measured` suite (which re-runs the quoted `analyze`
counts against the same two traces). The eleven tests in the device project are
`collect-hiprofiler.device.test.ts`, `collect-capture.device.test.ts`,
`analyze-capture.device.test.ts`, `collect-memory.device.test.ts`,
`gesture.device.test.ts`, `scenario-run.device.test.ts` and
`ui-capture.device.test.ts`. Ten of them need a device and run serially
(`npm run test:device`) because they share one device and its fixed capture
paths; the recorded Mate 60 hiprofiler probe runs from a committed fixture.

Implemented today:

- `hdc` transport: shell, port forwarding, file send/recv, target listing
- one-shot capability probe → 23 verdicts with evidence
- collectors: hitrace (marker checks, stale-file protection, stop-on-failure),
  procfs (`/proc` memory/thread sampling with `pidof` resolution), hiprofiler
  (`hiprofiler_cmd` sessions with the ftrace, nativehook, gpu and xpower
  plugins ported from HapRay, plus a memory plugin that records per-process
  `process_measure`; the `.htrace` converts through the same `trace_streamer`
  path), hiperf (`perf.data` for a debuggable app, converted into a second
  `perf.db`), hidumper (RenderService fps and hitch counters), uitest (the
  on-screen UI tree), screenshot (`uitest screenCap` pulled into
  `screenshot.png`), hilog (the raw device log stream), jsheap
  (`hidumper --mem-jsheap`, pulled into `jsheap.heapsnapshot`) and thermal
  (`hidumper -s ThermalService -a '-t'` samples into `thermal.jsonl`); every
  requested collector runs concurrently in one `collect`. `--app` is required
  only by the modes that resolve a pid — `--hidumper`, `--uitest`,
  `--screenshot`, `--hilog` and
  `--hiprofiler --plugins memory` capture device-wide without it, while
  `--jsheap` needs it because the dump targets one process
- UI gesture injection: `GestureDriver` drives `uitest uiInput` over the plain
  shell — click, swipe (with an optional velocity), key events, text into a
  field and text into the focused field. Success is the device tool's
  `No Error` marker, never the host exit code, which `hdc` reports as 0 even
  when the device tool fails; coordinates, velocity and key names are validated
  before anything reaches the device
- baseline comparison: `ohos-perf compare <baseline> <current>` classifies each
  metric as improved, regressed, unchanged, added, removed or incomparable
- report artifacts: `ohos-perf report <scene> --out <dir>` renders one typed
  model as a self-contained offline HTML page, `report.json`, `summary.json`,
  `metrics.csv`, `evidence.csv` and a dependency-free `report.xlsx`; a scene
  with perf samples also gets `flamegraph.svg` and `flamegraph.html`, drawn
  from the same folded stacks the analysis measured. Identical inputs and
  package version produce byte-identical files, and skipped analyzers appear
  as `degraded` sections with their reason
- `trace_streamer` wrapper and scene layout, with `scene.json` metadata
  (device-uptime start marker, pids, collector list)
- typed queries over the 88-table trace database: frames, processes, threads,
  sched/instant, thread state, callstacks, perf samples, binder, startup
- named drill-down queries (`ohos-perf tools`, `ohos-perf query`) that resolve
  every `Evidence.drillDown` handle, and the agent skill adapter in
  `skill/ohos-perf/SKILL.md`
- analyzers: frames (with stutter levels and 1 s FPS windows), frame load
  (`frame.load.*`), fault tree (`fault.*`), binder (`binder.*`), threads
  (`thread.*`), memory (`mem.*`), memory measure (`mem.measure.*`, exact RSS
  from hiprofiler's `process_measure`), native memory (`mem.native.*`,
  per-address alloc/free pairing with peak, trough and unreleased rows from
  hiprofiler's `native_hook`), startup (`startup.*`), render
  (`render.*`), GC pressure (`gc.*`), VSync anomalies (`vsync.*`), empty
  frames with HapRay's false-positive filters and exact load share
  (`empty_frame.*`), RenderService skips reverse-traced through both the
  system-API `UnMarsh` wakeup chain and the NativeWindow buffer events
  (`rs_skip.*`), folded flamegraph stacks (`flamegraph.*`), symbol statistics
  with the unresolved share (`symbol.*`), ArkUI component reuse
  (`components.*`), the device log rules (`hilog.*`), cold-start redundant-file
  I/O (`redundant_file.*`), JS heap snapshot analysis (`jsheap.*`), thermal
  sensor statistics (`thermal.*`) and the UI
  tree and screenshot (`ui.*`), driven by an offline capability matrix derived
  from table presence
- `Metric` / `Evidence` models with provenance, fidelity and drill-down ids,
  plus the degraded-metric engine that skips analyzers whose inputs are absent
- `ohos-perf` CLI: `doctor`, `caps`, `collect`, `analyze`, `query`, `tools`,
  `compare`, `gate`, `ui-compare`, `report`, `render`, `trend`, `root-cause`,
  `hap`, `opt`, `gesture {click,swipe,key,input,text}`, `explore <app>`,
  `agent <app> <task>`, `symbols recover <lib.so>`,
  `emulator {list,start,stop,create}`, `run <scenario.json> | --cases <dir>`,
  `workload <plan.workload.json>`
- emulator lifecycle: `EmulatorClient` (spawn + parse) and `EmulatorLifecycle`
  (state + waiting) drive DevEco's `Emulator.exe`, attributing each running
  instance to its `hdc` TCP target so `collect --target` can use it
- scenario runner: `ohos-perf run scenario.json --out <dir>` validates a
  declarative JSON document before touching a device, then runs its steps in
  order — setup before the capture, actions inside the capture window, cleanup
  after it, always — writing one scene per (round, step) plus `steps.json`,
  `testInfo.json` and `pids.json`. A failed action fails the step and keeps
  its scene; `--keep-going` continues, and the exit code is 1 either way.
- external workloads: `ohos-perf workload plan.workload.json` runs a plan in
  the vocabulary HapRay's `PerfTestCase` publishes — `setup`, `measured`,
  `verify` — with the harness's own stop-then-launch preamble, capturing the
  `measured` phase into an ordinary scene. The plan is validated whole before
  a device is resolved, and a measured action that fails still finishes the
  capture, because the trace is a record of what happened.
- selector-driven steps: a ten-kind selector language over the captured UI
  tree, `tap`/`tapText` with scroll-to-find, `swipeArea` inside a component,
  `inputInto`, and a per-step `expect` block evaluated against a fresh dump —
  so a step's status says the screen held what the author asserted, not just
  that the device accepted a gesture. `run --cases <dir>` runs a directory of
  scenarios as one suite and indexes the verdicts in `cases.json`.
- thermal capture: `collect --thermal` samples the device's thermal service
  (`hidumper -s ThermalService -a '-t'`) for the capture window into
  `thermal.jsonl`, one record per sample (`{elapsedMs, readings}`), and
  `analyze` reports start, end, peak, mean and rise per sensor plus the sample
  count and median interval. The sensor list is whatever the device prints,
  never a list compiled in here. The unit rule is HapRay's and applies per
  reading: a value at or above 1000 in magnitude is millidegrees, anything
  smaller is plain Celsius — measured devices do both, sometimes on the same
  dump. The raw value and the unit inferred for it travel with the normalized
  Celsius value, so the inference is visible rather than baked in.
  `--thermal-interval <seconds>` overrides the 5 s default; a scenario step
  can list `thermal` in `capture.collectors`. A scene with no thermal capture
  gets a `no_data` item naming `--thermal`, where HapRay's analyzer returns
  `None` and the section silently disappears.
- coverage ingestion: `analyze` reads a scene's `coverageReport.json` — the
  document an instrumented build plus the external `bjc` toolchain writes — and
  reports line, function and branch percentages as `approximate`, naming the
  file they came from. The least-covered file is called out. A scene without a
  report gets a `no_data` item saying coverage was not measured, where HapRay
  silently omits the section.
- optimization detection: `ohos-perf opt <package|lib.so>` reads each arm64
  library's ELF and reports what the file records — LTO from `lto_priv.*`
  symbols and `.gnu.lto_*` sections, the level from an `-O` flag in `.comment`,
  and otherwise from the instruction mix, labelled `proxy` with its signals
  named. HapRay answers the same two questions with a ~2 GB TensorFlow LSTM and
  a 551-feature SVM and prints the guess as a percentage; on its own test
  `libflutter.so` both tools agree (high optimization, no LTO) while this one
  says which half it measured. Nothing is extracted to disk and no model ships.
- static HAP inspection: `ohos-perf hap <package.hap>` reads the archive in
  memory through a pure-TypeScript ZIP reader, inventories every file by
  HapRay's own category table, detects the technology stack from a typed port
  of its `techstack-config.yaml`, and reports duplicate assets (grouped by
  `(size, crc32)`, confirmed by SHA-256) and files above their category's
  size threshold. `--out` writes `hap.json` and an offline `hap.html`; nothing
  touches a device, and no archive is extracted to disk
- UI capture and diff: `collect --screenshot` pulls a PNG beside the tree;
  `ui-compare <a> <b> --out <dir>` reports structural tree changes by node
  identity and pixel changes by dHash and a bounded diff, with two marked PNGs
  and an offline HTML page. A pure-TypeScript PNG codec does the decoding, so
  no OpenCV, Pillow or native build is involved.
- autonomous exploration: `explore <app>` dumps the screen, hashes it, and
  taps an unvisited clickable until `--max-steps` (default 30) runs out or the
  screen has nothing left, under `--strategy depth_first|breadth_first|random`.
  Every order is a total order, `random` is seeded and the seed is reported, a
  tap that changed nothing is counted `no change` rather than as progress, and
  the visited set is per screen. After each tap it polls until the screen
  changes instead of waiting a flat 5 s, so the wait is a ceiling rather than a
  cost. `--model` has a model choose each step among the elements the dump
  offered; an answer naming an element that was not offered is refused and
  recorded, and that step falls back to the deterministic order — the offer and
  refusal contract is in "Model-guided exploration" below.
- model-guided exploration: `explore <app> --model <name>` shows a model the
  screen and the indexed elements the dump produced, and accepts only an
  element index it offered, `scroll`, `back` or `stop`. Page identity is a
  structural digest (`hashPageShape`) rather than a second model opinion, so
  `navigated` (a new page), `updated` (the same page, changed) and `no change`
  are measured from the screen's shape. The walk scrolls and goes back within
  per-screen caps, rebuilds its trail from the pages it actually reached, and
  never offers a model an irreversible target. Every refusal is reported with
  its step and reason, so a model that fails is visible instead of silently
  corrected.
- model-driven agent: `agent <app> <task>` asks an injected model what to do
  next and shows it the tree as one line per node. A `done` answer carries an
  expectation that is evaluated against the screen, so a claim the screen
  contradicts is `unverified` and exits non-zero; a tap on payment, ordering,
  transfer, sign-in or delete is refused before the device sees it; and every
  step records the gesture plus the screen hash either side of it, so the walk
  can be replayed without a model and stops at the first screen that differs.
  The client is not bundled: the endpoint comes from
  `OHOS_PERF_AGENT_BASE_URL`/`_API_KEY`/`_MODEL`, falling back to HapRay's
  `GLM_*` variables, and `--model` overrides the name.
- symbol recovery: `symbols recover <lib.so> <lib.so+0xoffset...>` names the
  addresses a capture could not, from the ELF's own symbol table. Every
  `STT_FUNC` symbol records a start (`st_value`) and a size (`st_size`), so the
  containing function is a lookup over sorted symbols — not radare2's
  boundary heuristic, which skips anything over 100 KB and defaults a missed
  lookup to 2000 bytes. An offset outside every function is reported as
  unresolved rather than attributed to the nearest preceding one, and a
  stripped file says it cannot recover rather than guessing. `--measure` asks
  the model to name the functions the file *does* record — from their
  instruction mix, never their names — and reports how many it got right, so
  a run states an accuracy instead of presenting a guess as a fact.
- report bundle and trend: `report <scene> --out <dir>` writes `report.html`,
  `report.json`, `summary.json`, `metrics.csv`, `evidence.csv` and
  `report.xlsx` from one scene, plus `flamegraph.svg`/`.html` when the scene
  has samples. `trend <report...> --out <dir> --label <name>` aggregates two
  or more saved bundles into `trend.html` and `trend.json`: one point per run
  per metric, a delta between the first and last run that measured it, and a
  verdict only where the metric has a known direction. A run that did not
  measure a metric — including a degraded stand-in — is a gap, never a zero.

Metric ids emitted by the analyzers:

| Prefix | Analyzer | Examples |
| --- | --- | --- |
| `frame.*` | frames | `frame.jank.rate`, `frame.fps`, `frame.stutter.level2.count`, `frame.fps.window.max` |
| `frame.load.*` | frame load | `frame.load.total`, `frame.load.top10.share`, `frame.load.span.weight` |
| `fault.*` | fault tree | `fault.arkui.HandleOnAreaChangeEvent`, `fault.RS.DisplayNodeSkipTimes`, `fault.ipc_binder.latency.avg` |
| `binder.*` | binder | `binder.transactions.count`, `binder.latency.avg` |
| `thread.*` | threads | `thread.patterns.count`, `thread.redundant.count` |
| `mem.*` | memory | `mem.rss.*`, `mem.pss.*` |
| `mem.measure.*` | memory measure | `mem.measure.rss.peak`, `mem.measure.rss.avg` |
| `mem.native.*` | native memory | `mem.native.total.peak`, `mem.native.unreleased.end`, `mem.native.callchains.count` |
| `startup.*` | startup | `startup.count`, `startup.duration` |
| `render.*` | render | `render.fps.live` (proxy), `render.hitch.count` |
| `gc.*` | GC pressure | `gc.partial.count`, `gc.rate`, `gc.perf.share` |
| `vsync.*` | VSync anomalies | `vsync.anomaly.rate`, `vsync.mismatch.count` |
| `empty_frame.*` | empty frames | `empty_frame.count`, `empty_frame.rate`, `empty_frame.load.severity` |
| `rs_skip.*` | RenderService skips | `rs_skip.frames.count`, `rs_skip.trace.accuracy`, `rs_skip.cpu_waste.ms`, `rs_skip.cpu_waste.instructions`, `rs_skip.traced.rs_api.count` |
| `flamegraph.*` | folded stacks | `flamegraph.app.share`, `flamegraph.stacks.count` |
| `symbol.*` | symbols | `symbol.samples.count`, `symbol.unresolved.count`, `symbol.unresolved.share`, `symbol.files.count`, `symbol.top.symbol` |
| `components.*` | component reuse | `components.reuse.rate`, `components.top.name` |
| `hilog.*` | hilog | `hilog.lines.count`, `hilog.rules.matched.count`, `hilog.rule.<name>.count` |
| `coverage.*` | coverage ingestion | `coverage.lines.percent`, `coverage.lines.covered`, `coverage.functions.percent`, `coverage.branches.percent`, `coverage.files.count` |
| `jsheap.*` | JS heap snapshot | `jsheap.total.bytes`, `jsheap.nodes.count`, `jsheap.detached.count`, `jsheap.objects.count`, `jsheap.retained.largest.bytes`, `jsheap.unreachable.count` |
| `redundant_file.*` | redundant-file I/O | `redundant_file.reads.count`, `redundant_file.files.used`, `redundant_file.files.unused` |
| `thermal.*` | device thermal sensors | `thermal.<sensor>.start.celsius`, `thermal.<sensor>.peak.celsius`, `thermal.<sensor>.rise.celsius`, `thermal.interval.median.ms` |
| `ui.*` | UI tree and screenshot | `ui.nodes.count`, `ui.nodes.clickable`, `ui.tree.depth.max`, `ui.screenshot.width`, `ui.screenshot.dhash` (animation labels live in `ui-diff.json`, not as metrics) |
| `hap.*` | static HAP inspection | `hap.files.count`, `hap.size.bytes`, `hap.techstack.count`, `hap.duplicates.wasted.bytes`, `hap.oversized.count`, `hap.category.images.bytes` |
| `binary.*` | optimization detection | `binary.files.count`, `binary.text.bytes`, `binary.instructions.count`, `binary.lto.files.count`, `binary.lto.unknown.files.count`, `binary.debug.files.count`, `binary.stripped.files.count`, `binary.high.optimization.files.count` (and the other level counts, `proxy`) |

The recorded traces pin field-level output for the binder, threads and
fault-tree analyzers against golden outputs from ArkAnalyzer-HapRay revision
`9386e4e`. Two more have synthetic HapRay goldens: the threads scorer
(`threads.synthetic.json`, exercising the redundancy path the traces lack) and
component reuse (`components.components.json`, generated by HapRay from
`components.synthetic.sql`). VSync, empty frames, RenderService skips and GC are verified differently — their
tests build traces that reproduce each HapRay rule and its threshold, and their
output on both recorded traces was compared against HapRay run at `9386e4e`
during development; no golden file is committed for them. Memory (procfs),
startup and the flamegraph have no HapRay equivalent that runs on these traces;
their tests pin the parser, aggregation and marker fallback instead, and no
parity is claimed for them.

Measured on the two recorded traces with `analyze <scene> --app <pkg> --json`,
`analyze` reports 81 metrics and 101 evidence items on `emu_big` (20.8 MB,
`pbench.baseline`) and 80 metrics and 187 evidence items on `real_device`
(13.1 MB, `erviceAbility:1`). Four of the older analyzers report real numbers
there: `vsync.signals.count` 60 with `vsync.periods.count` 7 and
`vsync.anomaly.rate` 101.67 on `emu_big` (160 / 0 / 0 on `real_device`),
`empty_frame.count` 6 with a
10% rate on `emu_big` (160 and 100% on `real_device`), `rs_skip.frames.count` 4
with `rs_skip.trace.accuracy` 100 on `real_device`, and `gc.partial.count` 2
with `gc.rate` 0.75 on `real_device`. The frame family now reports stutter and
FPS windows: `frame.stutter.count` 60 on `emu_big` (46 render, 14 ui, all
unpaired because the trace has no `type = 1` expect frames),
`frame.fps.window.count` 29 with min 0, max 32 and mean 5.55. The flamegraph
degrades on both traces
because `perf_sample` is empty — a hitrace capture has no CPU samples — and
component reuse reports 0 builds, a measured zero: neither capture recorded
ArkUI build events. The flamegraph's proxy names its missing input; the reuse
count is real and zero. `frame-load`, the empty-frame load metrics and
`native-memory` degrade the same way on these traces, with a reason naming
`--hiperf` or `--plugins nativehook`, rather than reporting zeros.

Coverage is read, not produced. The device capability stays unavailable, and
that is measured rather than assumed: `bjc_cov` is absent from the Mate 60
(`which` finds nothing and `aa` prints nothing over plain shell), and an
instrumented build is a property of how the app was compiled, so no collector
here can create one. What the package does do is read the `coverageReport.json`
that `bjc` writes — the same document HapRay's own HTML template renders — and
report its line, function and branch counts as `approximate`, with the file
named as their source. HapRay returns `None` when the report is absent, so its
section silently disappears and "not measured" reads as "0% covered"; here the
absence is a `no_data` item that says so.

The JS heap is the one capability whose *capture* exists and whose *analysis*
HapRay never had. `collect --jsheap` still asks the device for a
`.heapsnapshot`, and `js.heap` still reports unavailable — for a reason that is
now measured rather than inferred: on the Mate 60, with a debug-signed app
running, `hidumper --mem-jsheap <pid>` exits 0 and writes no file anywhere
under the app's data directory, and `-T` is a *thread* id (`hidumper -h`), so
passing the pid there asked for a thread dump. What changed is that a scene
carrying a snapshot is now analyzed: `analyze` reads `jsheap.heapsnapshot` and
reports total heap, node count, detached count and object count as `exact`
metrics, plus the largest constructor by **retained** size — the bytes that
become unreachable when it is collected, from a dominator tree over the whole
graph. Self size is carried beside it, because the two disagree sharply: on a
real 9.4 MB snapshot `Array` holds 3.78 MB of its own 0.62 MB, and ranked by
self size `Object` would lead instead. The reader streams the
document instead of `JSON.parse`-ing it — one aggregate pass, nothing allocated
per node and the two number arrays streamed rather than held: 12.7 MB peak
against 19.6 MB for a full parse of the same 9.4 MB file, and 77.4 MB against
106.7 MB on a 50 MB one, measured, the larger figure including the dominator
graph — and indexes every field from
`snapshot.meta` rather than a
hardcoded offset, and treats `to_node` as the node-slot offset V8 actually
writes. A snapshot is a collector artifact, so it is read only when `scene.json`
declares the `jsheap` collector — a file an earlier capture left behind is not
reported as this scene's heap. HapRay captures the file and analyzes nothing.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| P0–P6 | capability probing, six collectors, trace ingest, typed queries, fourteen analyzers, deterministic JSON, baseline comparison, agent skill | shipped in `0.2.0` |
| P7 | `ohos-perf emulator {list,start,stop,create}` lifecycle commands | shipped in `0.3.0` |
| P8 | `ui.gesture` driven through `uitest uiInput`, plus an honest `coverage` verdict from a measured `bjc_cov` probe | shipped in `0.3.0` |

The HapRay parity series (one release per major item, so far):

| Phase | Workstream | Scope | Status |
| --- | --- | --- | --- |
| P9 | W1 report layer | typed report model, offline HTML, JSON/summary/CSV, dependency-free XLSX, `ohos-perf report` | shipped in `0.4.0` |
| P10 | W2 frame load | per-frame sampled-event attribution, top-N loaded frames, stutter levels with expected/actual excess, 1 s FPS windows, empty-frame load share and severity, four attribution queries | shipped in `0.5.0` |
| P11 | W3 native memory | `native_hook` alloc/free pairing, peak and unreleased by callchain, category evidence, timeline | shipped in `0.6.0` |
| P12 | W4 hilog | plaintext log capture, deterministic pattern rules, per-window evidence, JSON/CSV | shipped in `0.7.0` |
| P13 | W5 scenario runner | declarative JSON steps and rounds, per-step capture windows, `steps.json`/`testInfo.json` | shipped in `0.8.0` |
| P14 | W6 UI capture/diff | screenshots and trees per capture point, identity-based tree diff, pure-JS image diff, offline HTML | shipped in `0.9.0` |
| P15 | W7 static HAP | offline HAP inventory, tech-stack fingerprints, duplicate/oversized assets, report section | shipped in `0.10.0` |
| P16 | W8 symbols | exact `(file_id, serial_id)` resolution, symbol statistics with the unresolved share, `--so-dir` device symbolization, offline flamegraph artifact | shipped in `0.11.0` |
| P17 | W5 step DSL | selector language over the UI tree, `tap`/`tapText`/`swipeArea`/`inputInto` with scroll-to-find, step assertions that actually run, `run --cases` | shipped in `0.12.0` |
| P18 | parity completion | a machine-checked 35-row parity ledger, fault-tree `ipc_binder`, `collect --jsheap`, redundant-file I/O, the file-to-HAR dependency graph, `rs_skip.cpu_waste.ms`, per-step comparison | shipped in `0.13.0` |
| P19 | row 12 completion | the system-API `UnMarsh` wakeup-chain backtracking, `rs_skip.cpu_waste.instructions`, per-method trace counts | shipped in `0.14.0` |
| P20 | row 31 completion | animation labels that require the pixels and the tree to agree, HapRay's severity bands, pixel-only regions reported separately, unmeasurable regions named | shipped in `0.15.0` |
| P21 | row 35 completion | `trend` aggregates any number of saved report bundles into one page: per-metric points, gaps for what a run did not measure, deltas across the runs that did, and a stated ordering | shipped in `0.16.0` |
| P22 | row 33 completion | `render` re-renders a saved bundle from its typed model with no scene, device or analyzer — every artifact byte-identical to the bundle it came from | shipped in `0.17.0` |
| P23 | row 4 completion | `explore` walks the UI on a total order, records a dead tap as `no_change`, remembers visits per screen, replays `random` from a recorded seed, and settles on the screen's change instead of HapRay's fixed 5 s window | shipped in `0.18.0` |
| P24 | row 24 completion | `analyze` reads a scene's `coverageReport.json` — the document `bjc` writes — and reports line, function and branch coverage as `approximate`, with a missing report a named `no_data` rather than HapRay's silent skip | shipped in `0.19.0` |
| P25 | row 27 completion | `opt <package\|lib.so>` reads each arm64 library's ELF: LTO from `lto_priv.*`/`.gnu.lto_*`, the level from a recorded `-O` flag, and otherwise from the instruction mix, labelled `proxy` with its signals named — no TensorFlow model | shipped in `0.20.0` |
| P26 | row 5 completion | `agent <app> <task>` drives the app with an injected model: a completion claim carries an expectation the screen is checked against, an irreversible tap is refused before the device sees it, and every step records the gesture and both screen hashes so `replayAgent` can re-walk it without a model | shipped in `0.21.0` |
| P27 | row 28 completion | `symbols recover <lib.so> <address...>` names unresolved `libfoo.so+0xoffset` references from the ELF's own `st_value`/`st_size` — a lookup, not radare2's boundary heuristic — and `--measure` reports the model's naming accuracy over names the file records, which HapRay never states | shipped in `0.22.0` |
| P28 | row 36 | `root-cause <scene-dir\|report.json>` ranks the measured evidence by our own severities, states a verdict from the highest finding, and optionally asks a model for suspects — which must cite evidence ids and name only what the run measured, or the claim is marked ungrounded. `--offline` writes the report with no endpoint; a missing endpoint falls back to it and says so | shipped in `0.23.0` |
| P29 | row 38 completion | `explore --model` lets a model choose each step among the elements the dump offered: an answer naming an unoffered element, scroll or back when unavailable, or a non-JSON reply is a recorded refusal and the deterministic order takes that step. Page identity is a structural digest, not a second model call, so `navigated`/`updated`/`no change` are measured; the walk scrolls and goes back within per-screen caps, and irreversible targets are never offered to a model | shipped in `0.24.0` |
| P30 | row 39 completion | `collect --thermal` samples `hidumper -s ThermalService -a '-t'` into `thermal.jsonl` with each reading's raw value, inferred unit and normalized Celsius value; `analyze` reports start/end/peak/mean/rise per sensor, sample count, duration and median interval, with a missing capture a `no_data` naming `--thermal` instead of HapRay's silent `None`. Sensors come from the device, and a scenario step can request the capture | shipped in `0.25.0` |
| P31 | beyond the inventory | `gate <budgets.json> <run>` judges a run against a versioned budget document — absolute `max`/`min` and `maxDelta`/`maxDeltaPct` against a baseline — with exit 2 for a violated or unmeasured budget and exit 1 for a gate that could not run. A metric the run never emitted is `missing`, never a pass, so a green build cannot mean an analyzer stopped running. HapRay's regression story stops at a chart a human reads | shipped in `0.26.0` |
| P32 | beyond the inventory | `root-cause --baseline <run>` answers what changed between two runs: a deterministic movement of every metric (regressed / improved / unchanged / incomparable / gap) and of every evidence kind, rendered before the verdict and offered to the model, whose `metrics` citations are checked like evidence ids. A gap — a metric one run did not measure — is never an improvement, and the direction is the caller's baseline -> input rather than capture time. HapRay's multi-version page leaves the comparison to a human reading dropdowns and its root cause sees one run | shipped in `0.27.0` |
| P33 | beyond the inventory | every command answers in one versioned envelope under `--machine-json` (one line on stdout) or `--result-file` (the same document on disk): `schemaVersion`, `toolId`, `command`, `success` derived from `exitCode`, the command's own payload, and the failure as a typed `error`. A `gate` verdict of fail is exit 2 with no `error` — the tool ran and the news is bad. `parseToolResult` validates on the way back in, which HapRay's write-only `machine_output.py` never does, and no result file is written unless asked | shipped in `0.28.0` |
| P34 | beyond the inventory | `ohos-perf mcp` serves every command as an MCP tool over stdio: the tool list is derived from the commander program (one tool per leaf, `ohos-perf_<path>`, with that command's own options as its `inputSchema`), each call runs the command with `--machine-json` and returns the envelope as `structuredContent`, and the server answers both protocol eras — modern `2026-07-28` (`server/discover`, per-request `_meta`) and legacy `2025-11-25` (`initialize`) — so a client that predates the handshake change still works. `isError` means the command could not run, not that the news is bad. HapRay has no MCP surface at all | shipped in `0.29.0` |
| P35 | beyond the inventory | `analyze` reads a scene's `jsheap.heapsnapshot` and reports the heap: total size, node count, detached count and object count as `exact` metrics, plus the largest constructor by self size. The reader streams the document instead of `JSON.parse`-ing it — one aggregate pass, nothing allocated per node and the two number arrays streamed rather than held: 12.3 MB peak against 19.6 MB for a full parse of the same 9.4 MB file, and 30.1 MB against 106.5 MB on a 50 MB one, measured (P36 materializes the graph for retained size and moves that 50 MB figure to 77.4 MB) — and indexes every field from `snapshot.meta` rather than a hardcoded offset, and treats `to_node` as the node-slot offset V8 writes; a snapshot is read only when `scene.json` declares the `jsheap` collector, and its absence is a `no_data` naming `--jsheap`. Also fixes the collector: `-T` is a thread id, and it was being passed the pid. HapRay captures the file and analyzes nothing | shipped in `0.30.1` |
| P36 | beyond the inventory | retained size, which is the question a heap snapshot exists for: a dominator tree over the whole graph (iterative Cooper–Harvey–Kennedy, typed arrays only, 665 ms at 861 605 nodes / 2 268 808 edges) ranks constructors by what they **hold** rather than by their own bytes. Measured on a real 9.4 MB snapshot the ranking flips — `Array` self 0.62 MB / retained 3.78 MB leads, where self size puts `Object` (0.96 MB) first, and `system / Context` retains seven times its own size. `jsheap.retained.largest.bytes` and `jsheap.unreachable.count` join the metrics, the `js_heap` evidence names the largest retained holder and carries self size beside it, and unreachable nodes are counted separately from `detachedness` because an embedder annotation and a graph fact can legitimately disagree. A node nested inside another of the same name counts in both rows, as DevTools does. Past a documented ceiling (20 million edges or 4 million nodes — the working set is ~53 bytes a node, so edges alone were not a memory bound) the graph is not built and the heap totals are reported with the omission named. A `weak` edge is not a reference: it is validated and counted in the heap total but kept out of the graph, because a `Map` that merely mentions a payload does not own it. The graph costs memory — the 50 MB fixture's peak moved 30.1 → 77.4 MB, still below `JSON.parse`'s 106.7 MB, pinned by a test | shipped in `0.31.0` |
| P37 | beyond the inventory | `suspects <root>` scans an ArkTS source tree without a device and ranks the defects it finds. The scanner reads ArkTS as text with brace tracking — not a parser, because decorators on `struct` and builder syntax break every TS grammar — and it handles the things that made a line-oriented reader wrong: a quote inside a regex literal, a method whose parameter list wraps across lines, a field whose initializer spans lines, and CRLF. Seventeen rules name the shapes OhmBench records (order-by-random, SQL or a write in a loop, an N+1 read, an eager `ForEach` in a virtualisable container, a state write in a high-frequency callback, an unbounded persisted list, a font registered per visit, an HTTP session never destroyed, …). The reported symptom is the ranking input: `--prompt prompt.json` (the benchmark's own file) or `--symptom`/`--scenario` narrows the report to the findings that can explain it, and a Chinese-to-English glossary matches "文章列表" to `ArticleListView`. On OhmBench's 21 blind cases (source + `prompt.json` only, no ground truth, no patches) precision **0.857**, recall **0.929** — where HapRay returns zero code locations on the same input, measured by running its `root-cause` action over all 21 blind trees (it accepts one as `--report-dir` and answers "未发现可用的性能信号产物" without naming a file). Every miss and its reason is in `bench/ohmbench/RESULTS.md` | shipped in `0.32.3` |
| P38 | beyond the inventory | an external review of the `suspects` scanner is published with its own false positives: eleven findings, six real and five that described failures the code does not have. Every claim was reproduced or refuted against the code before anything changed, and the one the reviewer called Critical — apply the confidence tier before the name filter — measured three cases worse when applied and was reverted. The fixes that shipped: a SQL concatenation is followed to the end of its statement; loop depth is counted on noise-stripped text; `executeSql` must name a write; a cap or a `destroy()` is searched in the holding class; duplicate module statements report their own lines; a regex after a keyword is a regex. Nine `Math.max(...array)` sites that threw between 124k and 150k arguments now use `maxOf`/`minOf`. OhmBench byte-identical at 0.857 / 0.929 | shipped in `0.32.3` |
| P39 | beyond the inventory | the device axis, driven by somebody else's plans: `workload <plan.workload.json>` runs the `setup` / `measured` / `verify` shape HapRay's `PerfTestCase` publishes, with the harness's own stop-then-launch preamble (a published plan relies on it, so without it the first `wait` fails on the home screen). `setup` runs before the capture, `measured` inside it, `verify` after; a measured failure finishes the capture anyway, and a phase that overruns `--duration` fails naming both numbers. The plan is validated whole before a device is resolved. Driving OhmBench's 21 cases on the emulator (`bench/ohmbench/dynamic/`: build, sign, install, run) found a real defect the source axis could not: every app-attributed analyzer reported `no_data` on a trace full of the app, because the trace records the 15-character kernel comm (`com.hefengbao.jingmo.hw` as `ngbao.jingmo.hw`) and a plain hitrace recorded no pid. `resolveAppIpids` falls back to a name match, and `collect` records the pids in `scene.json`. 21/21 built and signed, 19/21 installed, and `bench/ohmbench/RESULTS.md` names each case whose own workload cannot run and why | shipped in `0.33.0` |

The parity scope comes from a source-level inventory of ArkAnalyzer-HapRay,
re-pinned in `0.23.0` from rev `9386e4e` to rev `bd5c98a` — 428 commits later,
which added `root-cause`, `build`, an LLM exploration strategy inside `haptest`
and a thermal collector. Rows 1–35 keep the original inventory's numbers;
36–39 are the new capabilities, appended so a reader can tell them apart.
The status of every row is **data, not prose** — `packages/core/src/parity.ts`
holds all 39 with a status and, when a row is not fully ported, the reason.
`paritySummary()` computes the counts, and `parity.test.ts` checks each ported
row's analyzer against the set the engine actually registers, so a claim cannot
outlive the code:

| Status | Rows |
| --- | --- |
| ported | 38 |
| partial | 0 |
| missing | 0 |
| out, with a measured reason | 1 |

Row 37 (`build`) is the one row this project refuses. It wraps `deveco-cli` to
compile a debug HAP: a build tool, not a measurement. A package analyzer cannot
own the toolchain that compiles the package it reads, and a half-ported wrapper
would make every measurement depend on a compiler version this package does not
control. `hap` and `opt` read what the build produced instead.

Row 38 (the LLM exploration strategy and state comparator) left that list in
`0.24.0`. HapRay asks a model two questions — which node to tap, and whether
the screen changed — and checks neither answer: an element index outside the
offered range gets whatever the array holds, a malformed answer gets element
zero, and the state comparator's yes/no decides whether the step counted.
`explore --model` keeps the first question with its answer verified against
the offer, and replaces the second with `hashPageShape`, a digest of the
screen's structure. The model never supplies coordinates, and irreversible
targets are not offered at all.

Row 39 (thermal analysis) left that list in `0.25.0`, closing the missing
column. HapRay's analyzer returns `None` when a step has no
`thermal_data.jsonl`, so "not measured" and "the device stayed cool" look the
same in its output; here a scene without a capture emits a `no_data` item
naming `--thermal`. The sensor set is read from the device, and each reading
keeps the raw number and the unit inferred from it beside the normalized
Celsius value.

Row 5 (the LLM GUI agent) left that list in `0.21.0`. HapRay's blocker was
the external `phone_agent` dependency, and the three things that made its
output unusable were defects rather than prerequisites: it trusted the model's
`finished` flag without looking at the screen, guarded payment and ordering in
a prompt sentence, and recorded prose that could not be replayed. `agent <app>
<task>` keeps the shape and fixes all three — a completion claim carries an
expectation the screen is checked against, an irreversible tap is refused
before it reaches the device, and every step records the gesture plus the
screen hash either side of it, so `replayAgent` can walk the same path on
another build without a model. The endpoint is read from
`OHOS_PERF_AGENT_BASE_URL`/`_API_KEY`/`_MODEL`, falling back to the
`GLM_BASE_URL`/`GLM_API_KEY`/`GLM_MODEL` variables HapRay already reads.

Row 28 (symbol recovery) left that list in `0.22.0`. HapRay's tool shells
out to radare2 for function boundaries and asks an LLM to name what it finds,
and never measures whether the name is right — its own docs record the
heuristic it runs on (a function over 100 KB is "unreasonable, skip", and a
missed lookup gets 2000 bytes). An ELF records every function's start and size
in `st_value`/`st_size`, so the boundary is a lookup over sorted symbols;
`symbols recover <lib.so> <address...>` reports the containing function, and
`--measure` holds out the names the file *does* record, asks the model to
infer them, and states how many it got right. That accuracy number is the part
HapRay's tool has no answer for.

Row 27 (the TensorFlow opt-detector) left that list in `0.20.0`. Its blocker
was never the question — "was this built optimized, and with LTO?" — but the
~2 GB model it answered the question with. `opt <package|lib.so>` reads the
ELF: `lto_priv.*` symbols and `.gnu.lto_*` sections prove LTO, a `-O` flag in
`.comment` states the level, and the instruction mix is a measurement rather
than an inference from a byte histogram. On HapRay's own test `libflutter.so`
both tools agree — high optimization, no LTO — while this one says which part
it measured and which it inferred.

Row 24 (coverage) left that list in `0.19.0`. The instrumented build is still
external — that is a property of how the app was compiled — but the analysis of
the report it produces is not: `analyze` reads the scene's
`coverageReport.json` and labels every number `approximate`, while HapRay skips
the section silently and leaves "not measured" indistinguishable from "0%".

Row 4 (HapTest autonomous exploration) left that list in `0.18.0`. HapRay's
`haptest` is not blocked by a prerequisite this package lacks — it was a
defect in the implementation: an unseeded walk whose two runs of the same
build explore different screens, and a step counter that cannot tell a tap
that opened a screen from a tap on a dead element. `explore` keeps the shape
and fixes both, so the row is now `ported` on its own merits.

No row is `partial` any more. Row 33's last clause was re-rendering a bundle
from its saved inputs, and `render <report.json> --out <dir>` now does it from
the typed model alone — no scene, no device, no analyzer — reproducing every
artifact byte for byte. That leaves all 35 rows ported, with none refused.

`0.13.0` closed the last four `missing` rows. The fault tree now carries an
`ipc_binder` section derived from the typed binder analysis rather than from a
shared file HapRay's own ordering makes stale (row 15); `collect --jsheap`
pulls a heap snapshot, with every refusal typed (row 20); a
`redundant_file.txt` in a scene is parsed into read/used/unused counts, with
its format documented rather than guessed (row 21); and `buildDepGraph` turns a
file list and module declarations into the file-to-HAR graph, cross-module
edge counts and timing cycles HapRay needs a Homecheck checkout and a 16 GiB
heap to produce (row 29). Row 12's reverse trace now runs both of HapRay's
paths — the system-API `UnMarsh RSTransactionData` wakeup chain (up to five
hops) and the NativeWindow buffer events — charges the wasted work in both
milliseconds and sampled instruction weight, and reports how many frames each
method traced. `compareScenes` compares multi-step runs step by step instead
of merging them, and `trend` aggregates any number of saved bundles into one
page with per-metric deltas and a stated ordering (row 35).

The rendered roadmap, with the same content in Chinese, is on the
[project site](https://growvv.github.io/ohos-perf/#roadmap).

## Requirements

- Node **`^22.13.0 || >=23.4.0`**. `node:sqlite` is unavailable unflagged on
  22.5–22.12 and 23.0–23.3; the package imports on those versions and throws an
  actionable `RUNTIME_UNSUPPORTED` error when a database is opened.
- `hdc` and `trace_streamer` from a DevEco Studio installation for live capture
  and ingest. Offline analysis of an existing `trace.db` needs neither.

## Quickstart

Install the CLI from npm:

```bash
npm install -g @ohos-perf/cli

ohos-perf doctor          # what can this device do?
ohos-perf caps --json     # machine-readable matrix
```

Or run it once without installing: `npx @ohos-perf/cli doctor`.

Capture a scene (add `--procfs` for memory samples, `--cold-start` to launch an
ability first, or `--hiprofiler --plugins …` to record through hiprofiler):

```bash
ohos-perf collect \
  --app com.example.app --duration 10s --out ./scene --procfs \
  --cold-start EntryAbility --json

# hiprofiler plugins: ftrace (default), gpu, xpower, nativehook, memory
ohos-perf collect \
  --app com.example.app --duration 10s --out ./hipro-scene \
  --hiprofiler --plugins gpu,xpower,nativehook --json

# everything at once: perf samples, render counters, the screen, the tree and the log
ohos-perf collect \
  --app com.example.app --duration 10s --out ./full-scene \
  --procfs --hiperf --hidumper --uitest --screenshot --hilog --json

# hand the converter a symbol directory: frames it can name come out named,
# the rest stay file+0xoffset and are reported as unresolved
ohos-perf collect   --app com.example.app --duration 10s --out ./perf-scene   --hiperf --so-dir /path/to/symbols

# device-wide memory sampling needs no app
ohos-perf collect \
  --duration 10s --out ./mem-scene --hiprofiler --plugins memory --json
```

`--app` is optional for the device-wide collectors; a capture without it
writes `{"packageName": "", "processNames": []}` to `scene.json`, and the
memory-measure analyzer degrades with a reason rather than attributing
device-wide rows to an app.

`--hiperf` needs a **debuggable** app; the device refuses others. An idle app
legitimately produces `hiperf: { samples: 0 }` — a real capture, reported as
`hiperf 0` in the human summary rather than dropped from it.

Drive the app to the state you want to measure, then capture it — gestures are
their own command, so `collect` never takes a gesture script:

```bash
ohos-perf gesture click 500 800 --json
ohos-perf gesture swipe 500 800 500 200 --velocity 600 --json
ohos-perf gesture key Home --json
ohos-perf gesture input 500 500 "hello" --json    # tap a field, then type
ohos-perf gesture text "hello" --json             # type into the focused field

# a second target is explicit; the device commands accept --target
ohos-perf gesture key Back --target 127.0.0.1:5555 --json
```

Each prints `{ gesture, output }`. The human line ends in `accepted`, which
means the device tool printed its `No Error` marker — not that a widget reacted.
A velocity outside 200–40000 and a key other than Back/Home/Power or a positive
code are rejected before anything touches the device.

Compare two captures — each argument is a scene directory or a saved
`analyze --json` file:

```bash
ohos-perf compare ./before ./after --json
```

Compare the same two captures by what was on screen — tree structure and
pixels, with two marked images:

```bash
ohos-perf ui-compare ./before ./after --out ./ui-diff --json
```

Inspect a package on disk, with no device at all:

```bash
ohos-perf hap app.hap --out ./hap-report
```

Analyze a captured scene offline — no device or toolchain needed:

```bash
ohos-perf analyze ./scene --app com.example.app --json
```

Write a human-readable report bundle from the same analysis:

```bash
ohos-perf report ./scene --out reports/run1 --baseline ./before
```

`report.html`, `report.json`, `summary.json`, `metrics.csv`, `evidence.csv` and
`report.xlsx` are written in one pass. The HTML is one self-contained file with
no scripts and no network access; every metric keeps its provenance and
fidelity, and an analyzer skipped for a missing capability appears as a
`degraded` section with its reason instead of disappearing. The same scene and
package version produce byte-identical files. `--baseline` adds the typed
comparison to every artifact.

Follow an evidence item's `drillDown` handle — list the query names and their
argument schemas first, then pass the handle's `tool` and `args` verbatim:

```bash
ohos-perf tools --json
ohos-perf query ./scene frames.get \
  --args '{"id":42}' --json
```

The frame-load handles take a nanosecond range, so a top-frame evidence item's
drill-downs are one command each:

```bash
ohos-perf query ./scene frames.fpsSeries \
  --args '{"startNs":0,"endNs":5000000000}' --json
ohos-perf query ./scene frame.load.symbols \
  --args '{"startNs":1000000000,"endNs":1100000000}' --json
```

## Scenarios

One capture is one window. When the window has to *contain* something — a tap,
a swipe, a launch — write the sequence down instead of typing it in two
terminals:

```json
{
  "version": 1,
  "name": "image-open",
  "description": "open the viewer and measure the first frame",
  "app": "com.example.image",
  "rounds": 2,
  "steps": [
    {
      "id": "open",
      "name": "Open the viewer",
      "setup": [
        { "kind": "launch", "ability": "EntryAbility" },
        { "kind": "wait", "ms": 1500 }
      ],
      "actions": [
        { "kind": "click", "x": 500, "y": 800 },
        { "kind": "marker", "name": "image-requested" }
      ],
      "cleanup": [{ "kind": "forceStop" }],
      "capture": { "durationMs": 5000, "collectors": ["hitrace", "procfs", "hilog"] }
    }
  ]
}
```

```bash
ohos-perf run scenario.json --out runs/image-open --json
```

The document is validated whole before the first device call: an unknown key, a
duplicate step `id`, a collector outside `hitrace|hiprofiler|procfs|hiperf|hidumper|uitest|hilog|thermal`,
`hiprofiler` and `hitrace` together, a duration outside `(0, 2^31-1]` ms — each
is an error naming the JSON path (`steps[0].capture.collectors[1]`), so a
scenario that would fail on step 3 never fails after two captures have run.
`id` is a directory name, so it is restricted to `^[a-z][a-z0-9_-]*$`.

Each step runs three phases, all of them actually executed:

- `setup` runs **before** the capture starts — get the app into the state you
  want to measure without paying for it in the trace. A setup failure fails the
  step before any collector starts.
- `actions` run **inside** the capture window, concurrently with the
  collectors, so the gesture that causes the work is in the trace. A failed
  action fails the step and **keeps the scene**: the trace is a real
  measurement of what the device did while the action was attempted.
- `cleanup` runs after the capture, always — including after a failed action.
  Its own failure marks the step failed but never masks the first error.

Actions are `launch`, `forceStop`, `click`, `swipe`, `key`, `text`, `inputText`,
`wait`, `marker`, and the four selector actions `tap`, `tapText`, `swipeArea`
and `inputInto` (below). The gesture actions go through the same `uitest uiInput`
path as `ohos-perf gesture`, and `launch`/`forceStop` are `aa start` /
`aa force-stop`; a non-zero exit fails the action with the device's own
message. `marker` makes **no device call**: it records a named instant
(`atMs`, host clock) in `steps.json` so a gesture can be correlated with the
trace window it landed in. It is an annotation, not a trace event — there is no
marker injection on the device. `atNs` (device uptime) is recorded when the
device allows `cat /proc/uptime`; neither the Mate 60 nor the emulator does,
and the field is omitted rather than fabricated.

The run directory is a tree of ordinary scenes:

```
runs/image-open/testInfo.json     # scenario, app, device, rounds, status, duration
runs/image-open/steps.json        # one entry per (round, step): status, scene, actions
runs/image-open/pids.json         # pidof, resolved once at run start
runs/image-open/open/round-1/     # a complete scene — analyze/report/query it directly
runs/image-open/open/round-2/
```

Every step directory is a scene, so `ohos-perf report runs/image-open/open/round-1`
is the report for that step — there is no separate per-step reporting path. Each
`scene.json` also carries a `step: { round, index, id }` block, so a scene
copied out of a run still says where it came from. The runner never analyzes:
`run` is HapRay's `prepare` mode by construction.

`--rounds <n>` overrides the document's `rounds`; each round re-runs every step
in file order. `--only open,scroll` runs a subset (still in scenario order; an
id that matches no step is an error naming the available ones). Fail-fast is the
default: the first failed step stops the run and the exit code is 1 — with
`steps.json` and `testInfo.json` still written, because a run that stopped on
step 2 must say what step 1 produced. `--keep-going` continues after a failure;
the exit code is still 1. A collector the device lacks fails that step with the
capability matrix's reason and the message names the step.

### Selectors: tap what the screen says, not a coordinate

A coordinate is a claim about one resolution. A selector is a claim about the
screen's content, which is what a scenario means to say. This is one step of
the document above:

```json
{
  "id": "open-settings",
  "actions": [
    { "kind": "tapText", "text": "Settings", "scrollTo": { "kind": "type", "type": "List" } },
    { "kind": "tap", "target": { "kind": "id", "id": "search_field" } },
    { "kind": "inputInto", "target": { "kind": "id", "id": "search_field" }, "text": "battery" },
    { "kind": "swipeArea", "area": { "kind": "type", "type": "Swiper" }, "direction": "left" }
  ],
  "expect": {
    "present": [{ "selector": { "kind": "text", "text": "Battery" }, "min": 1 }],
    "absent": [{ "kind": "id", "id": "loading_spinner" }],
    "foreground": true
  },
  "capture": { "durationMs": 3000, "collectors": ["hitrace"] }
}
```

Every selector is one of ten kinds, and it is validated as data with its JSON
path in the message:

| Kind | Matches |
| --- | --- |
| `text` | `node.text`, case-insensitively; substring by default, equal with `exact: true` |
| `id` | `node.id`, exactly |
| `type` | `node.type`, exactly (`Button`, `List`, …) |
| `clickable` | nodes that are `clickable` **and** `enabled` |
| `all` / `any` | intersection / union of a non-empty list |
| `not` | the complement **of its own candidate set** — `all: [text OK, not id x]` means "an OK node that is not x" |
| `index` | the *n*-th match in document order, then top/left/right/bottom |
| `bounds` | matches whose centre lies inside `within: {left, top, right, bottom}` |
| `relative` | matches above/below/leftOf/rightOf the **first** match of `to` |

A selector that matches zero nodes and one that matches two are different
refusals (`SCENARIO_SELECTOR_NO_MATCH` / `SCENARIO_SELECTOR_AMBIGUOUS`), because
the fixes differ. A selected node whose `bounds` did not parse is refused rather
than tapped at `(0,0)`.

`swipeArea` swipes inside the selected component, centred and spanning
`distance` percent of its height (for `up`/`down`) or width (for
`left`/`right`); the default 40 runs from 70% to 30%, so the finger never
starts on the area's edge.

`tap` and `tapText` take an optional `scrollTo`: when the target is not on
screen, the runner swipes that container from 70% to 30% of its height, re-dumps
after each swipe, up to five times. It stops at the list's edge — a swipe that
changes nothing — and the refusal says how many swipes it actually spent, so
"1" and "5" mean different things. A `scrollTo` container that is not
`scrollable` is refused before any swipe. `tap` also takes `timeoutMs`, which
re-dumps every 250 ms until the target appears.

### Assertions: a step's status means the screen

`expect` is evaluated against a fresh dump **after** the actions and **before**
cleanup. `present` holds when a selector matches at least `min` (default 1) and
at most `max` nodes; `absent` holds at zero; `foreground` (default `true`)
holds when the app owns at least one node on screen — so an `expect` block
always checks that the screen is still the app's. Every clause is evaluated
even after one fails, and each outcome lands in `steps.json` as
`{label, ok, actual, detail?}` — so a failed run explains itself without a
second capture. A failed assertion marks the step `failed` and **keeps its
scene**: the capture is a real measurement of the screen the step produced.

This is where we differ from HapRay deliberately: its DSL parses `verify` and
never runs it, so its step status means only that the device accepted a
gesture.

### Many cases: `run --cases`

```bash
ohos-perf run --cases scenarios/ --out runs/suite --filter '^scroll' --json
```

`--cases` discovers every `*.scenario.json` in the directory, sorted by file
stem, and runs each into `<out>/<case-id>/`. `--filter` is an **anchored**
regular expression over the case id. A filter that matches nothing, and a
directory with no case files, are refusals that name what was found — a suite
that silently ran zero cases and reported success is worse than one that stops.
One malformed case file fails that case only; the rest still run. The index is
`<out>/cases.json`:

```json
{ "version": 1, "cases": [
  { "id": "scroll", "status": "ok", "outDir": "runs/suite/scroll", "steps": { "ok": 3, "total": 3 } },
  { "id": "broken", "status": "failed", "error": "…/broken.scenario.json: invalid scenario: …" }
] }
```

The exit code is 1 when any case failed. `--rounds`, `--only` and `--keep-going`
keep their meaning per case.

### Workloads somebody else wrote: `workload`

A scenario is this project's document. A benchmark or another team's harness
publishes its own, and HapRay's `PerfTestCase` publishes one as a
`*.workload.json` beside a `PerfLoad_*.py`. `workload` runs that file unchanged:

```bash
ohos-perf workload search.workload.json --duration 15 --out runs/search --json
```

```json
{
  "bundle": "com.example.music",
  "ability": "EntryAbility",
  "description": "search",
  "setup": [{ "op": "wait", "selector": { "text": "首页" } }],
  "measured": [
    { "op": "tap", "selector": { "hint": "搜索" } },
    { "op": "input", "selector": { "hint": "搜索" }, "value": "electronic" },
    { "op": "repeat", "count": 5, "actions": [
      { "op": "pause", "seconds": 1 },
      { "op": "tap", "selector": { "text": "电子音乐" } }
    ] }
  ],
  "verify": [{ "op": "wait", "selector": { "text": "搜索结果" } }]
}
```

The actions are the published vocabulary: `launch`, `stop`, `tap`, `input`,
`type_keys`, `wait`, `pause`, `key`, `point`, `swipe`, `scroll_to` and a
nesting `repeat`. A selector compares `text`, `id`, `type`, `hint`, `bounds` and
`enabled` with `substring` (the default), `exact` or `regex`, and `index` picks
among matches.

The phase order is the harness's, and the preamble is the part that is easy to
miss: **the app is stopped and launched before `setup` runs**, because the
published plans rely on the harness doing it and a plan whose first action is
`wait` would otherwise start on the home screen and fail at its own first
assertion. `setup` runs before the capture, `measured` runs inside the window
concurrently with the collectors, and `verify` runs after it.

A `setup` failure stops before the capture starts. A `measured` failure
**finishes the capture anyway** — the trace is a record of what the device did
while the action was attempted — and a `verify` failure fails the run without
discarding the scene. A `measured` phase that overruns `--duration` is a
failure that names both numbers: a capture window that closed before the
workload did is not a measurement of that workload.

The plan is validated whole before a device is resolved: an unknown key, an
unknown `op`, a selector with no fields, a `match` that is not one of the three
modes, a `key` outside `Back|Home|Power|<code>`, and a bundle or ability that
is not a bare name (they are interpolated into `aa` commands) are errors naming
the JSON path. The output is an ordinary scene plus `workload.json` — the run
record, with every action's outcome, timing and the device's own message — so
`analyze`, `report`, `query` and `root-cause` apply to it unchanged.

## UI capture and diff

A trace says how fast a frame was drawn. It does not say what was on the
screen. `collect --screenshot` adds the screen itself, and `ui-compare` answers
"what changed between these two captures" both structurally and by pixel:

```bash
ohos-perf collect --duration 5 --out ./before --uitest --screenshot
# drive the app, then capture the state you want to compare
ohos-perf collect --duration 5 --out ./after --uitest --screenshot

ohos-perf ui-compare ./before ./after --out ./diff --json
```

`--screenshot` runs `uitest screenCap` and pulls the result into
`screenshot.png` beside `ui.json`. It is independent of `--uitest`: a
screenshot without a tree is a valid capture, and the analyzer reports the half
that is missing instead of zeros for both. Success is the device tool's own
`ScreenCap saved to` marker, because `hdc` exits 0 even when the device
refuses; the pulled bytes must start with the PNG signature, so a truncated
transfer is a typed error rather than a scene artifact. `scene.json` records
`capture.screenshot: { width, height, bytes }`, and `collect` prints
`screenshot 1260x2720` in its samples line.

The `ui` analyzer reads both artifacts and emits `ui.nodes.count`,
`ui.nodes.clickable`, `ui.nodes.text`, `ui.tree.depth.max`,
`ui.screenshot.width`, `ui.screenshot.height` and `ui.screenshot.dhash`, so a
UI section appears in `report` with the screenshot embedded from
`assets/screenshot.png` — one offline HTML page, no scripts, no network. The
dHash is a 16-character hex string with `unit: 'hash'`, not a measurement.

`ui-compare` writes four files and exits 0 whenever the comparison could be
made — including when the screens are identical — and 1 when it could not (a
missing artifact on one side, or two different screen sizes, which is
`UI_SIZE_MISMATCH`: `bounds` and pixels would be in different spaces, and a
rescaled diff would report layout differences as pixel differences):

| File | What it is |
| --- | --- |
| `ui-diff.json` | the typed diff: both sides' sizes and timestamps, per-node `added`/`removed`/`changed`/`unchanged`, image numbers, changed regions, animation labels and pixel-only regions |
| `ui-diff.html` | the same as one self-contained page, with both marked images |
| `ui-diff-marked-a.png` / `-b.png` | each screen with the changed regions boxed, written by the package's own PNG encoder |

Two comparators answer two different questions:

- **Structure.** Nodes are matched by a computed identity —
  `bundleName|type|id|text`, with `id` and `text` used only when non-empty — not
  by child index. Siblings sharing an identity are paired in document order, so
  an inserted node is one `added` rather than a shift that rewrites every later
  comparison (HapRay's index matching does the latter). Attribute diffs ignore
  HapRay's renderer-state list (`id`, `accessibilityId`, `rsNode`, `frameProxy`,
  `frameRecord`, `contentConstraint`, `parentLayoutConstraint`,
  `user defined constraint`) and suppress a `bounds` change under 5 px; every
  difference records which rule decided it.
- **Pixels.** A 64-bit dHash over a 9×8 box-averaged greyscale (similarity is
  `1 - hamming/64`) plus a bounded pixel diff: both images are downscaled to at
  most 256 px wide and compared channel-wise at a tolerance of 8 of 255, and
  the changed-pixel ratio is reported. Both numbers are in the output with the
  tolerance, because they answer different questions.

Everything is integer arithmetic over a fixed downscale, so identical inputs
produce byte-identical `ui-diff.json` and marked PNGs. The two scenes' own
`capture.startedAtMs` are copied in as inputs; the diff carries no clock of its
own.

The PNG codec is pure TypeScript over Node's `zlib`: it decodes the 8-bit,
non-interlaced colour types the device produces (0 grey, 2 RGB, 4 grey+alpha,
6 RGBA) and encodes RGBA. Palette, 16-bit and interlaced images are refused with
a typed error naming which, never silently mis-decoded. There is no OpenCV, no
Pillow and no native build.

`ui.tree` is the one new query: the raw tree with every attribute the diff
compares, in document order. There is no `ui.diff` query — a comparison is a
file `ui-compare` writes, and no query in this package reads outside the scene
it is given.

**Animation labels.** A region is labelled an animation only when *both* halves
moved inside it: its pixels changed and the tree reports a change there.
HapRay labels on pixels alone, which also fires on a blinking cursor, a video
frame or a system clock — the app never re-rendered those. So `ui-diff.json`
carries three lists, and the difference between the first two is the whole
point: `animations` (both halves agree, with HapRay's severity bands — major
under 50% similar, moderate under 70%, minor under 85%), `pixelOnly` (the
screen moved, the tree did not — reported, never labelled), and
`unmeasuredRegions` (smaller than the 9×8 hash grid, so their detail cannot
survive the hash). A tree change the pixels did not show is a rendering
defect, not an animation, and is left to the tree diff.

What is deliberately not here: a separate `ui_animate.json` artifact (an
animation is a start/end pair of scenes, so it is `ui-compare a b` — the same
computation, one code path), HapRay's animated-region red/blue overlays (its
labels are the part with meaning; a second marked PNG would only restate them),
and `inspector_page_<i>.json` (Hypium's own tree dump; `ui.json` is the single
tree source).

## Static HAP inspection

Every other command starts from a device. A package on disk answers questions
no capture can: what native libraries it ships, which cross-platform framework
it embeds, which assets are byte-identical copies, and which files are larger
than they should be. `hap` reads the archive itself, with no device, no `hdc`
and no extraction to disk:

```bash
ohos-perf hap app.hap
ohos-perf hap app.hap --out ./hap-report     # hap.json + hap.html
ohos-perf hap app.hap --json                 # the typed document

ohos-perf opt app.hap                        # optimization level and LTO
ohos-perf opt libs/arm64/libapp.so --json

ohos-perf agent com.example.app "open settings and enable dark mode"
ohos-perf agent com.example.app "..." --max-steps 20 --model my-model --json

ohos-perf symbols recover libs/arm64/libapp.so libapp.so+0xc8a7c
ohos-perf symbols recover libs/arm64/libapp.so --measure   # naming accuracy
```

The human output names the app, the file count and both sizes, one line per
detected technology with the rule that decided it, the duplicate groups and
wasted bytes, the oversized count, and the ten largest files. On a 72 MB
package with four native libraries it reports `SO (rule SO_Files)`, five
oversized files and the five largest paths in under a second. `--json` prints
the same `HapAnalysis` document `hap.json` writes — including the per-file
inventory — beside the one-row `static.hap` capability matrix.

The ZIP reader is pure TypeScript over Node's `zlib.inflateRawSync` — stored
and deflated entries, CRC-checked on every read. Every entry is verified, not
only the ones a rule happens to read, so `resources/base/` is covered too. It
refuses, by name, what it cannot read honestly: `HAP_NOT_ZIP`,
`HAP_ZIP64_UNSUPPORTED`, `HAP_ENCRYPTED_ENTRY`, `HAP_UNSUPPORTED_METHOD`,
`HAP_UNSAFE_PATH` (an absolute name or a `..` segment) and `HAP_CRC_MISMATCH`
(a corrupt stream is never padded into a plausible wrong file). A malformed
offset is a `HAP_NOT_ZIP` naming the block, never a bare `RangeError`. The
failing command prints `CODE: message`, so an agent can report the code the
skill asks for. Directory entries are counted in neither the file count nor
the size.

Three reports come out of one pass, all deterministic functions of the
archive's bytes:

| Report | What it says |
| --- | --- |
| Inventory | every file's path, uncompressed and compressed size, CRC32, lowercase extension and a category from HapRay's own table (images, videos, audio, fonts, scripts, styles, binaries, bytecode, data, other), sorted by path |
| Technology stack | one match per rule that hit, with the rule id, type, confidence, matching files and their summed bytes — Flutter, React Native, Hermes, KMP, Compose Multiplatform, Lynx, Qt, Unity, Taro, Weex, Cangjie and the third-party library rules (logan, leveldb, libpag, mmkv, ijkplayer, …), ported from HapRay's `techstack-config.yaml` as typed data |
| Assets | duplicate groups and oversized files |

Duplicates are found without inflating the whole archive: entries are grouped
by `(size, crc32)` — a pair only equal content can share — and only groups with
two or more members are inflated and hashed with SHA-256. Two files of equal
size and different content never reach the hash; a CRC collision does, and the
hash then separates them. An oversized file is one strictly above its
category's threshold from HapRay's table (images 1 MiB, videos 10 MiB, audio
5 MiB, fonts 2 MiB, scripts 0.5 MiB, styles 0.2 MiB, binaries 5 MiB, bytecode
2 MiB, data and other 1 MiB).

A rule with `requireMetadata` matches only when its own matched file yields the
metadata — Flutter is a `libflutter.so` that also carries a Dart version
string — so a match never arrives with an empty explanation. An invalid regex
or an unknown rule kind is a `HAP_BAD_RULE` error naming the rule at load time,
not a pattern silently skipped.

The metrics (`static-hap` section, all `exact`, provenance `collector:
'offline'`, `table: 'hap'`) are `hap.files.count`, `hap.size.bytes`,
`hap.size.compressed.bytes`, `hap.techstack.count`,
`hap.techstack.<type>.files`, `hap.duplicates.groups`,
`hap.duplicates.wasted.bytes`, `hap.oversized.count` and
`hap.category.<name>.bytes`. Evidence items carry the rule, the SHA-256 group
or the file path as a key, so two items never collide on one id. `static.hap`
is a capability id with no device rule: a device cannot make a file on disk
readable, so the device matrix keeps its 23 rows.

What is deliberately not here: HapSize's business metrics (ROI, UX scores,
"estimated savings" — none is a measurement), ELF symbol extraction from the
package itself (the rules detect those libraries by filename, and the device's
own `trace_streamer --So_dir` does the symbolizing — see [Symbols](#symbols)),
`arkanalyzer`,
`bjc` and `sql.js` (none is needed to read a ZIP and match names), resource
index label resolution (a `$string:` label stays empty; a wrong label is worse
than none), extraction to disk (the archive is read in memory, so a hostile
entry name cannot escape anywhere) and nested archives (a HAP inside a HAP is
not a package the device would install; the inner file is inventoried as a
file).

## Symbols

A perf capture records addresses. Whether a frame comes out as `dlopen` or as
`libjdimage.so+0x1cce24` depends on two things: whether the conversion was
given the shared objects to read, and whether this package resolves the
frames correctly.

**Resolution.** `perf_callchain.name` is not a symbol — it is a `data_dict`
id. On a measured 26,013-sample capture (484,630 frames, 215 files, 9,681
`perf_files` rows) every frame resolved through `data_dict`, and 46,863
frames carried `symbol_id = -1`. The other 437,767 resolve **exactly**
through `(file_id, symbol_id → serial_id)`, a 100% hit rate. The resolution
order is now:

1. the exact `(file_id, symbol_id)` row of `perf_files`, when it exists;
2. otherwise the `data_dict` text for `name`, which is
   `libfoo.so+0x1cce24` when the recorder saw the address but could not name
   it, and `''` when the id dangles;
3. otherwise the raw `name` column, only for a database with no `data_dict`
   at all — there is no id space to be dangling in.

An earlier version fell back to *the first `perf_files` row of the file* when
the exact pair missed. That fallback invented symbols: 1,972 leaf frames
(753 M weight, **7.14%** of all samples) got the name of whichever symbol
happened to be first in their file. `dlopen` was reported with 6.33 M weight
where its genuine weight is 0.16 M. `dladdr` at 495 M was real, which is
exactly why the defect was invisible without checking.

**What the numbers mean.** `symbol.samples.count` is the sampled weight whose
symbol is a name; `symbol.unresolved.count` is the weight still
`file+0xoffset`; `symbol.unresolved.share` is the latter over all leaf
weight. The first two sum to the window's weight, so nothing goes missing.
Unresolved weight is not an error — it is the recorder being honest about
what it did not know, and a `libfoo.so+0x…` reference is still evidence about
which library was running. On the measured capture it was **9.43%** (2,295
leaves, 994 M).

**Fixing the capture.** `collect --hiperf --so-dir <dir>` passes a host
directory of shared objects to the perf conversion as `--So_dir`, so the
frames it can name come out named at capture time. The request is refused
before the capture starts when it cannot mean anything
(`COLLECT_SO_DIR_WITHOUT_HIPERF`) or names a path that is not a directory here
(`COLLECT_BAD_SO_DIR`). `scene.json` records
`capture.hiperf.symbolized: true`, and the flamegraph header states it, so a
symbolized capture is distinguishable from one that never was.

**Drilling down.** `symbol.stats` takes `startNs` and `endNs` and returns
`{symbol, filePath, samples, share, unresolved}` per leaf, sorted by weight.
Its rows sum to the window's app-thread weight, so `share` totals 100% — a
`perf_sample` whose chain has no frames at all is counted as unresolved
`('', '')` weight rather than dropped, so truncation cannot flatter the
profile. `symbol_stats` and `unresolved_symbol` evidence items name the
heaviest rows and drill into it.

## Root cause

`root-cause` turns the evidence an analysis already produced into a report a
person reads. It is the one command whose output is prose, so the design is
mostly about what the prose is allowed to claim.

```bash
ohos-perf root-cause <scene-dir|report.json> --out <dir> [--baseline <input>] [--offline] [--model <name>]
```

The input is a scene directory — analyzed with the same code `report` uses, so
the two can never disagree about what a capture measured — or a saved
`report.json`, which is read rather than re-analyzed: a document about an old
run has to describe what that run measured, not what today's analyzers would
say about a capture that may no longer exist.

Three artifacts land in `--out`:

| File | Content |
| --- | --- |
| `root-cause.json` | the typed document, schema-versioned like every other artifact |
| `root-cause.md` | the human report: verdict, ranked observations, then any model analysis |
| `root-cause.evidence.json` | the exact prompt a model would be sent, so the turn can be replayed by hand |

**The deterministic half is the product.** HapRay's `--skip-llm` writes
"Pending Agent Inference" placeholders, so its artifact is empty without an
endpoint. Here the evidence is ranked by *our* severities in a total order
(severity, then evidence id, so two runs of one capture produce identical
bytes), and the verdict is the highest finding's own sentence — the analyzer
already said what it measured, and rewriting that would be a second opinion
nobody asked for. `--offline` writes this and never consults an endpoint; a
host with no endpoint configured gets the same report plus a notice on stderr,
rather than a failure.

**Gaps are not findings.** A sparse capture produces a wall of
`degraded_capability` and `no_data` items, and a first version of this command
opened its verdict with "hilog skipped: capability not probed" — which tells
the reader nothing about performance. An observation that reports a gap in the
capture (either of those kinds, or any item carrying no measured signal) is now
counted separately, skipped by the verdict, and named in the totals line. A run
where every observation is a gap says it measured nothing, which is a different
fact from a run that measured and found nothing.

**What the model is allowed to claim.** The prompt carries the ranked
observations *with their ids*, and the answer is checked twice:

- **Citations.** An `evidenceId` the run did not produce is moved to
  `ungrounded` and never presented as measured. A suspect left with no real
  citation is kept — a reader has to see that the model tried and what it
  invented — and marked in place in the Markdown, because a footnote is read
  after the fix has been applied.
- **Names.** A suspect naming a file, symbol, thread or library is checked
  against the vocabulary the evidence actually carried: process and thread
  names, string signal values, and the identifiers the analyzers themselves
  printed in their own explanations. Anything else is listed as ungrounded.

Neither check is semantic — they answer one question, "did the model name
something this run measured?" — and that limit is stated rather than papered
over. Running it against a live endpoint is what found the check's own two
defects: it flagged `ui.json`, `startedAtNs` and `thread_state`, which the
analyzers had printed themselves, and it flagged "Re-run" and "app-level" as
invented names because they contain hyphens.

The turn is sent through an OpenAI-compatible `/chat/completions` call using
the same `OHOS_PERF_AGENT_*` (or `GLM_*`) environment variables `agent` reads. The client
takes a *turn shape* — prompt and answer parser as one value — because a
root-cause answer is JSON prose with citations, and the GUI agent's parser
would reject it for having neither an `action` nor a `done`.

### What moved: `--baseline`

A root cause over one run can say what is wrong. The question a reader actually
asks after a regression is what *changed*, and answering it needs two runs:

```bash
ohos-perf root-cause runs/this-release --baseline runs/last-release --out out/
```

The movement is computed by `buildMovement` in the core package, from the two
runs' metrics and their evidence counts. It lands in the document as
`movement`, in the Markdown as a **What moved** section before the verdict, and
in the model's prompt — where a suspect may cite a metric id in `metrics` only
when its row is `regressed`, `improved` or `incomparable`; an `unchanged` or
`gap` row is not a change, so citing one is recorded as ungrounded. Every row
carries each side's `fidelity`, and a row whose two sides disagree
(`approximate → exact`) says so in the table and the prompt — a percentage read
from an approximate baseline is a weaker claim than two exact ones.

| status | meaning |
| --- | --- |
| `regressed` | the metric moved the wrong way for its known direction |
| `improved` | it moved the right way |
| `unchanged` | it did not move — not an improvement |
| `incomparable` | it moved, but the metric has no known direction; the delta is recorded and no verdict is stated |
| `gap` | one run did not measure it — absent, or a skipped analyzer's degraded proxy |

Three rules are load-bearing:

- **A gap is never a movement.** A metric one run did not emit, or emitted as a
  skipped analyzer's zero, is `gap` on that side. Reading it as an improvement
  ("jank rate fell from 12% to 0") is the defect the whole package exists to
  prevent, so the row carries a reason and no delta at all. The `*.degraded`
  proxy metrics are not rows: they are counted and excluded.
- **The caller owns the direction.** `from` is always `--baseline` and `to` is
  always the input, whatever the two capture times say. `trend` sorts by
  `startedAtNs` because its x axis is time; a movement that did the same would
  silently invert every verdict when a baseline was captured later.
- **No percentage of zero.** A baseline of 0 gives a delta without a
  `deltaPct`; the row is still ranked, and no `Infinity` reaches the JSON.

Two runs for different apps are refused, naming both, before any model is
asked; `--app` names the process inside the input only, so the baseline is
always read as the app its own `scene.json` recorded. HapRay's multi-version
page loads any report files and leaves the filtering to a human reading
dropdowns, and its root cause reads a single run — there is no cross-run
comparison of evidence anywhere in the tree.

### Reading a result as a tool: `--machine-json` and `--result-file`

Every command already has a `--json` document. An agent driving the CLI needs
more than that: a version to check, a success flag it does not have to infer,
and the failure as data rather than a stderr line.

```bash
ohos-perf analyze runs/latest --machine-json
ohos-perf root-cause runs/latest --out out/ --result-file out/result.json
```

Both flags are global, so they go anywhere on the command line.
`--machine-json` replaces the output with exactly one line; `--result-file`
writes the same document to a file (parent directories are created) and leaves
stdout as it was.

```json
{
  "schemaVersion": "1.0",
  "toolId": "ohos-perf",
  "toolVersion": "0.28.0",
  "command": "emulator.list",
  "success": true,
  "exitCode": 0,
  "outputs": { "payload": { "instances": [] } }
}
```

Three rules are load-bearing:

- **`success` is exactly `exitCode === 0`.** It is derived, never accepted, so
  a caller cannot describe a failed run as a successful one. `gate` is the case
  that matters: a failed budget is exit 2, so the envelope says
  `success: false` with **no** `error` — the measurement ran and the news is
  bad. A reader that needs "did the tool run?" reads `error`; one that needs
  "is the news good?" reads `outputs.payload`.
- **`error` is present only when the command could not run**, and its `code` is
  the same token stderr prints first. `CLI_USAGE` covers commander's own
  refusals (a missing required option), which is the one class of failure that
  never reaches a command.
- **No default result file.** HapRay writes `hapray-tool-result.json` into the
  report directory whether or not anyone asked, and a measurement tool must not
  add a file to a scene a reader will diff. Here the file exists only where
  `--result-file` says.

The envelope is camelCase and versioned to match this package's own artifacts,
and `parseToolResult` in `@ohos-perf/core` validates it on the way back in —
unknown `schemaVersion`, another tool's `toolId`, and a `success` that
contradicts `exitCode` are all refused, naming the value. HapRay's
`machine_output.py` only writes.

### Calling the measurements as tools: `ohos-perf mcp`

An agent that speaks MCP should not shell out and parse a line. `ohos-perf mcp`
serves the same commands over stdio, so the agent gets the envelope as
structured content:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ohos-perf_analyze","arguments":{"scene-dir":"runs/latest"}}}
```

```json
{"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","isError":false,
 "content":[{"type":"text","text":"{\"schemaVersion\":\"1.0\", ... }"}],
 "structuredContent":{"schemaVersion":"1.0","toolId":"ohos-perf", ... }}}
```

- **The tool list is the CLI.** One tool per command, named
  `ohos-perf_<path>` — `ohos-perf_analyze`, `ohos-perf_emulator_list`,
  `ohos-perf_ui_compare`. Each tool's `inputSchema` is that command's own
  options, and each description is the command's own description, so the two
  surfaces cannot drift: `tools/list` is derived from the commander program at
  startup. `--json`, `--machine-json`, `--result-file`, `--help` and
  `--version` are not exposed; a tool call always wants the envelope. Neither
  is `mcp` itself — it is the transport the client is already talking over, and
  a tool that spawned a second server reading a stdin nobody writes would hang.
- **A tool call is a CLI run.** The server spawns `ohos-perf <command>
  --machine-json` and returns what came back, so an MCP answer is byte-identical
  to the shell answer. Nothing re-implements a command.
- **Required means required.** A `requiredOption` (`collect --duration --out`)
  is in the schema's `required` list, so a client cannot build a call that
  fails with a usage error the schema could have prevented.
- **A list is a list.** A variadic positional and a repeatable option are
  `array` of `string`, and an array given to `--label` becomes one flag per
  item, so `trend` gets one label per report rather than the single value
  `"a,b"`.
- **A value is never a flag.** Positionals sit after `--`, so a
  `scene-dir` of `--result-file=/tmp/x` is a path the command will not find,
  not an option the CLI obeys. Values are type-checked against the schema
  (`{"procfs": "true"}` is refused, not silently dropped), and every request
  with an id gets an answer — including one where the call path throws.
- **`initialize` negotiates.** A client on `2025-06-18` is answered
  `2025-11-25` and continues; `-32022` is only for a per-request version the
  server does not speak. `ping` is answered, and a document that parsed but is
  not a request is `-32600` under its own id.
- **The schema is enforced, not just declared.** An argument the tool does not
  declare is `-32602` naming it, so `{"scene-dir": "/s", "basline": "/b"}` — one
  letter — is refused instead of silently running without a baseline and
  reporting success.
- **`isError` means the command could not run**, matching the envelope's
  `error`. A failed `gate` is `isError: false` with
  `structuredContent.outputs.payload.status === "fail"`: the measurement ran
  and the news is bad. Tools are annotated from the command's own reach:
  `readOnlyHint` for the analyzers that only read a scene, and
  `destructiveHint`/`openWorldHint` for the six that act on a device
  (`collect`, `gesture`, `run`, `explore`, `agent`, `emulator`), so a client
  can ask before it taps something.
- **Both protocol eras.** The server answers the modern revision (`2026-07-28`,
  which removed the `initialize` handshake in favour of per-request
  `_meta` metadata plus a mandatory `server/discover`) and the legacy one
  (`2025-11-25`, which opens with `initialize`). A client that predates the
  change should not have to be upgraded to be measured. An unknown version is
  refused with `-32022` and the list of versions the server does speak.
- **No dependency.** The framing is newline-delimited JSON-RPC 2.0 — about 150
  lines — rather than a 7 MB SDK, because this package's promise is no native
  build step and no bundled binary.
- **One line in, one line out.** stdout carries only JSON-RPC; diagnostics go
  to stderr. A line that is not JSON is a `-32700` error and the session
  continues, and a notification is answered with silence, as the spec requires.

The MCP surface is how an agent reaches the tools; the skill
(`skill/ohos-perf/SKILL.md`) is how it knows which one to call.

## Budgets and the gate

`compare` says what moved between two runs. A budget says how much a movement
is allowed, and `gate` turns that into an exit code a CI job can read.

```bash
ohos-perf gate budgets.json <scene-dir|analyze.json> [--baseline <input>] [--out <dir>] [--json]
```

A budget document is versioned data, committed beside the code it gates:

```json
{
  "schemaVersion": 1,
  "name": "open-app",
  "budgets": [
    { "id": "frame.jank.rate", "max": 5 },
    { "id": "frame.fps", "min": 55 },
    { "id": "frame.avg.duration", "maxDeltaPct": 5 }
  ]
}
```

Exactly one bound per entry: `max`/`min` are absolute limits in the metric's
own unit, `maxDelta`/`maxDeltaPct` are limits on the movement from `--baseline`
(and a negative delta limit is legal — it says the metric must fall by at
least that much). The document is validated whole before a scene is opened: an
unknown key, a duplicate metric id, an entry with zero or two bounds, and a
delta budget with no `--baseline` are all errors that name the JSON path (or,
for the missing baseline, the budget ids and the flag to add), so a budget typo
never fails after a two-minute capture.

**A metric that was not measured is a failure.** This is the whole design. A
metric the run never emitted is `missing`, a degraded proxy is `missing`, and a
percentage against a zero baseline is `missing` — none of them pass. A gate
that goes green because an analyzer stopped running, or because a capability
was absent on the device, is worse than no gate at all. The verdict line
carries the reason, so the build output says "the run emitted no
`thermal.samples.count`" rather than pointing at a threshold.

Exit codes: `0` every budget passed, `2` a budget failed or a metric it names
was not measured, `1` the gate could not run (a bad document, an unreadable
input, a delta budget with no baseline). `2` is a verdict and `1` is an error;
a CI job that conflated them would swallow its own misconfiguration. `--json`
still exits 2 on a violation, because the verdict is the artifact and the code
is how a shell reads it; `--out` writes `gate.json` alongside it.

HapRay's regression story at its pinned revision is `PerfMulti.vue`: a page
that draws a line per metric across whatever reports a person selects, with no
threshold, no verdict and no exit code anywhere in the tree. A budget is the
same measurement turned into a claim a job can check.

## Model-guided exploration

`explore --model <name>` lets a model choose the walk's steps. The interesting
question is not whether a model can pick a button — it can — but what happens
when it picks one that does not exist.

```bash
ohos-perf explore <app> --model <name> [--max-steps <n>] [--strategy depth_first|breadth_first|random]
```

**The model chooses among offered elements, and nothing else.** Each turn
carries the rendered screen, the clickable elements the dump actually produced
(indexed in order, with their bounds), the last eight steps, and only the
actions the screen allows. An answer names one of those indexes, or `scroll`,
`back` or `stop`. The answer is checked against the offer before the device
sees it: an index outside the range, an unavailable action, a non-JSON reply,
an unknown action name or a malformed field becomes a recorded refusal naming
the step and the reason, and that step falls back to the deterministic order.
HapRay's `llm_strategy.py` is the same decision without the check — an index
past the end of its element list clicks element 0, an unparseable answer clicks
the first element, and a failed call clicks the first button — so a stuck
model and a busy one produce the same report.

**Page identity is measured, not asked.** HapRay runs a second model call per
transition (`llm_state_comparator.py`) to decide whether the screen changed,
and that opinion decides whether the step counted. Here identity is
`hashPageShape`, a digest over each node's bundle, ability, depth, type and
three boolean traits — labels and bounds are left out, so a clock ticking in a
text field or a scroll that moves existing content does not read as a new
page. Comparing the
digest before and after a step yields three outcomes: `navigated` (a new page),
`updated` (the same page changed in place, e.g. a checkbox toggled) and
`no change`. The screen and page counts, and the trail, are computed from those
digests; a report of "12 screens" cannot be inflated by a model's opinion.

**Navigation is bounded and measured.** When nothing unvisited is tappable the
walk scrolls the first scrollable node of the target app, up to three times on
one screen, then returns one level with `back`, at most once per screen; the
trail is rebuilt from the page measured after each move, so a tap that lands on
an earlier page rewinds it exactly as a back would. A scroll that does not
change the page is not progress. A screen that belongs entirely to another
bundle is not acted on at all — no tap and no swipe of its lists; the walk
backs out, or stops with `left_app` when it cannot. The caps apply to
model-chosen scrolls and backs too, so a model cannot loop them, and the walk
stops only for one of four measured reasons: the budget, an exhausted screen,
the model's `stop`, or having left the app with no way back.

**The model cannot invent a gesture.** It never supplies coordinates: it names
an element the dump produced, and the gesture is driven to that element's
measured bounds. When a model steers, targets whose text matches the
irreversible patterns (payment, ordering, transfer, sign-in, delete) are
filtered out of the offer entirely — not discouraged in a prompt sentence — and
the deterministic fallback draws from the same filtered set. `--json` carries
`model` field by field: how many choices were used, how many refused, and
each refusal with its step, so a run reads as "the model chose 14 steps and 3
were refused", never as a silent correction.

The endpoint is the one `agent` and `root-cause` use:
`OHOS_PERF_AGENT_BASE_URL`/`_API_KEY`/`_MODEL`, falling back to HapRay's
`GLM_*` variables. Without `--model` the command is fully offline and
deterministic, as before.

## Emulators

`ohos-perf emulator` drives the `Emulator.exe` that DevEco Studio installs, so a
run with no physical device still has something to measure.

```bash
ohos-perf emulator list                 # name, running state, target, API, image
ohos-perf emulator start ProbePhone     # waits until the guest has booted
ohos-perf emulator stop ProbePhone
ohos-perf emulator create SpecProbe \
  --device-type phone --os-version 'HarmonyOS 6.1.1(24)' --memory 6 --storage 8
```

`list` is the handoff to capture: `--json` prints each instance's `target`, and
that id goes straight to `collect --target` (or `caps`/`doctor --target`), which
otherwise picks the first connected device — wrong when a phone and an emulator
are both attached:

```bash
TARGET=$(ohos-perf emulator list --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).instances[0].target))')
ohos-perf collect --target "$TARGET" --app com.example.app --duration 10s --out ./scene
```

`target` is absent when the instance is not running, or when attribution is
ambiguous — more than one instance running, no connected TCP target, more than
one connected TCP target, or `hdc` unusable. `targetReason` on that instance
says which (it is a `--json` field; the human table shows `—`). Start the
instance first, or pass the id from `hdc list targets` yourself.

`start` blocks until `bootevent.boot.completed` reads `true` on the guest, so a
capture never races the boot. It takes `--timeout <seconds>` (default 180) and
reports how long the whole call took — the 3 s window it gives `-start` to
report an immediate failure is included, so a warm start reads a few seconds
longer than the guest's own boot. Starting an instance that is already up is a
safe no-op that says so. A timeout never kills the emulator — the message names
the `stop` command that removes it. Two `start` calls running at once are not
supported: the binary exposes no per-instance port, so each call attributes the
one fresh loopback target it sees, and the two can report each other's.

`create` never downloads an image. It refuses when no image for that
`--device-type`/`--os-version` pair is already downloaded, and prints the exact
`Emulator.exe -install …` command to run first.

Path discovery, for both the binary and the instance/image roots, is: an
explicit flag (`--emulator`, `--instance-path`, `--image-root`), then an
environment variable (`OHOS_PERF_EMULATOR`, `OHOS_PERF_EMULATOR_INSTANCE`,
`OHOS_PERF_EMULATOR_ROOT`), then DevEco's `.emu_config` (which is what
redirects the roots on a machine that moved them off `%LOCALAPPDATA%`), then
the default install and `%LOCALAPPDATA%` locations.

Unlike `analyze`, these four commands are **not** byte-deterministic: `--json`
promises stable key and array order, and `waitedMs` is wall-clock. They are
lifecycle operations on a real machine, not measurements.

## Development

```bash
git clone https://github.com/growvv/ohos-perf.git
cd ohos-perf
npm install

npm test        # 1483 tests; 1448 pass + 35 skip on a clean checkout (no device, spike/out/ absent)
npm run typecheck -w @ohos-perf/core   # src + tests, the same check CI runs
npm run typecheck -w @ohos-perf/cli
```

`npm test` builds both packages first, so a clean checkout is never red.

## Library

```ts
import { connect, FrameQuery, ProcessQuery, FrameAnalyzer } from '@ohos-perf/core';

const device = await connect();                  // hdc + probe + capability matrix
const caps = await device.capabilities();

const scene = await device.collect({
  app: 'com.example.app',
  durationMs: 10_000,
  sceneRoot: 'scenes/demo',
}).ingest();                                     // hitrace → trace_streamer → trace.db

const result = await new FrameAnalyzer().run({
  frames: new FrameQuery(scene.traceDb),
  processes: new ProcessQuery(scene.traceDb),
  app: { packageName: 'com.example.app', pids: [], processNames: [] },
  window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
  caps,
  deviceId: device.id,
});

console.log(result.metrics);    // Metric[] with provenance + fidelity
console.log(result.evidence);   // Evidence[] with drill-down ids
scene.close();
```

## Capability matrix

Measured on 2026-11-16/17 (Mate 60) and 2026-11-17 (emulator), re-run for
`0.9.0` with the new `ui.capture` row:

| Device | Available | Notes |
| --- | --- | --- |
| HUAWEI Mate 60, OpenHarmony 7.0.0.111, arm64-v8a | **21 / 23** | hardware PMU, hiprofiler (including `memory-plugin`), uitest, `ui.capture` (a real `screenCap` PNG), `hilog`, `ui.gesture` (driven through `uitest uiInput`) and Ark-runtime trace events present; `coverage` unavailable — no `bjc_cov` on the device and no collector in this package consumes its output; `js.heap` unavailable — no analyzer consumes `js_heap_*` tables, and `hidumper --mem-jsheap` needs a debug-signed or profilerable app |
| HarmonyOS emulator 6.1.1.125, x86_64 | **14 / 23** | no hiprofiler, so `mem.native_hook`, `mem.gpu`, `power.xpower`, `net.io`, `disk.io` and `startup.app_startup` are out; `perf.pmu` has no hardware events; `render.fps_live` is a `proxy`. `trace.ark` is available because `hitrace` records the `ark` and `ace` categories, `hilog.stream` because the image ships the `hilog` binary, and `ui.capture` because its `uitest screenCap` produces a decodable PNG. `ui.tree`, `ui.gesture` and `ui.capture` are measured by a live `caps` run; a matrix built from the committed probe snapshot reports 12 / 23 instead, because that snapshot predates the `hilog` row, the separate `uitest dumpLayout` measurement and `ui.capture` |

`0.10.0` adds `static.hap` to the capability ids but not to this matrix: a
device cannot make a package on disk readable, so it has no probe rule and the
23 device rows are unchanged.

A missing capability is a value with a `reason` — never a silent zero. See
[`packages/core/src/device/capability.ts`](packages/core/src/device/capability.ts)
for the full rule set. Offline `analyze` builds its own matrix from the tables
present in `trace.db` (and `procfs.jsonl`); when `scene.json` exists, its
`capture.collectors` decides whether memory samples are trusted, so a re-capture
without `--procfs` can never report the previous capture's `mem.*` as exact.
A `scene.json` that exists but is malformed, of the wrong version or missing
required fields is treated as untrustworthy rather than as "no metadata": only
a genuinely absent descriptor lets a hand-built scene's `procfs.jsonl` be used.

The offline matrix gates each capability on every table its analyzers read
without a `hasTable` guard — for `trace.binder`, that is `callstack`, `args`,
`data_dict`, `process`, `thread` and `trace_range`. A synthetic database that
lacks any of them is reported as a `degraded` proxy, never run far enough to
crash: a crash is not the documented answer to missing input.

## Architecture

```
L7  API / CLI / Skill      programmatic API · ohos-perf CLI · agent skill (skill/ohos-perf/)
L6  Report                 Metric · Evidence · provenance · fidelity
L5  Analyze                frames · frame load · fault tree · binder · threads · memory · memory measure · native memory · hilog · startup · render · gc · vsync · empty frame · rs skip · flamegraph · components · ui
L4  Query                  typed accessors over 88 trace tables
L3  Ingest                 trace_streamer wrapper · scene layout · scene.json · db handles
L2  Collectors             hitrace · procfs · hiprofiler · hiperf · hidumper · uitest · screenshot · hilog
L1  Device                 device model · capability probe · matrix · emulator lifecycle
L0  Transport              hdc client
```

## Guarantees and tests

- **Determinism**: `e2e-offline` asserts two runs over the recorded emulator trace are
  byte-identical, and that evidence ordering is explicit rather than incidental.
- **Real data**: the recorded trace pins measured values — 169 actual frames,
  161 rendered, 60 stuttered, jank rate 37.267%, 60 jank evidence items with 60
  distinct ids.
- **Failure is never success**: non-zero exits, signal death, missing success
  markers, `[Fail]` on transport stdout and stale dist bundles all fail loudly.
- **Mutation-tested**: 22 deliberate defects were injected during review; each
  surviving one was given a test that now kills it.

## 中文简介

ohos-perf 是一个面向鸿蒙（HarmonyOS / OpenHarmony）的性能分析基础包，使用
TypeScript 编写。它把设备能力探测、hitrace 采集、trace_streamer 入库、类型化
查询、帧指标与证据图串成一条可复现的链路，并提供一个输出稳定 JSON 的 CLI，
方便开发者、CI 与 Agent 直接调用。

三个核心承诺：

1. **不编数字**：能力缺失带原因，指标带 `fidelity` 与 `provenance`。
2. **确定性输出**：同一输入两次运行字节一致，CI diff 有意义。
3. **零原生依赖**：只用 Node 内置 `node:sqlite`，无编译、无 Python。

当前 P0–P16 均已实现：hdc 传输、能力矩阵、hitrace / procfs / hiprofiler / hiperf /
hidumper / uitest / screenshot 采集、trace_streamer 入库（含 perf.data → perf.db）、类型化查询、
帧 / 故障树 / binder / 线程 / 内存 / 内存测量 / 启动 / 渲染 / GC 压力 / VSync 异常 /
空帧 / RenderService 跳过 / 火焰图 / 符号统计 / 组件复用 / UI 树与截图共十九个分析器、降级指标引擎、证据图与
命名下钻查询、基线对比、通过 `uitest uiInput` 注入点击 / 滑动 / 按键 / 文本的
`gesture` 命令，以及 `doctor` / `caps` / `collect` / `analyze` / `query` / `tools` /
`compare` / `ui-compare` / `hap` 命令、`emulator` 生命周期命令、`run` 场景运行器和
`skill/ohos-perf/` 中的 agent skill
适配器。内存测量
（`mem.measure.*`）来自 hiprofiler memory-plugin 记录的 `process_measure` 表，
以 ipid 归属进程、把 KiB 换算成字节后报告 exact 的 RSS 峰值与均值；无应用采集时
不带进程归属，显式降级而不是把全设备的行算到应用头上。录制的真实 trace
已将 binder、线程与故障树分析器的逐字段输出与 HapRay 修订 `9386e4e` 对齐；线程评分与
组件复用另有一个由 HapRay 生成的合成 golden，专门覆盖真实 trace 拿不到的路径——前者
需要冗余线程模式，后者需要 `H:CustomNode:Build*` 事件，而两条 trace 都没有。VSync、
空帧与 RenderService 跳过在各自测试中复现 HapRay 的每条规则与误报过滤，其输出也对着
HapRay 在两条录制 trace 上核对过。内存、启动、GC 与火焰图没有能在这些 trace 上运行的
HapRay 实现，不声称对齐。`ui.gesture` 以设备工具打印的 `No Error` 为成功标志——hdc
的退出码即使设备端失败也恒为 0——坐标、速度与按键在到达设备前就会校验，速度超出
200–40000 会被拒绝而不是让设备悄悄回退到默认值。`coverage` 仍不可用：Mate 60 上
没有 `bjc_cov`，且本包没有采集器消费它的输出，能力矩阵会据实给出该原因；`js.heap`
即使在能运行 hiprofiler 的真机上也不可用，因为本包没有任何分析器消费 `js_heap_*`
表，且实测 `hidumper --mem-jsheap` 需要 debug 签名或可被 profile 的应用。`--app`
仅对需要解析 pid 的采集器必填；`--hidumper`、`--uitest`、`--screenshot`
与 `--hiprofiler --plugins memory` 可以无应用采集。

UI 采集与对比：`collect --screenshot` 通过 `uitest screenCap` 把整屏 PNG 拉回场景，
以设备工具自己打印的 `ScreenCap saved to` 为成功标志，并校验 PNG 签名，因此被截断的
传输是类型化错误而不是场景产物。`ui-compare <a> <b> --out <dir>` 按节点身份
（`bundleName|type|id|text`）匹配树节点，而不是按子节点下标——插入一个节点只产生一条
`added`，不会让后面每个节点都错位——同时报告 64 位 dHash 相似度与有界像素差异（两侧
缩放到最多 256 px 宽，通道容差 8/255），并写出 `ui-diff.json`、`ui-diff.html` 与两张
标注后的 PNG。PNG 编解码是纯 TypeScript（基于 Node 内置 `zlib`），没有 OpenCV、
Pillow 或原生编译；不同分辨率的两张截图会被 `UI_SIZE_MISMATCH` 拒绝，而不是悄悄缩放。
HapRay 的动画分级（dHash 阈值）刻意不移植：阈值未经验证且与分辨率相关，而“这块区域
在动”不是性能指标。

优化检测：`ohos-perf opt <package|lib.so>` 读每个 arm64 库的 ELF，报告文件自己记录的
事实 —— 从 `lto_priv.*` 符号与 `.gnu.lto_*` 节读出 LTO，从 `.comment` 里的 `-O` 标志读出
优化级别，两者都没有时再从指令构成推断，标为 `proxy` 并列出所依据的信号。HapRay 用约 2 GB
的 TensorFlow LSTM 与 551 维 SVM 回答同样两个问题，把猜测印成百分比；在它自己的测试
`libflutter.so` 上两个工具结论一致（高优化、无 LTO），而这里会说明哪一半是测出来的。
不落地解压，也不随包分发模型。

静态 HAP 检查：`ohos-perf hap <package.hap>` 用纯 TypeScript 的 ZIP 读取器（基于
Node 内置 `zlib`）把安装包读进内存，按 HapRay 自己的扩展名分类表清点每个文件，用
`techstack-config.yaml` 的类型化移植识别技术栈，并报告重复资源（先按 `(size, crc32)`
分组，只对成员不少于两个的组做 SHA-256 确认）与超过分类阈值的文件。每个匹配都带上做出
判断的规则 id；带 `requireMetadata` 的规则只有在被匹配文件本身能取到元数据时才算命中
（Flutter 是同时带 Dart 版本串的 `libflutter.so`），绝不会给出空解释。`--out` 写出
`hap.json` 与离线 `hap.html`，全程不接触设备、不落地解压。刻意不做：HapSize 的 ROI /
UX 评分 / “预计节省”等商业指标（都不是测量值）、从安装包里自行提取 ELF 符号（符号化交给设备
自己的 `trace_streamer --So_dir`，见下）、`resources.index`
标签解析（`$string:` 标签保持为空，错误的标签比没有更糟）、嵌套压缩包。

符号：`perf_callchain.name` 不是符号名，而是 `data_dict` 的 id。实测一次 26,013 个采样、
484,630 个栈帧、215 个文件的采集：全部栈帧都要经 `data_dict` 解析，其中 46,863 帧的
`symbol_id = -1`，其余 437,767 帧通过 `(file_id, symbol_id → serial_id)` **精确命中**
（命中率 100%）。早先的实现在精确配对失败时会退回该文件的第一个 `perf_files` 行，这会
编造符号：1,972 个叶子帧（7.14% 的权重）被冠上文件里恰好排第一的符号名，`dlopen` 被
报成 6.33 M，真实权重只有 0.16 M。现在只走精确配对，再退回 `data_dict` 文本
（`libfoo.so+0x1cce24`，或悬空 id 的 `''`）。无法命名的叶子权重单独报为
`symbol.unresolved.*`（实测 9.43%），与已命名权重之和等于窗口总权重。采集时加
`--hiperf --so-dir <目录>` 可让设备在转换时直接符号化；`report` 会额外写出
`flamegraph.svg` 与 `flamegraph.html`。

根因报告：`ohos-perf root-cause <场景目录|report.json> --out <目录> [--baseline <输入>]` 把分析已经产出的
证据变成一份人读的报告，产物是 `root-cause.json`（带 schema 版本的类型化文档）、
`root-cause.md`（结论、按严重度排序的观测、以及可选的模型分析）与
`root-cause.evidence.json`（模型实际会收到的提示词，可手工重放）。**确定性的那一半就是
产品**：HapRay 的 `--skip-llm` 只写 "Pending Agent Inference" 占位符，没有端点时产物是空的；
这里按本包自己的严重度做全序排序（严重度、再按证据 id，同一场景两次运行字节一致），
结论取最高严重度那条观测自己的句子。`--offline` 完全不碰端点；没有配置端点时同样写出
这份报告并在 stderr 说明，而不是失败。报告里的“缺口”不算“发现”：`degraded_capability`、
`no_data` 以及任何不带测量信号的条目都单独计数、不参与结论——实测一个稀疏采集曾让结论
以 "hilog skipped: capability not probed" 开头，那说明的是采集缺了什么，不是应用出了什么问题。
模型能声称什么要经过两道检查：引用的证据 id 必须是本次运行真实产出的（否则移入
`ungrounded`，并在 Markdown 里就地标注，而不是写成脚注）；提到的文件、符号、线程、库名
必须在证据实际携带的词汇里（进程名、线程名、字符串信号值，以及分析器自己在解释里打印的
标识符）。这两道检查都是字面检查而非语义判断，这个边界会写明。用本机网关实测时正是这两道
检查暴露了自身的两个缺陷：它把分析器自己打印的 `ui.json`、`startedAtNs`、`thread_state`
判为捏造，又因为含连字符把 "Re-run"、"app-level" 判为名字。

跨轮根因：`root-cause <本轮> --baseline <上一轮>` 回答“这次回退是哪一项变化引起的”。
`buildMovement` 把两次运行的指标与证据计数合成一份 `movement`：每个指标一行
（`regressed` / `improved` / `unchanged` / `incomparable` / `gap`），外加两边各证据种类的
计数。三条规则是硬性的：**缺口不是变化**——某次运行没有测到、或测到的是被跳过的分析器写下的
降级零值的指标，是 `gap`，带原因、没有增量，因此消失的 jank 率永远不会被读成“从 12% 改善到 0”；
`*.degraded` 代理指标不算行，只计数。**方向由调用者决定**——`from` 永远是 `--baseline`，
`to` 永远是输入，与采集时间无关；`trend` 按 `startedAtNs` 排序是因为它的横轴就是时间，
移动若照做，基线晚于输入时每个判定都会被悄悄反转。**零基线没有百分比**——基线为 0 时
只给增量、不给 `deltaPct`，不会把 `Infinity` 写进 JSON。移动段渲染在结论之前，也进入模型提示词；
suspect 新增的 `metrics` 引用会像证据 id 一样对照移动行核对，没有移动块时任何指标引用都记为
`ungrounded`。两个不同应用的运行在询问模型之前被拒绝并点名（`ROOT_CAUSE_BAD_BASELINE`）。
HapRay 的多版本页把比较留给人在下拉框里挑，它的根因只看一次运行，整棵树里没有跨运行的证据对比。

`--hiperf` 需要可调试应用，空闲应用产生 `samples: 0` 也是一次有效采集，CLI 会明确
打印 `hiperf 0` 而不是省略。`compare` 把每个指标标为 improved / regressed /
unchanged / added / removed / incomparable，其中 `incomparable` 表示方向未知，而不是
没有变化。

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Huawei or the OpenHarmony project. Device names are used for
identification only.
