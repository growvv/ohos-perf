---
name: ohos-perf
description: Measure HarmonyOS app performance on real devices and drill down into captured traces — probe capabilities, collect a scene or run a declarative scenario, read evidence, and follow drillDown handles into frames, callstacks, binder transactions, thread patterns and memory measurements with the ohos-perf CLI.
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
   - When the gesture has to be **inside** the capture window, or the same
     sequence must run more than once, write a scenario instead of typing two
     commands — see `## Scenarios` below.
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
   - `--so-dir <dir>` symbolizes the perf capture while it converts: a host
     directory of shared objects, passed to `trace_streamer` as `--So_dir`.
     It requires `--hiperf` (`COLLECT_SO_DIR_WITHOUT_HIPERF`) and an existing
     directory here (`COLLECT_BAD_SO_DIR`); both are refused before the capture
     starts. `scene.json` records `capture.hiperf.symbolized: true`.
   - `--hidumper` also samples the RenderService fps and hitch counters.
   - `--uitest` also dumps the on-screen UI tree (device-wide, not app-filtered).
   - `--hilog` also streams the device log for the capture window into
     `hilog.log` and `hilog.jsonl` (device-wide, not app-filtered). Analyze
     reads it for the rule counts below; a re-capture without the flag removes
     the previous log rather than letting `analyze` report it.
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
     CPU stacks (`flamegraph.*`), symbol statistics (`symbol.*`) and ArkUI
     component reuse (`components.*`).
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

## Hilog

`hilog.*` answers "what did the app print during this capture, and how often
did a known pattern appear" — HapRay's per-pattern counts, from the log.
Capture it with `collect --hilog` (device-wide, no `--app`); without a
`hilog.log` the analyzer reports one `hilog.degraded` proxy naming that flag.

- The rule set is typed: `{ name, regex, groups, conditions, scope }`.
  `groups` is 1-based, `0` is the whole match; `conditions` is either one
  comparison per group (`'!=4'`) or one expression over `$1`, `$2`, … with
  `+ - * / %`, comparisons and `,`/`&&`. Rules match the **message** unless
  `scope: 'line'`.
- The default set is HapRay's four `CreatePixelMap` rules (`no_dmp`,
  `big_image_with_target_size`, `big_image_without_target_size`,
  `image_same_size`). One line can match several, and upstream counts it in
  each — so does this port.
- `hilog.lines.count` = `hilog.parsed.count` + `hilog.unparsed.count` on every
  input. An unparsable line is a raw row with its text; it is counted, never
  dropped, so a count is never silently short.
- `hilog.rule.<name>.count` is `exact` including a zero: the rule was
  evaluated and nothing matched. Only a scene with no log degrades.
- Each `hilog_match` evidence item is one rule that fired, with `count`,
  `firstLine`, `lastLine` and up to five `samples`. **A match is a pattern hit,
  not a diagnosis** — report the count and the pattern, never a root cause.
- The log carries no year. The analyzer takes it from `scene.json`; a
  month/day after the capture is read as the previous year. A hand-built scene
  with no descriptor keeps every line raw, so `hilog.around` returns nothing
  and rule counts still work on the message text.

Drill down with these three queries; each returns `[]` when the scene has no
log:

```bash
ohos-perf query <dir> hilog.matches --args '{"rule":"no_dmp"}' --json
ohos-perf query <dir> hilog.rules --args '{}' --json
ohos-perf query <dir> hilog.around --args '{"startNs":0,"endNs":1000000000}' --json
```

## Scenarios

`ohos-perf run` answers "what happens when the user does this" — a sequence
that must be measured, not a state that happens to be on screen when you
capture. Use it instead of `gesture` + `collect` whenever an action must land
inside the capture window, or whenever the same steps must be repeated.

```bash
ohos-perf run scenario.json --out <dir> --json
```

The document is versioned JSON (`version: 1`, `name`, `app`, optional
`description` and `rounds`, and a non-empty `steps` array). Each step is:

```json
{
  "id": "open",
  "name": "Open the viewer",
  "setup":   [{ "kind": "launch", "ability": "EntryAbility" }],
  "actions": [{ "kind": "click", "x": 500, "y": 800 },
              { "kind": "marker", "name": "image-requested" }],
  "cleanup": [{ "kind": "forceStop" }],
  "capture": { "durationMs": 5000, "collectors": ["hitrace", "procfs"] }
}
```

- The whole document is validated before the first device call. An unknown
  key, a duplicate `id`, `id` outside `^[a-z][a-z0-9_-]*$`, an empty
  `collectors`, `hitrace` together with `hiprofiler`, `plugins` without
  `hiprofiler`, a `durationMs` outside `(0, 2^31-1]`, or an unknown action
  `kind` exits 1 with `SCENARIO_BAD_INPUT` / `SCENARIO_BAD_STEP` naming the
  JSON path. Never "fix" a rejection by editing the runner's copy of the
  document — edit the file and re-run.
- Three phases run for real: `setup` before the capture starts, `actions`
  inside the capture window concurrently with the collectors, `cleanup` after
  it always (also after a failed action). A setup failure fails the step
  before any collector starts.
- Actions: `launch` (`aa start -a <ability> -b <app>`), `forceStop`,
  `click`, `swipe`, `key`, `text`, `inputText`, `wait`, `marker`. Gestures
  use the same `uitest uiInput` path as `ohos-perf gesture`. A non-zero device
  exit fails the action with the device's own message.
- `marker` makes no device call. It records a named instant (`atMs`, host
  clock) in `steps.json`, so a gesture can be lined up with the scene's
  `capture.startedAtMs`. It is an annotation, not a trace event — do not
  claim it appears in the trace. `atNs` is recorded only when the device
  allows `cat /proc/uptime`; both measured devices refuse it, and the field
  is then absent (never a zero).
- Collectors per step: `hitrace` (default), `hiprofiler` (with `plugins`),
  `procfs`, `hiperf`, `hidumper`, `uitest`, `hilog`. A collector the device
  lacks fails that step with the capability matrix's reason, and the message
  names the step.

Each step directory is an ordinary scene, so the analysis loop is unchanged:

```bash
ohos-perf analyze <dir>/<stepId>/round-1 --json
ohos-perf report  <dir>/<stepId>/round-1 --out reports/open
```

The run directory is:

```
<dir>/testInfo.json   # scenario, app (+version when the device answers), device, rounds, status
<dir>/steps.json      # one entry per (round, step): status, sceneDir, actions with atMs
<dir>/pids.json       # pidof at run start; { "pids": [] } when the app was not running
<dir>/<id>/round-<n>/ # the scene, with a scene.json step block { round, index, id }
```

`--rounds <n>` overrides `rounds`. `--only a,b` runs a subset in scenario
order; an unknown id exits 1 naming the available ones. Fail-fast is the
default: the first failed step stops the run, and `steps.json` /
`testInfo.json` are still written. `--keep-going` continues; the exit code is
1 either way. A failed action keeps its scene — that trace is still a real
measurement of what the device did, so analyze it rather than discard it.
`run` never analyzes.

## UI capture and diff

Use this when the question is about what the user *saw*, not how fast it was
drawn: a layout regression, a missing or extra control, a screen that looks
different after a change.

```bash
ohos-perf collect --duration 5 --out <dir> --uitest --screenshot --json
ohos-perf ui-compare <sceneA> <sceneB> --out <dir> --json
```

- `--screenshot` adds `screenshot.png` beside `ui.json`. It needs no `--app`
  (the whole screen is captured) and is independent of `--uitest`; a
  screenshot with no tree is a valid capture. `--json` reports
  `screenshot: { width, height }`; the human line prints
  `screenshot 1260x2720`.
- Success is the device tool's `ScreenCap saved to` marker, never the host exit
  code. The pulled bytes must carry the PNG signature, so a truncated transfer
  fails loudly instead of becoming a scene artifact.
- `ui-compare` exits **0 whenever the comparison was made**, including when the
  screens are identical — identical is a result, not a failure. Exit 1 means it
  could not be made: an artifact missing on one side (`UI_MISSING_ARTIFACT`), or
  two different screen sizes (`UI_SIZE_MISMATCH`, which is refused rather than
  rescaled).
- Output, in `--json` and on disk:

  ```
  tree   { added, removed, changed, unchanged }     // or null when no tree on either side
  image  { hamming, similarity, changedRatio, tolerance }  // or null when no screenshot
  regions  <count of changed regions>
  degraded [...]   // artifacts neither side carried
  files   ui-diff.json, ui-diff.html, ui-diff-marked-a.png, ui-diff-marked-b.png
  ```

- **Tree matching is by identity, not index**: `bundleName|type|id|text`, with
  `id`/`text` used only when non-empty. Inserting one node is one `added`, not a
  cascade. Do not describe `changed` as "moved" — it means an attribute
  differed after the ignore list and the 5 px geometry tolerance.
- **Image numbers answer different questions.** `similarity` is structural
  (`1 - hamming/64` over an 8×8 greyscale gradient); `changedRatio` is literal
  pixels over a ≤256 px-wide downscale at `tolerance` 8 of 255. Quote both with
  the tolerance, and never convert either into "the layout is broken".
- **The analyzer's UI section is the same data**: `analyze` emits
  `ui.nodes.count`, `ui.nodes.clickable`, `ui.nodes.text`, `ui.tree.depth.max`,
  `ui.screenshot.width`/`height` and `ui.screenshot.dhash`; `report` embeds the
  screenshot from `assets/screenshot.png`. A scene with only one of the two
  artifacts reports the present half as exact and the missing half as degraded
  with a reason — never zeros for both.
- An animation is a start/end pair of scenes; compare them with `ui-compare`.
  There is no `ui_animate.json`, and HapRay's "animated / major / minor" labels
  are deliberately not emitted.
- Drill into the tree with `ohos-perf query <scene> ui.tree --json`; it returns
  every attribute the diff compares, in document order.

## Static HAP inspection

Use this when the question is about the **package** rather than a capture:
which native libraries it ships, which framework it embeds, which assets are
byte-identical copies, which files are oversized. It needs no device, no `hdc`
and no trace.

```bash
ohos-perf hap <package.hap> --json
ohos-perf hap <package.hap> --out <dir>
```

- `--json` prints `{ analysis, capabilities }`: `analysis` is the same
  `HapAnalysis` document `hap.json` writes — `package`, `totals`,
  `categories`, `technologies`, `duplicates`, `oversized`, `largest`, and
  `files` (every entry's path, sizes, CRC32, extension and category) — and
  `capabilities` is the one-row `static.hap` matrix. `--out` additionally
  writes `hap.json` (that document) and an offline `hap.html`.
- The path is checked before any IO: a missing path, a directory, or a file
  without `.hap`/`.hsp`/`.zip` exits 1 naming it and writes nothing.
- **A technology match names its rule.** `technologies[]` carries
  `{ ruleId, type, files[], bytes, confidence }`; quote the rule id, and never
  upgrade a detection into "the app is built with X" — a rule that matched one
  file is one piece of evidence, not a verdict. `hap.techstack.count` 0 means
  nothing matched; it does not mean "native app".
- Flutter is detected from `libflutter.so`/`libapp.so` **plus** a Dart version
  string in the file. A stripped binary with no version string is not a
  Flutter match; do not infer it from the file name alone.
- Duplicates are byte-identical files confirmed by SHA-256;
  `duplicates.wastedBytes` is what one copy per group would save. An
  `oversized` file is above its category's HapRay threshold (images 1 MiB,
  videos 10 MiB, audio 5 MiB, fonts 2 MiB, scripts 0.5 MiB, styles 0.2 MiB,
  binaries 5 MiB, bytecode 2 MiB, data and other 1 MiB) — "oversized" is a
  filing threshold, not a defect.
- The archive is read in memory and never extracted. Every entry is
  CRC-checked, including the `resources/base/` entries no rule reads. A
  package the reader cannot describe honestly fails by name: `HAP_NOT_ZIP`
  (including a malformed header offset), `HAP_ZIP64_UNSUPPORTED`,
  `HAP_ENCRYPTED_ENTRY`, `HAP_UNSUPPORTED_METHOD`, `HAP_UNSAFE_PATH`,
  `HAP_CRC_MISMATCH`. The CLI prints `CODE: message`, so report the code, not
  a guess.
- There is no query for the inventory: `analysis.files` in `--json`, or
  `hap.json`, is where the per-file detail lives, and every query in this
  package reads a captured scene.

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
name what was on screen when a frame was slow. `ui.tree` returns the same
captured tree whole — every attribute the UI diff compares, in document order —
so a difference from `ui-compare` can be read back attribute by attribute.
There is no query for a HAP's file inventory — `ohos-perf hap <package> --out`
writes it to `hap.json`, and a query reads a captured scene, never a document.

The frame-load handles take a nanosecond range and return `[]` — not an
error — when the capture has no perf tables:

```bash
ohos-perf query <dir> frames.fpsSeries --args '{"startNs":0,"endNs":5000000000}'
ohos-perf query <dir> frame.load.threads --args '{"startNs":1000000000,"endNs":1100000000}'
ohos-perf query <dir> frame.load.symbols --args '{"startNs":1000000000,"endNs":1100000000}'
ohos-perf query <dir> frame.load.files --args '{"startNs":1000000000,"endNs":1100000000}'
ohos-perf query <dir> symbol.stats --args '{"startNs":1000000000,"endNs":1100000000}'
```

`frame.load.threads`, `.symbols` and `.files` carry `share` as a percentage of
the window's summed app-thread weight, so rows that do not sum to 100% mean
some samples were not attributable — not that the numbers are wrong.

## Symbols

A perf capture records addresses; a frame is only named when resolution is
right. What the analyzer sees:

- `perf_callchain.name` is **not** a symbol. It is a `data_dict` id.
  Resolution order is: the exact `(file_id, symbol_id → perf_files.serial_id)`
  row, then the `data_dict` text for `name`, then — only when the database has
  no `data_dict` at all — the raw `name` column. It never uses a neighbour:
  the old file-only fallback invented names for 7.14% of a measured capture's
  leaf weight.
- `symbol.samples.count` is the sampled weight whose symbol is a name;
  `symbol.unresolved.count` is the weight still `file+0xoffset`;
  `symbol.unresolved.share` is the latter over all leaf weight. The first two
  sum to the window's weight. `symbol.files.count` counts distinct paths, and
  `symbol.top.symbol` / `symbol.top.samples` name the heaviest resolved row.
- Unresolved weight is not an error. `libfoo.so+0x1cce24` is honest evidence
  about which library ran; on the measured capture it was 9.43%. A report that
  shows only named frames understates how much of the profile is unexplained.
- `symbol_stats` evidence items (severity `info`) name the heaviest resolved
  rows; `unresolved_symbol` items (severity `warn`) name the heaviest unnamed
  ones. Their `explain` names the cause, and `--so-dir` only when a flag can
  help: a frame-less chain (a truncated conversion) and a database with no
  `perf_files` table are named as such, because no flag symbolizes an address
  that is not there. Both drill into `symbol.stats`.
- `symbol.stats` takes `startNs`/`endNs` and returns
  `{symbol, filePath, samples, share, unresolved}`, sorted by weight. Its
  `share` totals 100% over the window's app-thread weight.
- `report` writes `flamegraph.svg` and `flamegraph.html` when the scene has
  samples. The page states the unresolved share and whether symbolization ran
  (`capture.hiperf.symbolized`); a capture that never recorded it says
  `unknown` rather than claiming either.

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
