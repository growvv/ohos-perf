# ohos-perf

**HarmonyOS performance, made measurable.**

[![ci](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/growvv/ohos-perf/actions/workflows/ci.yml)
[![pages](https://github.com/growvv/ohos-perf/actions/workflows/pages.yml/badge.svg)](https://growvv.github.io/ohos-perf/)
[![license: MIT](https://img.shields.io/badge/license-MIT-22d3ee.svg)](LICENSE)

A TypeScript toolkit for HarmonyOS performance analysis. It turns an attached device
into structured, evidence-backed data: capability probing, six collectors,
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

**P1 through P7 are complete**: 990 tests (982 unit, 8 in the device project),
two workspace typechecks and two builds, all green on the declared minimum
Node (`22.13.0`). On a clean checkout — where the gitignored
`spike/out/emu_big.db` and `spike/out/real_device.db` fixtures and any
attached device are absent — `npm run test:unit` reports **957 passed, 25
skipped (2 files)**; the device project adds one fixture-backed probe test and
seven device-gated skips, so the combined clean checkout is **958 passed, 32
skipped**. With both fixtures present and a device attached all 990 pass. The
fixture-dependent suites are `e2e-offline`, `drilldown-e2e`, `parity-hapray`,
`analyze-thread-wakeup`, `query-binder-startup`, `query-callstack-perf`,
`query-sched-state` and the CLI `index` end-to-end tests. The eight tests in
the device project are `collect-hiprofiler.device.test.ts`,
`collect-capture.device.test.ts`, `analyze-capture.device.test.ts` and
`collect-memory.device.test.ts`. Seven of them need a device and run serially
(`npm run test:device`) because they share one device and its fixed capture
paths; the recorded Mate 60 hiprofiler probe runs from a committed fixture.

Implemented today:

- `hdc` transport: shell, port forwarding, file send/recv, target listing
- one-shot capability probe → 21 verdicts with evidence
- collectors: hitrace (marker checks, stale-file protection, stop-on-failure),
  procfs (`/proc` memory/thread sampling with `pidof` resolution), hiprofiler
  (`hiprofiler_cmd` sessions with the ftrace, nativehook, gpu and xpower
  plugins ported from HapRay, plus a memory plugin that records per-process
  `process_measure`; the `.htrace` converts through the same `trace_streamer`
  path), hiperf (`perf.data` for a debuggable app, converted into a second
  `perf.db`), hidumper (RenderService fps and hitch counters) and uitest (the
  on-screen UI tree); every requested collector runs concurrently in one
  `collect`. `--app` is
  required only by the modes that resolve a pid — `--hidumper`, `--uitest` and
  `--hiprofiler --plugins memory` capture device-wide without it
- baseline comparison: `ohos-perf compare <baseline> <current>` classifies each
  metric as improved, regressed, unchanged, added, removed or incomparable
- `trace_streamer` wrapper and scene layout, with `scene.json` metadata
  (device-uptime start marker, pids, collector list)
- typed queries over the 88-table trace database: frames, processes, threads,
  sched/instant, thread state, callstacks, perf samples, binder, startup
- named drill-down queries (`ohos-perf tools`, `ohos-perf query`) that resolve
  every `Evidence.drillDown` handle, and the agent skill adapter in
  `skill/ohos-perf/SKILL.md`
- analyzers: frames, fault tree (`fault.*`), binder (`binder.*`), threads
  (`thread.*`), memory (`mem.*`), memory measure (`mem.measure.*`, exact RSS
  from hiprofiler's `process_measure`), startup (`startup.*`), render
  (`render.*`), GC pressure (`gc.*`), VSync anomalies (`vsync.*`), empty
  frames with HapRay's false-positive filters (`empty_frame.*`), RenderService
  skips reverse-traced through NativeWindow (`rs_skip.*`), folded flamegraph
  stacks (`flamegraph.*`) and ArkUI component reuse (`components.*`), driven
  by an offline capability matrix derived from table presence
- `Metric` / `Evidence` models with provenance, fidelity and drill-down ids,
  plus the degraded-metric engine that skips analyzers whose inputs are absent
- `ohos-perf` CLI: `doctor`, `caps`, `collect`, `analyze`, `query`, `tools`,
  `compare`, `emulator {list,start,stop,create}`
- emulator lifecycle: `EmulatorClient` (spawn + parse) and `EmulatorLifecycle`
  (state + waiting) drive DevEco's `Emulator.exe`, attributing each running
  instance to its `hdc` TCP target so `collect --target` can use it

Metric ids emitted by the analyzers:

| Prefix | Analyzer | Examples |
| --- | --- | --- |
| `fault.*` | fault tree | `fault.arkui.HandleOnAreaChangeEvent`, `fault.RS.DisplayNodeSkipTimes` |
| `binder.*` | binder | `binder.transactions.count`, `binder.latency.avg` |
| `thread.*` | threads | `thread.patterns.count`, `thread.redundant.count` |
| `mem.*` | memory | `mem.rss.*`, `mem.pss.*` |
| `mem.measure.*` | memory measure | `mem.measure.rss.peak`, `mem.measure.rss.avg` |
| `startup.*` | startup | `startup.count`, `startup.duration` |
| `render.*` | render | `render.fps.live` (proxy), `render.hitch.count` |
| `gc.*` | GC pressure | `gc.partial.count`, `gc.rate`, `gc.perf.share` |
| `vsync.*` | VSync anomalies | `vsync.anomaly.rate`, `vsync.mismatch.count` |
| `empty_frame.*` | empty frames | `empty_frame.count`, `empty_frame.rate` |
| `rs_skip.*` | RenderService skips | `rs_skip.frames.count`, `rs_skip.trace.accuracy` |
| `flamegraph.*` | folded stacks | `flamegraph.app.share`, `flamegraph.stacks.count` |
| `components.*` | component reuse | `components.reuse.rate`, `components.top.name` |

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

Measured on the two recorded traces, `analyze` reports 56 metrics and 92
evidence items on `emu_big` (20.8 MB) and 55 metrics and 178 evidence items on
`real_device` (13.1 MB). Four of the new analyzers report real numbers there:
`vsync.signals.count` 60 with `vsync.periods.count` 7 and `vsync.anomaly.rate`
101.67 on `emu_big` (0 / 0 / 0 on `real_device`), `empty_frame.count` 6 with a
10% rate on `emu_big` (160 and 100% on `real_device`), `rs_skip.frames.count` 4
with `rs_skip.trace.accuracy` 100 on `real_device`, and `gc.partial.count` 2
with `gc.rate` 0.75 on `real_device`. The flamegraph degrades on both traces
because `perf_sample` is empty — a hitrace capture has no CPU samples — and
component reuse reports 0 builds, a measured zero: neither capture recorded
ArkUI build events. The flamegraph's proxy names its missing input; the reuse
count is real and zero.

Not implemented yet: `ui.gesture` and `coverage`, plus HapRay's UI animation
diff. The animation diff needs `ui/<step>/pages.json`, two element-tree dumps
and two screenshots per step, which HapRay's CaptureUI produces and no collector
here does; the trace-side component signal (`H:CustomNode:Build*`) is ported
instead. `js.heap` stays unavailable even on a device whose hiprofiler can run
the memory plugin: nothing in this package consumes the `js_heap_*` tables, and
the matrix reports that reason instead of claiming the data is usable.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| P0–P6 | capability probing, six collectors, trace ingest, typed queries, fourteen analyzers, deterministic JSON, baseline comparison, agent skill | shipped in `0.2.0` |
| P7 | `ohos-perf emulator {list,start,stop,create}` lifecycle commands | in `master`, unreleased |
| exploring | `ui.gesture` (AAMS), `coverage` (bjc_cov), `js.heap` (ArkTS profiler) — each stays reported unavailable until a device spike proves this package can drive it | device spike first |

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

# everything at once: perf samples, render counters and the UI tree
ohos-perf collect \
  --app com.example.app --duration 10s --out ./full-scene \
  --procfs --hiperf --hidumper --uitest --json

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

Compare two captures — each argument is a scene directory or a saved
`analyze --json` file:

```bash
ohos-perf compare ./before ./after --json
```

Analyze it offline — no device or toolchain needed:

```bash
ohos-perf analyze ./scene --app com.example.app --json
```

Follow an evidence item's `drillDown` handle — list the query names and their
argument schemas first, then pass the handle's `tool` and `args` verbatim:

```bash
ohos-perf tools --json
ohos-perf query ./scene frames.get \
  --args '{"id":42}' --json
```

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

`target` is absent when the instance is not running, or when more than one
instance (or more than one connected TCP target) makes attribution ambiguous;
in that case `targetReason` says which. Start the instance first, or pass the id
from `hdc list targets` yourself.

`start` blocks until `bootevent.boot.completed` reads `true` on the guest, so a
capture never races the boot. It takes `--timeout <seconds>` (default 180) and
reports how long the boot took; starting an instance that is already up is a
safe no-op that says so. A timeout never kills the emulator — the message names
the `stop` command that removes it.

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

npm test        # 990 tests; 958 pass + 32 skip on a clean checkout (no device, spike/out/ absent)
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

Measured on 2026-11-16 (Mate 60) and 2026-11-14 (emulator):

| Device | Available | Notes |
| --- | --- | --- |
| HUAWEI Mate 60, OpenHarmony 7.0.0.111, arm64-v8a | **20 / 21** | hardware PMU, hiprofiler (including `memory-plugin`), uitest and Ark-runtime trace events present; `js.heap` unavailable — no analyzer in this package consumes `js_heap_*` tables |
| HarmonyOS emulator 6.1.1.125, x86_64 | **10 / 21** | no hiprofiler; `perf.pmu` has no hardware events; `render.fps_live` is a `proxy`. `trace.ark` is available because `hitrace` records the `ark` and `ace` categories. The live probe did not run `uitest`, so `ui.tree` and `ui.gesture` stay out of this numerator — a matrix built from the committed emulator probe snapshot reports 12 / 21 |

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
L5  Analyze                frames · fault tree · binder · threads · memory · memory measure · startup · render · gc · vsync · empty frame · rs skip · flamegraph · components
L4  Query                  typed accessors over 88 trace tables
L3  Ingest                 trace_streamer wrapper · scene layout · scene.json · db handles
L2  Collectors             hitrace · procfs · hiprofiler · hiperf · hidumper · uitest
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

当前 P0–P6 均已实现：hdc 传输、能力矩阵、hitrace / procfs / hiprofiler / hiperf /
hidumper / uitest 采集、trace_streamer 入库（含 perf.data → perf.db）、类型化查询、
帧 / 故障树 / binder / 线程 / 内存 / 内存测量 / 启动 / 渲染 / GC 压力 / VSync 异常 /
空帧 / RenderService 跳过 / 火焰图 / 组件复用共十四个分析器、降级指标引擎、证据图与
命名下钻查询、基线对比，以及 `doctor` / `caps` / `collect` / `analyze` / `query` /
`tools` / `compare` 七个命令和 `skill/ohos-perf/` 中的 agent skill 适配器。内存测量
（`mem.measure.*`）来自 hiprofiler memory-plugin 记录的 `process_measure` 表，
以 ipid 归属进程、把 KiB 换算成字节后报告 exact 的 RSS 峰值与均值；无应用采集时
不带进程归属，显式降级而不是把全设备的行算到应用头上。录制的真实 trace
已将 binder、线程与故障树分析器的逐字段输出与 HapRay 修订 `9386e4e` 对齐；线程评分与
组件复用另有一个由 HapRay 生成的合成 golden，专门覆盖真实 trace 拿不到的路径——前者
需要冗余线程模式，后者需要 `H:CustomNode:Build*` 事件，而两条 trace 都没有。VSync、
空帧与 RenderService 跳过在各自测试中复现 HapRay 的每条规则与误报过滤，其输出也对着
HapRay 在两条录制 trace 上核对过。内存、启动、GC 与火焰图没有能在这些 trace 上运行的
HapRay 实现，不声称对齐。`ui.gesture` 与 `coverage` 仍待实现；`js.heap` 即使在能运行
hiprofiler 的真机上也不可用，因为本包没有任何分析器消费 `js_heap_*` 表，能力矩阵
会据实给出该原因。`--app` 仅对需要解析 pid 的采集器必填；`--hidumper`、`--uitest`
与 `--hiprofiler --plugins memory` 可以无应用采集。

`--hiperf` 需要可调试应用，空闲应用产生 `samples: 0` 也是一次有效采集，CLI 会明确
打印 `hiperf 0` 而不是省略。`compare` 把每个指标标为 improved / regressed /
unchanged / added / removed / incomparable，其中 `incomparable` 表示方向未知，而不是
没有变化。

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Huawei or the OpenHarmony project. Device names are used for
identification only.
