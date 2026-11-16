# Changelog

## Unreleased

### Added

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

- The emulator's exit code carries no information: every measured failure exits
  0. Success is proven by re-reading state, and a `-start` that keeps running
  (the process becomes the emulator) is no longer mistaken for a hang.

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
