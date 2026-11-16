---
name: ohos-perf
description: Measure HarmonyOS app performance on real devices and drill down into captured traces — probe capabilities, collect a scene, read evidence, and follow drillDown handles into frames, callstacks, binder transactions, thread patterns and memory measurements with the ohos-perf CLI.
---

# ohos-perf

Use this skill when a HarmonyOS app must be measured, or when a captured scene
(`trace.db` / `trace.htrace` plus `scene.json`) must be explained. The CLI is
the interface; every command speaks stable JSON with `--json`.

## Workflow

1. Check the toolchain and the attached device: `ohos-perf doctor`
   - When it reports no attached device, boot an emulator instead of giving up:
     `ohos-perf emulator list --json` names the instances, then
     `ohos-perf emulator start <name> --json` blocks until the guest has booted
     and returns its `target`. Pass that id with `--target <id>` to the device
     commands — `collect`, `caps`, `doctor` and `gesture` (e.g.
     `ohos-perf collect --target 127.0.0.1:5555 …`). The scene-reading
     commands (`analyze`, `query`, `compare`, `tools`) take no `--target` and
     reject it.
     `ohos-perf emulator stop <name>` shuts it down again. Never fabricate a
     target: `list` reports `target` only when exactly one running instance can
     be attributed to exactly one connected TCP target.
   - `ohos-perf emulator create <name> --device-type … --os-version …` builds a
     new instance from an image that is **already downloaded**. It never
     downloads one; when the image is missing it exits 1 with the exact
     `Emulator.exe -install …` command to run first.
2. Read the capability matrix before asking for data that may not exist:
   `ohos-perf caps --json`. An unavailable capability is absent by design —
   never invent its metric.
3. Drive the app to the state you want to measure:
   `ohos-perf gesture click 500 800 --json`,
   `ohos-perf gesture swipe 500 800 500 200 --velocity 600 --json`,
   `ohos-perf gesture key Home --json`,
   `ohos-perf gesture input 500 500 "hello" --json`,
   `ohos-perf gesture text "hello" --json`.
   - Each prints `{ gesture, output }`; the human line ends in `accepted`,
     which means the device tool printed its `No Error` marker — not that a
     widget reacted. A velocity outside 200–40000 and a key other than
     Back/Home/Power or a positive code are rejected before anything touches
     the device.
   - Gestures are their own command: navigate first, then capture. `collect`
     does not accept a gesture script.
4. Capture a scene (10 seconds is a useful default):
   `ohos-perf collect --app <pkg> --duration 10s --out <dir> --json`
   - `--app` is required by the modes that resolve a pid (`--procfs`,
     `--cold-start`, `--hiperf` and the hiprofiler `nativehook` plugin). The
     device-wide collectors run without it.
   - `--procfs` samples `/proc` memory state for the app.
   - `--hiprofiler` captures through hiprofiler instead of hitrace; `--plugins`
     selects its plugins: `ftrace` (default), `gpu`, `xpower`, `nativehook`
     and `memory`. The `memory` plugin records per-process `process_measure`
     and needs no app.
   - `--hiperf` also records a `perf.data` for CPU samples and callstacks. It
     needs a **debuggable** app; a non-debuggable one is refused by the device.
   - `--hidumper` also samples the RenderService fps and hitch counters.
   - `--uitest` also dumps the on-screen UI tree (device-wide, not app-filtered).
   - A capture that produced nothing is not an error: `hiperf` on an idle app
     yields `samples: 0` with exit 0. The JSON says `hiperf: { samples: 0 }`
     and the human summary prints `hiperf 0`; report that, never a silent zero.
5. Analyze it offline: `ohos-perf analyze <dir> --json`
   - A scene captured with `--hiprofiler --plugins memory` carries exact
     per-process RSS: `mem.measure.rss.peak` and `mem.measure.rss.avg`, both
     in bytes. They cover only the analyzed app (`--app`); an app-less
     analysis reports `mem.measure.degraded` with the reason rather than
     attributing device-wide rows to an app.
   - The same command also reports, from the trace alone: native memory
     (`mem.native.*`, from `--plugins nativehook`; see the section below), GC pressure
     (`gc.*`, counts per phase plus `gc.rate`), VSync cadence anomalies
     (`vsync.*`, mismatches and high/low-frequency periods scoped to the
     app's own vsync groups), empty frames (`empty_frame.*`, with HapRay's
     false-positive filters), RenderService `DisplayNode skip` events
     reverse-traced to the app frame they belong to (`rs_skip.*`), folded
     CPU stacks (`flamegraph.*`) and ArkUI component reuse (`components.*`).
   - `flamegraph.*` needs `--hiperf` on a **debuggable** app; a plain hitrace
     capture has no `perf_sample` rows and reports `flamegraph.degraded` with
     that reason. Component reuse needs `H:CustomNode:Build*` events, which a
     capture without the `ace`/`ark` categories will not have.
   - Frame load (`frame.load.*`) and empty-frame load
     (`empty_frame.load.*`) need `--hiperf` on a debuggable app too, and degrade
     with a reason without it. Stutter levels (`frame.stutter.*`) and the 1 s
     FPS windows (`frame.fps.window.*`) are measured from the trace alone.
6. Read `evidence[].drillDown`. Each handle names a `tool`, its `args`, and a
   one-line `returns` shape with an optional `estRows`.

## Frame load and stutter

`frame.load.*` answers "where did the time go in this frame": the summed
`perf_sample.event_count` of every app thread inside the frame's own inclusive
`[ts, ts + dur]`. `event_count` is **sample weight** — never instructions, CPU
time or power, and never a row count.

- `frame.load.total` is the sum of per-frame loads, so overlapping ui and
  render frames each count the same sample. `frame.load.span.weight` is the
  unique weight for the span; when it is smaller, that is overlap, not an
  error. `frame.load.top10.share` is how concentrated the load is.
- A `frame_load` evidence item is a top-10 loaded frame: `rank`, `load`,
  `share`, `durMs`, `offsetMs`, `vsync`, `flag`, `topThread` and
  `topThreadLoad`. Drill down with `frame.load.threads` (per-thread split) or
  `frame.load.symbols` (leaf symbol and file).
- `frame.stutter.*` pairs each late frame (`flag = 1`) with the first expected
  frame of its vsync group and grades the excess: level 1 under 2 frames,
  level 2 under 6, level 3 above. A late frame with no expected frame is
  counted by `frame.stutter.unpaired.count` and has no level, so
  `level1 + level2 + level3 + unpaired = frame.stutter.count`. The
  `.ui/.render/.sceneboard.count` and `.rate` split the same frames by the
  process that owns them.
- `frame.fps.window.count/min/max/mean` are fixed 1-second tumbling windows
  anchored at the first rendered frame; a frame on a boundary belongs to the
  next window and an idle gap appears as an explicit zero window. They are
  `exact` under that rule. The whole-span `frame.fps` stays `approximate`, so
  do not compare the two as if they measured the same thing.
- `empty_frame.load.share` is the empty frames' load over the load of all app
  actual frames; `empty_frame.load.severity` is `normal` under 3%, `moderate`
  under 10%, `severe` at or above 10%. There is no `extreme` rung: the
  numerator is a subset of the denominator, so a share above 100% cannot
  occur. Empty-frame evidence carries `load`, `loadShare` and `loadRank`.
- Every load metric is `exact` when samples exist and the index built, and a
  `degraded` proxy with a reason otherwise. A proxy naming a possible
  time-base mismatch means samples exist but none landed inside any frame
  window — report that as a capture problem, never as a workload-free app.

## Native memory

`mem.native.*` answers "what did the app allocate and never release inside this
capture", from hiprofiler's `nativehook` plugin. It needs `--hiprofiler
--plugins nativehook` on a **debuggable** app; without those tables the
analyzer reports one `mem.native.degraded` proxy naming that requirement.

- Alloc and free events are paired **per address, LIFO**: a runtime can reuse
  an address before the previous block is released, so a free consumes the
  newest block first and continues into older ones. A partial free leaves a
  remainder active.
- `mem.native.total.peak` is the highest running total with its instant
  (`mem.native.peak.offset`, ms from the first app event; ties keep the
  earliest). `mem.native.total.trough` is the lowest — a trough far below zero
  means the capture started mid-lifetime, so every absolute figure is a lower
  bound. `mem.native.total.end` is the total after the last event.
- `mem.native.unreleased.peak` and `.end` are the bytes still live at those two
  instants. **"Unreleased" is not "leaked"**: memory still held when the trace
  stopped may be freed a millisecond later.
- `mem.native.free.unpaired.count` counts frees of an address with no tracked
  allocation; those still move the total, so the total is not fully explained
  by paired events. `mem.native.alloc.unaddressed.count` counts allocations
  whose address was NULL and can never be freed.
  `mem.native.unreleased.unattributed.bytes` is live memory with no callchain.
- Each `native_memory` evidence item is a row at the `peak` or `end` point with
  `size`, `count`, `relativeMs`, `category`, `subCategory`, `file`, `symbol`
  and `thread`. Severity is `warn` at or above 5% of that point's live total.
- Categories come from HapRay's component table: APP, ArkUI, OS_Runtime, RN,
  Flutter, WEB, KMP, SYS_SDK, plus `Thread` (no file, classified by thread
  name) and `UNKNOWN`. The symbol refines an ArkTS `.abc` frame to its package
  and a KMP frame to its Kotlin package.
- A capture with only `native_hook_statistic` reports
  `mem.native.statistic.fallback` and `mem.native.unreleased.end` as proxies
  with a reason, and emits no peak, timeline or per-thread split — those rows
  cannot support them. Never read the proxy as a peak.

Drill down with these four queries; each returns `[]` — not an error — when the
capture has no native tables:

```bash
ohos-perf query <dir> mem.native.unreleased --args '{}' --json
ohos-perf query <dir> mem.native.unreleased --args '{"point":"peak"}' --json
ohos-perf query <dir> mem.native.callchain --args '{"callchainId":10}' --json
ohos-perf query <dir> mem.native.timeline --args '{"bucketMs":1000}' --json
ohos-perf query <dir> mem.native.categories --args '{}' --json
```

## Drilling down

List the available queries and their argument schemas once per session:

```bash
ohos-perf tools --json
```

Then resolve a handle by passing its `tool` and `args` through verbatim:

```bash
ohos-perf query <dir> frames.get --args '{"id":42}' --limit 20 --json
```

Rules:

- Use the handle's `tool` and `args` exactly as emitted; do not rename or
  reshape them.
- Start with a small `--limit`. The result contains `rows`, `total` (matched
  rows before the limit) and `truncated`; follow up only when more rows are
  genuinely needed. The default limit is 100 and the maximum is 1000.
- `/` in a query result is not a path: rows are data from the trace database.
- If a query fails, the CLI writes one line to stderr and exits 1 with empty
  stdout; the message names the available queries or the invalid argument.

Not every query reads the trace database. `ui.get` reads the scene's captured
UI tree (`ui.json`) and returns nodes by `bundleName` and `maxDepth`; a scene
captured without `--uitest` has no rows, and that is not a failure. Use it to
name what was on screen when a frame was slow.

The frame-load handles take a nanosecond range and return `[]` — not an
error — when the capture has no perf tables:

```bash
ohos-perf query <dir> frames.fpsSeries --args '{"startNs":0,"endNs":5000000000}'
ohos-perf query <dir> frame.load.threads --args '{"startNs":1000000000,"endNs":1100000000}'
ohos-perf query <dir> frame.load.symbols --args '{"startNs":1000000000,"endNs":1100000000}'
ohos-perf query <dir> frame.load.files --args '{"startNs":1000000000,"endNs":1100000000}'
```

`frame.load.threads`, `.symbols` and `.files` carry `share` as a percentage of
the window's summed app-thread weight, so rows that do not sum to 100% mean
some samples were not attributable — not that the numbers are wrong.

## Comparing against a baseline

To measure a change, analyze the same app before and after and compare:

```bash
ohos-perf compare <baseline-dir-or-json> <current-dir-or-json> --json
```

Each argument is a scene directory or a saved `analyze --json` file. The result
has one row per metric with `baseline`, `current`, `delta`, `deltaPct` and a
`status`, plus `totals` counting each status.

- `improved` / `regressed` mean the metric moved in the direction that matters
  for that metric — frame throughput is higher-is-better, every latency,
  memory, hitch and redundant-thread figure is lower-is-better.
- `incomparable` means **the direction is unknown**, not that nothing changed.
  The metric moved and no one has said which way is good; read the values and
  decide yourself. Never report it as unchanged.
- `added` / `removed` mean the metric exists on one side only — usually a
  collector that ran in one capture and not the other.
- `deltaPct` is absent when the baseline is zero or either side is not numeric.

## Writing a human report

When a person needs the result rather than a tool call, render the artifact
bundle:

```bash
ohos-perf report <scene-dir> --out reports/run1 [--app <pkg>] [--baseline <input>]
```

- Artifacts: `report.html` (self-contained, no scripts or network),
  `report.json` (the typed, versioned model), `summary.json` (per-section
  counts), `metrics.csv`, `evidence.csv` and `report.xlsx`.
- `--baseline` accepts a scene directory or an `analyze --json` file, exactly
  like `compare`, and adds a typed comparison to all artifacts.
- Same scene and same package version produce byte-identical files.
- A skipped analyzer is a `degraded` section with its reason, in the model,
  the HTML banner, the summary and the CLI's `sections` line. Never describe a
  degraded section as measured, and never read its `<id>.degraded` zero as a
  measurement.
- `--json` prints the artifact manifest (paths and counts), not the report
  document.

## Output contract

`--json` output is the same structure the library returns. Evidence is ordered
by `(kind, window.startNs, id)`, so repeated runs over the same scene and the
same query arguments are byte-identical.
