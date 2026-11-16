# Changelog

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
- Remaining HapRay analysis surface (GC, flamegraph, VSync anomaly, empty-frame
  reverse tracing, UI animation) and `ohos-perf emulator` lifecycle commands
  are planned.
