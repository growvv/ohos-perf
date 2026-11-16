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
2. Read the capability matrix before asking for data that may not exist:
   `ohos-perf caps --json`. An unavailable capability is absent by design —
   never invent its metric.
3. Capture a scene (10 seconds is a useful default):
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
4. Analyze it offline: `ohos-perf analyze <dir> --json`
   - A scene captured with `--hiprofiler --plugins memory` carries exact
     per-process RSS: `mem.measure.rss.peak` and `mem.measure.rss.avg`, both
     in bytes. They cover only the analyzed app (`--app`); an app-less
     analysis reports `mem.measure.degraded` with the reason rather than
     attributing device-wide rows to an app.
5. Read `evidence[].drillDown`. Each handle names a `tool`, its `args`, and a
   one-line `returns` shape with an optional `estRows`.

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

## Output contract

`--json` output is the same structure the library returns. Evidence is ordered
by `(kind, window.startNs, id)`, so repeated runs over the same scene and the
same query arguments are byte-identical.
