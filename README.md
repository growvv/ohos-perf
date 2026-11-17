# ohos-perf

**HarmonyOS performance, made measurable.**

[![ci](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml)
[![pages](https://github.com/growvv/ohos-perf/actions/workflows/pages.yml/badge.svg)](https://growvv.github.io/ohos-perf/)
[![license: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg)](LICENSE)

A TypeScript toolkit for HarmonyOS performance analysis. It turns an attached device
into structured, evidence-backed data: capability probing, eight collectors,
`trace_streamer` ingest, typed queries over the resulting SQLite
databases, metrics with provenance, an evidence graph, baseline comparison, and
a CLI designed to be called by agents.

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

**P1 through P14 are complete**: 1395 tests (1385 unit, 10 in the device
project), two workspace typechecks and two builds, all green on the declared
minimum Node (`22.13.0`). On a clean checkout — where the gitignored
`spike/out/emu_big.db` and `spike/out/real_device.db` fixtures and any
attached device are absent — `npm run test:unit` reports **1370 passed, 25
skipped (2 files)**; the device project adds one fixture-backed probe test and
ten device-gated skips, so the combined clean checkout is **1371 passed, 35
skipped**. With both fixtures present and a device attached every test runs.
The fixture-dependent suites are `e2e-offline`, `drilldown-e2e`,
`parity-hapray`, `analyze-thread-wakeup`, `query-binder-startup`,
`query-callstack-perf`, `query-sched-state` and the CLI `index` end-to-end
tests. The eleven tests in the device project are
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
  `screenshot.png`) and hilog (the raw device log stream); every requested
  collector runs concurrently in one `collect`. `--app` is required only by the
  modes that resolve a pid — `--hidumper`, `--uitest`, `--screenshot`,
  `--hilog` and
  `--hiprofiler --plugins memory` capture device-wide without it
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
  `metrics.csv`, `evidence.csv` and a dependency-free `report.xlsx`; identical
  inputs and package version produce byte-identical files, and skipped
  analyzers appear as `degraded` sections with their reason
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
  (`empty_frame.*`), RenderService skips reverse-traced through NativeWindow
  (`rs_skip.*`), folded flamegraph stacks (`flamegraph.*`), ArkUI component
  reuse (`components.*`) and the UI tree and screenshot (`ui.*`), driven by an
  offline capability matrix derived from table presence
- `Metric` / `Evidence` models with provenance, fidelity and drill-down ids,
  plus the degraded-metric engine that skips analyzers whose inputs are absent
- `ohos-perf` CLI: `doctor`, `caps`, `collect`, `analyze`, `query`, `tools`,
  `compare`, `ui-compare`, `gesture {click,swipe,key,input,text}`,
  `emulator {list,start,stop,create}`, `run <scenario.json>`
- emulator lifecycle: `EmulatorClient` (spawn + parse) and `EmulatorLifecycle`
  (state + waiting) drive DevEco's `Emulator.exe`, attributing each running
  instance to its `hdc` TCP target so `collect --target` can use it
- scenario runner: `ohos-perf run scenario.json --out <dir>` validates a
  declarative JSON document before touching a device, then runs its steps in
  order — setup before the capture, actions inside the capture window, cleanup
  after it, always — writing one scene per (round, step) plus `steps.json`,
  `testInfo.json` and `pids.json`. A failed action fails the step and keeps
  its scene; `--keep-going` continues, and the exit code is 1 either way.
- UI capture and diff: `collect --screenshot` pulls a PNG beside the tree;
  `ui-compare <a> <b> --out <dir>` reports structural tree changes by node
  identity and pixel changes by dHash and a bounded diff, with two marked PNGs
  and an offline HTML page. A pure-TypeScript PNG codec does the decoding, so
  no OpenCV, Pillow or native build is involved.

Metric ids emitted by the analyzers:

| Prefix | Analyzer | Examples |
| --- | --- | --- |
| `frame.*` | frames | `frame.jank.rate`, `frame.fps`, `frame.stutter.level2.count`, `frame.fps.window.max` |
| `frame.load.*` | frame load | `frame.load.total`, `frame.load.top10.share`, `frame.load.span.weight` |
| `fault.*` | fault tree | `fault.arkui.HandleOnAreaChangeEvent`, `fault.RS.DisplayNodeSkipTimes` |
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
| `rs_skip.*` | RenderService skips | `rs_skip.frames.count`, `rs_skip.trace.accuracy` |
| `flamegraph.*` | folded stacks | `flamegraph.app.share`, `flamegraph.stacks.count` |
| `components.*` | component reuse | `components.reuse.rate`, `components.top.name` |
| `ui.*` | UI tree and screenshot | `ui.nodes.count`, `ui.nodes.clickable`, `ui.tree.depth.max`, `ui.screenshot.width`, `ui.screenshot.dhash` |

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

Measured on the two recorded traces, `analyze` reports 75 metrics and 95
evidence items on `emu_big` (20.8 MB) and 74 metrics and 181 evidence items on
`real_device` (13.1 MB). Four of the older analyzers report real numbers there:
`vsync.signals.count` 60 with `vsync.periods.count` 7 and `vsync.anomaly.rate`
101.67 on `emu_big` (0 / 0 / 0 on `real_device`), `empty_frame.count` 6 with a
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

Not implemented yet: `coverage`. It was
measured, not assumed: `bjc_cov` is absent from the Mate 60 (`which` finds
nothing and `aa` prints nothing over plain shell), and even a device that has it
would not make the capability usable — no collector in this package consumes
its output, so the matrix reports that reason instead of claiming the data
exists. `js.heap` stays unavailable even on a device whose hiprofiler can run
the memory plugin: nothing in this package consumes the `js_heap_*` tables, and
the measured `hidumper --mem-jsheap` route needs a debug-signed or profilerable
app, which the release apps on the Mate 60 are not.

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
| P15 | W7 static HAP | offline HAP inventory, tech-stack fingerprints, duplicate/oversized assets, report section | planned |
| P16 | W8 symbols | symbol statistics, `--so-dir` device symbolization, offline flamegraph artifact, unresolved-symbol evidence | planned |

The parity scope comes from a source-level inventory of ArkAnalyzer-HapRay
(rev `9386e4e`): 35 user-facing capabilities, of which 13 are now ported, 10
partial and 12 missing. The inventory read 6 / 9 / 20 at `0.3.0`; `0.6.0`
reported 9 / 9 / 17 after the XLSX suite (row 34), frame load (row 9) and
native memory (row 19) moved to ported; `0.7.0` moved hilog (row 30) to ported;
`0.8.0` moves run-only preparation (row 2) to ported — the runner is
collect-only by construction — and lifts the step DSL (row 3) from missing to
partial, because a scenario is a validated action list with no selectors and no
loops. `0.9.0` moves UI capture per step (row 7) and UI comparison (row 32) to
ported, and lifts animation analysis (row 31) from missing to partial: a
start/end capture pair is compared by the same tree and image comparators, but
the animation label itself is not emitted — HapRay's dHash thresholds are
unvalidated and resolution dependent, and "this region animated" is not a
performance measurement. Items deliberately not ported (Hypium/xdevice test
execution, the LLM GUI agent, TensorFlow opt-detector, radare2 symbol recovery,
bjc coverage) keep their measured reasons instead of a claim; the scenario
runner replaces the first of them rather than porting it. The rendered
roadmap, with the same content in Chinese, is on the
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

Analyze it offline — no device or toolchain needed:

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
duplicate step `id`, a collector outside `hitrace|hiprofiler|procfs|hiperf|hidumper|uitest|hilog`,
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
`wait` and `marker`. The gesture actions go through the same `uitest uiInput`
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
| `ui-diff.json` | the typed diff: both sides' sizes and timestamps, per-node `added`/`removed`/`changed`/`unchanged`, image numbers, changed regions |
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

What is deliberately not here: a separate `ui_animate.json` artifact (an
animation is a start/end pair of scenes, so it is `ui-compare a b` — the same
computation, one code path), HapRay's animation labels (its dHash thresholds
are unvalidated and resolution dependent, and "this region animated" is not a
performance measurement), and `inspector_page_<i>.json` (Hypium's own tree dump;
`ui.json` is the single tree source).

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

npm test        # 1395 tests; 1371 pass + 35 skip on a clean checkout (no device, spike/out/ absent)
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

当前 P0–P14 均已实现：hdc 传输、能力矩阵、hitrace / procfs / hiprofiler / hiperf /
hidumper / uitest / screenshot 采集、trace_streamer 入库（含 perf.data → perf.db）、类型化查询、
帧 / 故障树 / binder / 线程 / 内存 / 内存测量 / 启动 / 渲染 / GC 压力 / VSync 异常 /
空帧 / RenderService 跳过 / 火焰图 / 组件复用 / UI 树与截图共十八个分析器、降级指标引擎、证据图与
命名下钻查询、基线对比、通过 `uitest uiInput` 注入点击 / 滑动 / 按键 / 文本的
`gesture` 命令，以及 `doctor` / `caps` / `collect` / `analyze` / `query` / `tools` /
`compare` / `ui-compare` 命令、`emulator` 生命周期命令、`run` 场景运行器和
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

`--hiperf` 需要可调试应用，空闲应用产生 `samples: 0` 也是一次有效采集，CLI 会明确
打印 `hiperf 0` 而不是省略。`compare` 把每个指标标为 improved / regressed /
unchanged / added / removed / incomparable，其中 `incomparable` 表示方向未知，而不是
没有变化。

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Huawei or the OpenHarmony project. Device names are used for
identification only.
