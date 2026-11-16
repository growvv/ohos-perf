# Changelog

## 0.8.0 — 2026-11-17

P13 (HapRay parity W5): declarative scenarios, measured from the inside.

### Features

- **`ohos-perf run <scenario.json> --out <dir>`** runs a versioned JSON
  scenario and writes one complete scene per `(round, step)` at
  `<out>/<id>/round-<n>/`, alongside `steps.json`, `testInfo.json` and
  `pids.json`. Each step directory is an ordinary scene: `analyze`, `report`,
  `query` and `compare` work on it unchanged.
- **Three phases per step, all executed:** `setup` before the capture starts,
  `actions` inside the capture window concurrently with the collectors, and
  `cleanup` after it — always, including after a failed action. (HapRay's DSL
  parses `setup`/`cleanup` and never runs them.)
- **Actions:** `launch`, `forceStop`, `click`, `swipe`, `key`, `text`,
  `inputText`, `wait`, `marker`. Gestures reuse the measured `uitest uiInput`
  path; `launch`/`forceStop` are `aa start`/`aa force-stop` and a non-zero
  device exit fails the action with the device's own message.
- **`marker`** records a named instant (`atMs`, host clock; `atNs` device
  uptime when the device allows `cat /proc/uptime`) with no device call, so a
  gesture can be lined up with the scene's `capture.startedAtMs`.
- **Per-step collectors:** `hitrace` (default), `hiprofiler` (with `plugins`),
  `procfs`, `hiperf`, `hidumper`, `uitest`, `hilog`.
- **`--rounds <n>`, `--only <ids>`, `--keep-going`, `--json`, `--target`.**
  Fail-fast is the default; the exit code is 1 when any step failed.
- **`scene.json` gains an optional `step: { round, index, id }` block**, so a
  scene copied out of a run is still self-describing. The version stays `1`
  and every existing reader keeps working.
- **Public surface:** `parseScenario`, `executeAction`, `ScenarioRunner`,
  `writeRunFiles`, `COLLECTOR_NAMES`, and the `Scenario` / `ScenarioStep` /
  `ScenarioAction` / `StepCapture` / `CollectorName` / `ActionDevice` /
  `ActionOutcome` / `RunResult` / `RunStepResult` / `RunOptions` /
  `RunnerCollectOptions` / `RunnerDevice` / `SceneStepRef` types.

### Semantics worth naming

- **Validation precedes the first device call.** Unknown keys, a duplicate
  step `id`, an `id` outside `^[a-z][a-z0-9_-]*$`, an empty or duplicated
  `collectors` list, `hitrace` with `hiprofiler`, `plugins` without
  `hiprofiler`, a duration outside `(0, 2^31-1]`, an unknown action kind or an
  unknown key on one — each is a typed `SCENARIO_BAD_INPUT` /
  `SCENARIO_BAD_STEP` naming the JSON path. A scenario that would fail on step
  3 never fails after two captures have run.
- **A failed action keeps its scene.** The trace is a real measurement of what
  the device did while the action was attempted; the step is marked `failed`
  with the action's error and `sceneDir` still names it. A failed *setup* or a
  failed capture names no `sceneDir`, because there is no scene to point at.
- **`steps.json` is structurally deterministic.** Same scenario, device and
  outcomes produce identical ids, order, paths and statuses; exactly three
  fields are host clock and vary — the run's `startedAtMs`/`durationMs` and
  each action's `atMs`.
- **Measured limitation:** both the Mate 60 and the HarmonyOS emulator answer
  `cat /proc/uptime` with `Permission denied` from an ordinary shell, so
  `atNs` is absent on every device this package has been measured on. The
  field is omitted rather than fabricated as a zero (a zero would address the
  trace origin).
- **Not ported, deliberately:** Hypium/xdevice and executable Python
  testcases, metric assertions inside a scenario (that is `compare`'s
  question), device pools, and HapRay's retry-until-non-empty behavior —
  silently re-running until something appears is how an empty capture becomes
  a plausible number.

## 0.7.0 — 2026-11-17

P12 (HapRay parity W4): the device log, captured and evaluated.

### Features

- **`collect --hilog`** streams the device log for the capture window into
  `hilog.log`, plus `hilog.jsonl` — one typed row per line. The capture is
  device-wide, so no `--app` is required. An empty stream is a failed capture
  (`HILOG_NO_OUTPUT`), never a quiet app: hdc exits 0 even when the device tool
  fails, so content is the only honest success signal. `hilog.stream` joins the
  capability matrix, gated on the `hilog` binary.
- **`HilogAnalyzer`** (`hilog` section) evaluates the log against a typed rule
  set. Metrics: `hilog.lines.count`, `hilog.parsed.count`,
  `hilog.unparsed.count`, `hilog.rule.<name>.count` per rule, and
  `hilog.rules.matched.count` / `.unmatched.count`. One `hilog_match` evidence
  item per matching rule, carrying the count, the first and last line, up to
  five sample messages and drill-downs.
- **Rule set without `eval`.** `HilogRule` is `{ name, regex, groups,
  conditions, scope }`; conditions are either per-group comparisons or an
  expression over `$1`, `$2`, … parsed into an AST and evaluated. A malformed
  regex or expression is a typed error naming the rule. HapRay's four
  `CreatePixelMap` rules ship as `DEFAULT_HILOG_RULES`.
- **Three named queries:** `hilog.matches` (optionally one rule),
  `hilog.rules` (the effective rule set with counts), and `hilog.around` (lines
  in an inclusive nanosecond window, for correlating with a frame). Each returns
  `[]` when the scene has no log.
- **Public surface:** `parseHilogLine`, `parseHilogText`, `compileRules`,
  `matchRules`, `DEFAULT_HILOG_RULES`, `HilogAnalyzer`, `HilogCollector`,
  `readHilogText`, and the `HilogLine` / `HilogRule` / `HilogMatch` /
  `CompiledRule` / `HilogParseOptions` types.

### Semantics worth naming

- A log line that does not parse is a `raw` row (`parsed: false`), counted in
  `hilog.lines.count` and `hilog.unparsed.count` — never dropped.
- A scene with no `hilog.log` yields one `hilog.degraded` proxy naming the
  capture flag. A log with no rule matches is a real zero, not a degradation.
- The year is not in the log. It comes from `scene.json`'s capture time, and a
  month/day after the capture is read as the previous year — the one reading
  that cannot invent a future log. A scene with no descriptor keeps every line
  raw rather than guessing an instant.
- Not ported, deliberately: `hilogtool` decryption (this package captures
  plaintext over `hdc shell hilog`), on-device persistent log rotation, and
  log-based crash classification.

## 0.6.2 — 2026-11-17

### Fixes

- **`native_memory` evidence aborted the whole analysis on a real capture.**
  `pointEvidence` passed no `key`, so every row at one point hashed to the same
  id — same window, usually same process, thread and pid. Two live rows on one
  thread, or a capture whose peak falls at the last event (peakTs === endTs),
  failed `analyze`, `report` and `compare` with `DUPLICATE_EVIDENCE_ID`. The
  spec's `native-memory:<point>:<callchainId>:<pid>:<tid>` key is now passed.
- **The peak's unreleased set was replayed past the peak.** `unreleasedAt(ts)`
  stopped on the timestamp alone, so a free sharing the peak's instant was
  already applied and `mem.native.unreleased.peak` reported the post-free
  state — often zero. The replay now stops at the peak event's `(ts, id)`
  position, and `peakId` travels on the result.
- **The statistic fallback fabricated a zero for the wrong app.** The presence
  check was table-wide: with `native_hook` empty and statistic rows only for
  another pid, the analyzer reported "0 bytes across 0 callchains" as a proxy
  measurement. The check is app-scoped now, so that scene degrades with a
  reason.
- **`native-memory` never ran on a nativehook-only scene.** The offline
  capability rule required the memory plugin's `process_measure` tables, so the
  capture `collect --hiprofiler --plugins nativehook` produces — the
  analyzer's own primary input — was reported as `native-memory.degraded` with
  the data in the database. Either table family (`process_measure*` or
  `native_hook*`) now satisfies `mem.native_hook`.
- **A real capture could abort the query layer.** `frames()` and `dataDict()`
  bound one `IN (?, …)` per id list and exceeded SQLite's 32 766-variable
  limit; id lists are chunked at 500 now, as upstream does.
- **A partial trace threw `no such table: process`** from `events()` and
  `statistics()`, breaking the documented "returns `[]` when a table is
  absent" contract. Both accessors guard the join.
- **A duplicated `process.ipid` multiplied every event.** A merged trace with
  two `process` rows for one ipid returned each `native_hook` row twice,
  doubling alloc/free bytes and the peak. Both joins now select `DISTINCT`.
- **A NULL `event_type` counted as an allocation.** `event_type ?? 0` inflated
  the running total with bytes whose direction is unknown; `null` now reaches
  the pairing layer as `other`.
- **A zero-size free was counted as unpaired**, inflating
  `mem.native.free.unpaired.count` with a free that consumed nothing.
- **APP classification covered only `bundle/`.** Upstream's `APP_ABC` rule
  covers the whole `/proc/<pid>/data/storage/` sandbox, so a cache db or a
  hap's own `.so` was reported as `SYS_SDK`. Those paths are `APP` now.
- **The site's statistics disagreed with its own text** — the analyzers stat
  read 14 while the page said sixteen, and the Chinese test count read 1076
  against the English 1126.

## 0.6.1 — 2026-11-17

### Fixes

- **`frame.load.*` drill-downs returned nothing on a real `--hiperf` scene.**
  A perf capture converts into `perf.db`, so `perf_sample` and `perf_thread`
  are not in `trace.db`; every `frame.load.threads`, `.symbols` and `.files`
  query read the trace handle and answered `[]`, while `analyze` reported a
  non-zero `frame.load.total` and offered those very handles. `QueryContext`
  gains `perfDb`, the four queries go through one resolver, and the CLI query
  path passes `scene.perfDb`. Measured on a split scene: `[]` before, the
  attributed rows after.
- **Empty-frame evidence no longer fabricates load.** Without perf samples, or
  with samples that fall in no frame window, each `empty_frame` item reported
  `load: 0`, `loadShare: 0` and a `loadRank` of 1..n while the same result
  carried `empty_frame.load.degraded`. The load signals and the
  `frame.load.symbols` drill-down now appear only when a load was measured.
- **Frame load read samples only up to the last-by-`ts` frame's end**, so a
  frame that started earlier but ended later lost its tail. The read now ends
  at the maximum frame end.
- **`compare` reported every 0.5.0 and 0.6.0 metric family as `incomparable`.**
  `frame.load.*`, `frame.stutter.*`, `frame.fps.window.*`,
  `empty_frame.load.*` and the retained-memory `mem.native.*` figures now have
  directions; activity volumes (`mem.native.events.count`, `.peak.offset`,
  `frame.fps.window.count`, `frame.load.span.weight`) deliberately keep none.
- **The empty-frame degraded reason always claimed `--hiperf` was missing**,
  even when the capture had samples for another process. It now names the real
  gap.
- **A long capture could crash the empty-frame and `rs_skip` analyzers.**
  `Math.min(...frames)` spreads one argument per frame and throws past V8's
  argument limit (~124k); the three sites use a reduce.
- **Two `frame_load` evidence items could share an id.** `frame_no` is 0 on
  every real row, so same-process frames with equal `(ts, dur)` hashed
  identically and the engine failed the whole analysis with
  `DUPLICATE_EVIDENCE_ID`; the row id now separates them.

## 0.6.0 — 2026-11-17

### Added

- **Native memory** (`native-memory` analyzer, `mem.native.*`) from
  hiprofiler's `nativehook` plugin. `NativeHookQuery` gives typed, batched
  access to `native_hook`, `native_hook_frame` and `native_hook_statistic`,
  returning `[]`/`false` rather than throwing when a table is absent.
  - Events are alloc for `AllocEvent`/`MmapEvent`/`0` and free for
    `FreeEvent`/`MunmapEvent`/`1`; `heap_size` is read as a magnitude and the
    direction comes from the event type. Anything else is counted but moves
    nothing.
  - Frees are paired **per address, LIFO** with partial-free remainders,
    because a runtime can reuse an address before releasing the previous
    block. The running total carries its peak (earliest event on a tie),
    trough and end. A trough far below zero means the capture started
    mid-lifetime and every absolute figure is a lower bound.
  - Metrics: `mem.native.events.count`, `.alloc.count/.bytes`,
    `.free.count/.bytes`, `.total.peak/.trough/.end`,
    `.unreleased.peak/.end`, `.unreleased.unattributed.bytes`,
    `.alloc.unaddressed.count`, `.free.unpaired.count`,
    `.callchains.count` and `.peak.offset`.
  - Live allocations at the peak and at the end are aggregated per callchain,
    process and thread (`aggregateUnreleased`), with the file and symbol
    resolved from the leaf frame through `data_dict`, and become
    `native_memory` evidence: top 10 at each point, `warn` at or above 5% of
    that point's live total, drilling down to `mem.native.callchain`,
    `mem.native.unreleased` and `frames.all`.
  - `buildNativeTimeline` buckets alloc/free bytes and the running total at a
    fixed width anchored at the first event, omitting empty buckets and
    flagging the peak bucket.
- **Component classification** (`classifyNativePath`, `native-kinds.ts`).
  HapRay's `kind.json` table — 7 kinds, 22 components, 125 path rules and 25
  thread rules — ported as a checked-in constant, with exact-path, regex,
  app-bundle, basename, `SYS_SDK` and thread fallbacks. A symbol refines an
  ArkTS `.abc` frame to its package and a KMP frame to its Kotlin package.
- **Named queries**: `mem.native.unreleased` (`point: peak | end`),
  `mem.native.callchain`, `mem.native.timeline` (`bucketMs`) and
  `mem.native.categories`, all returning `[]` when the native tables are
  absent.

### Honesty and divergences from upstream

- "Unreleased" means still allocated when the capture stopped — it is not a
  leak claim. No leak labels are emitted.
- A capture with only `native_hook_statistic` reports
  `mem.native.statistic.fallback` and `mem.native.unreleased.end` as proxies
  with a reason, and emits no peak, timeline or per-thread split: those rows
  carry no per-allocation timestamp, thread or address.
- Upstream loads one rule list into both an exact dict and a regex list, so a
  rule containing a metacharacter matches both ways and exact precedence is
  accidental. Here each rule is exactly one of the two, decided once by
  upstream's own metacharacter test.
- `all_heap_size` and `current_size_dur` are read but never interpreted:
  their semantics are undocumented upstream and the report does not use them.
- No `native_hook` rows and no statistics yield one `mem.native.degraded`
  proxy naming `hiprofiler --plugins nativehook` and the debuggable-app
  requirement — never a zero. Both recorded traces have empty `native_hook`
  tables, so `native-memory` degrades there: `emu_big` reports 74 metrics and
  94 evidence items, `real_device` 73 and 180.

## 0.5.0 — 2026-11-17

### Added

- **Frame load** (`frame-load` analyzer, `FrameLoadIndex`). A frame's load is
  the summed `perf_sample.event_count` of every app-process thread inside the
  frame's own **inclusive** `[ts, ts + dur]` window — sample weight, never
  instructions, CPU time or power. One batched sample read answers every
  frame, so a 10k-frame trace does not run 10k table scans. Metrics:
  `frame.load.frames.count`, `.total`, `.avg`, `.min`, `.max`,
  `.top10.share` and `.span.weight`; the top-10 loaded frames become
  `frame_load` evidence with rank, share, duration, offset, vsync, flag and
  the heaviest thread, each drilling down to `frames.get`,
  `frame.load.threads`, `frame.load.symbols` and `callstack.range`.
  Overlapping app frames (ui and render in one vsync period) each count a
  sample, so per-frame totals can exceed `span.weight`, the unique weight read
  for the span; both numbers are reported so the difference is visible.
- **Stutter grading** in the frame analyzer. Each stuttered frame
  (`type = 0`, `flag = 1`) is paired with the first expected frame
  (`type = 1`) of its vsync group ordered by `(ts, id)`, and the excess
  (`actual.dur - expected.dur`) is graded level 1 (< 2 frames), level 2
  (< 6) or level 3, using integer nanosecond math against a 16.67 ms budget.
  Metrics: `frame.stutter.count`, `.unpaired.count`, `.level1/2/3.count`,
  plus `.ui/.render/.sceneboard.count` and `.rate`; a stuttered frame with no
  expected frame in its group has no level and is counted as unpaired, so the
  levels plus unpaired always sum to the stutter count.
- **1-second FPS windows** (`computeFpsWindows`). Fixed tumbling windows
  anchored at the first rendered frame, every window exactly 1 s, a frame on a
  boundary belongs to the next window, and idle gaps appear as explicit zero
  windows. Metrics: `frame.fps.window.count`, `.min`, `.max`, `.mean`. The
  whole-span `frame.fps` stays `approximate` and keeps its own id.
- **Empty-frame load** in the empty-frame analyzer:
  `empty_frame.load.total`, `.share` (empty load over the summed load of all
  app actual frames) and `.severity` (`normal` < 3%, `moderate` < 10%,
  `severe` ≥ 10%). Each confirmed empty frame's evidence gains `load`,
  `loadShare` and `loadRank`, plus a `frame.load.symbols` drill-down.
- **Leaf attribution**: `PerfQuery.leafAttribution(threadIds, range)`
  attributes each sample's full weight to the deepest frame of its callchain,
  sorted by weight then symbol then file path.
- **Named queries**: `frames.fpsSeries`, `frame.load.threads`,
  `frame.load.symbols` and `frame.load.files`, all returning `[]` when the
  perf tables are absent. Shares are of the window's summed app-thread
  weight, so unattributed samples remain visible as rows not summing to 100%.

### Honesty and divergences from upstream

- No ±1 ms window expansion. Upstream widens every frame window by a
  millisecond, which inflates load for overlapping frames and is why its empty
  share can exceed 100%. With exact windows the empty numerator is a subset of
  the denominator, so `empty_frame.load.severity` stops at `severe`; upstream's
  unreachable `extreme` label is deliberately not ported.
- `high_load_frames` (`frame_load > 80`) is not ported: it compares an
  instruction count against a percentage. `frame.load.top10.share` answers the
  same question with a defined unit.
- No perf samples, no app perf threads, or samples that exist but fall inside
  no frame window all yield one `frame.load.degraded` /
  `empty_frame.load.degraded` proxy naming the cause — the last case names the
  likely time-base mismatch. No load metric is ever a fabricated zero.

## 0.4.0 — 2026-11-17

### Added

- `ohos-perf report <scene> --out <dir> [--baseline <input>]` — one analysis
  pass rendered as a typed, deterministic artifact bundle: `report.html`
  (self-contained, no scripts, no network), `report.json` (versioned report
  model), `summary.json` (per-section roll-up), `metrics.csv`, `evidence.csv`
  and `report.xlsx` (dependency-free stored-ZIP workbook with `Summary`,
  `Metrics`, `Evidence` and, with a baseline, `Compare` sheets).
- `runAnalyzerSections()` in the core engine: the same merged `AnalyzeResult`
  as `runAnalyzers()` plus one section per analyzer, so a report can attribute
  every metric to its source and label a skipped analyzer `degraded` with the
  device's own reason.
- Every metric in the HTML and CSV keeps its `fidelity` and `provenance`;
  degraded sections are named in the report-wide banner, the summary and the
  CLI's `sections` line.
- Identical scene and package version produce byte-identical files across
  platforms: no timestamps, no host paths, fixed ordering and a ZIP epoch
  timestamp in the workbook.

## 0.3.0 — 2026-11-17

### Added

- `GestureDriver` and `ohos-perf gesture {click,swipe,key,input,text}` — UI
  injection through `uitest uiInput`, so a scene can be driven into the state
  worth measuring. `ui.gesture` is now a capability the package can actually
  drive: success is the device tool's `No Error` marker, because `hdc` returns
  0 even when the device tool fails. Coordinates, velocity (200–40000) and key
  names are validated before the device is touched; text is shell-quoted and
  control characters are refused.
- `Device.gesture()` gates on `ui.gesture`, and the CLI gesture commands honour
  `--target` and `--json` like the other device commands.
- `ohos-perf emulator {list,start,stop,create}` — the HarmonyOS emulator
  lifecycle, so CI and an agent can boot their own target instead of relying on
  an attached device.
  - `list` reports each instance and the `hdc` TCP target it owns; `--json`
    prints that `target`, which `collect --target` consumes directly. A target
    is attributed only when exactly one running instance maps to exactly one
    connected TCP target, and the reason is reported when it is not.
  - `start` blocks until `bootevent.boot.completed` reads `true` on the guest
    and reports the boot time. `--timeout <seconds>` bounds the wait (default
    180); starting an already-running instance is a safe no-op. A timeout never
    kills the emulator — the message names the `stop` command.
  - `stop` waits until the instance reports `isRunning: false`, because
    `-stop` returns success before the state changes.
  - `create` builds an instance from an **already-downloaded** image. It never
    downloads one: a missing image exits 1 with the exact `-install` command to
    run first, and the name, duplicate and memory/storage ranges are all
    validated before anything is spawned.
- `EmulatorClient` and `EmulatorLifecycle` exported from `@ohos-perf/core`,
  split so spawn-and-parse is testable against recorded output and the waiting
  logic is testable with a plain object. Instance and image roots follow
  `--instance-path`/`--image-root` → `OHOS_PERF_EMULATOR_INSTANCE`/
  `OHOS_PERF_EMULATOR_ROOT` → DevEco's `.emu_config` → `%LOCALAPPDATA%`.
- `EmulatorCommandError`, `EmulatorImageMissingError` and
  `EmulatorNotFoundError`, so a failure the binary reports with exit code 0 is
  still a typed error.

### Fixes

- The emulator's exit code usually carries no information: a rejected `-create`
  or an unknown option exits 0. Success is proven by re-reading state, a
  failure line outranks the exit code (the one measured non-zero failure,
  `Unable to start the emulator`, still reports its own sentence), and a
  `-start` that keeps running (the process becomes the emulator) is no longer
  mistaken for a hang.
- `coverage` no longer reports available merely because `hiprofiler_cmd`
  exists. The probe now checks `bjc_cov` — measured absent on the Mate 60, where
  `aa` also prints nothing over plain shell — and the capability stays
  unavailable because no collector in this package consumes its output.

### Changed

- `js.heap`'s reason now names the measured `hidumper --mem-jsheap` gate
  (`needs a debug-signed or profilerable app`) in addition to the missing
  analyzer, so an agent does not chase a build that still would not work.

### Removed

- The claim that `ui.gesture` needs the AAMS test framework. That gate belongs
  to `uitest uiRecord`, a different command; `uitest uiInput` works over the
  plain shell.

## 0.2.0 — 2026-11-16

### Analyzers

- Six analyzers ported from ArkAnalyzer-HapRay rev `9386e4e`, taking the
  analyzer count from eight to fourteen:
  - `gc` — `gc.*`: invocations per phase (full, partial, shared) over the whole
    `callstack` span, `gc.rate`, and the app's share of perf samples from GC
    threads. Degrades `gc.perf.share` to a proxy when `perf_sample` is empty.
  - `vsync` — `vsync.*`: cadence mismatches and high/low-frequency periods,
    scoped to the app's own vsync groups.
  - `empty-frame` — `empty_frame.*`: frames that rendered nothing, with
    HapRay's two false-positive filters.
  - `rs-skip` — `rs_skip.*`: RenderService `DisplayNode skip` events
    reverse-traced through NativeWindow, plus a trace-accuracy figure.
  - `flamegraph` — `flamegraph.*`: folded stacks weighted by
    `perf_sample.event_count`; needs `--hiperf` on a debuggable app.
  - `components` — `components.*`: ArkUI component builds and recycle-pool
    reuse from `H:CustomNode:Build*` events.
- `round2HalfEven` reproduces Python's `round(x, 2)` (half-even on the exact
  double) so component-reuse ratios match HapRay at `0.125`.

### Capabilities

- New `trace.ark` capability (Ark-runtime trace events: GC phases and
  `H:CustomNode` builds). It is a hitrace row gated offline on `callstack`,
  `thread` and `process`, taking the matrix from 20 to 21 verdicts.

### Library

- `CallstackQuery` gains an `ipids` scope for per-process counts and matching.
- `PerfQuery` gains `eventCount`, `threadIdsNamed` and `foldedStacks`, so
  folded-stack aggregation is weighted by `event_count` rather than row count.
- `resolveAppIpids` is now exported from `@ohos-perf/core`; it maps pids to
  trace ipids, which are different number spaces.

### Fixes

- `analyze` reports 56 metrics and 92 evidence items on the recorded emulator
  trace and 55 / 178 on the recorded Mate 60 trace, still byte-identical across
  runs.

## 0.1.0 — 2026-11-16

First public release of `@ohos-perf/core` and `@ohos-perf/cli`.

### Capabilities

- One-shot device probe producing 20 capability verdicts; an unavailable
  capability is a value with a reason, never a silent zero. Measured on a
  Mate 60: 19 / 20, with `js.heap` reporting that no analyzer in this package
  consumes the `js_heap_*` tables.
- Six collectors: hitrace, procfs, hiprofiler (`ftrace`, `gpu`, `xpower`,
  `nativehook`, `memory` plugins), hiperf, hidumper and uitest. `--hidumper`,
  `--uitest` and `--hiprofiler --plugins memory` capture device-wide without
  `--app`; pid-resolving modes are gated before the first device call.
- `trace_streamer` ingest into a scene directory, with `scene.json` recording
  the device, pids, collectors and app.
- Typed queries over the 88-table trace database, including `MemMeasureQuery`
  over the memory plugin's `process_measure` tables.
- Eight analyzers: frames, fault tree, binder, threads, memory, memory measure,
  startup and render. Metrics carry `fidelity` and `provenance`; evidence
  carries drill-down handles.
- `mem.measure.rss.peak` / `mem.measure.rss.avg`: exact per-process RSS in
  bytes from the hiprofiler memory plugin, attributed by trace ipid.
- Named drill-down queries (`ohos-perf tools`, `ohos-perf query`), baseline
  comparison (`ohos-perf compare`), and the `ohos-perf` agent skill.

### Guarantees

- Deterministic JSON: metrics sorted by `id`, evidence by
  `(kind, window.startNs, id)`; the same input produces byte-identical output.
- Zero runtime dependencies in `@ohos-perf/core`; Node's built-in `node:sqlite`
  instead of a native module.
- Collector contract: validate before the first device call, remove fixed
  device paths, require the tool's own success marker; `hdc` exit 0 is never
  evidence.

### Known gaps

- `ui.gesture` requires the AAMS test framework and stays unavailable over
  plain shell.
- `coverage` has no known plugin and reports the binary-only verdict.
- `js.heap` analysis is not implemented; the capability reports why.
- HapRay's UI animation diff is not ported: it needs per-step `pages.json`,
  element trees and screenshots that no collector in this package produces.
  The `ohos-perf emulator` lifecycle commands are planned.
