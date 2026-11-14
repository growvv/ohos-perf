# 设计规范：@ohos-perf/core —— 鸿蒙性能调优基础包

- 日期：2026-11-14
- 状态：待评审
- 依据：`spike/PHASE_A_REPORT.md`、`spike/PHASE_B_REPORT.md`、HapRay 源码通读、DevEco 6.1.1 profiler jar 逆向

---

## 1. 问题陈述

### 1.1 现状

HapRay（ArkAnalyzer-HapRay）与 DevEco Studio 各自持有鸿蒙性能数据的一部分能力，但两者都**不可编程地复用**：

| 问题 | 具体表现 | 证据 |
|---|---|---|
| 能力隐式 | 采集失败返回空数组，调用方无法区分"设备没产生数据"与"设备不具备该能力" | Phase A：`native_hook`/`xpower_*`/`js_*` 在真机与模拟器上均为 0 行 |
| 通路硬编码 | HapRay 默认走 hiprofiler，模拟器无此组件则整链失效 | Phase B：`hiprofiler_cmd` 全家桶 MISSING |
| 语言封闭 | 分析逻辑与 Python + pandas + sqlite3 绑死 | `analyze/base_analyzer.py`、`frame_trace_accessor.py` |
| 输出面向人 | 产出 HTML/Excel 报告，不是可供 agent 逐层检索的证据结构 | `core/report.py` 1953 行 |
| 打包缺失 | `tools/` 目录缺失导致 `trace_streamer` 与 `sa-cmd` 找不到，静默失败 | Phase A §7 类别 4 |

### 1.2 目标

提供一个 TypeScript 包，使任何开发者或 agent 可以：

1. 对任意鸿蒙设备（真机/模拟器）**探测**其性能数据能力；
2. 用**统一 API** 采集、解析、分析性能数据；
3. 拿到**自带溯源与保真度标注**的结构化指标；
4. 拿到**可继续下钻的证据**，而非一次性报告。

### 1.3 非目标

- 不重写 HapRay 的报告渲染（HTML/Excel）
- 不提供 GUI
- 不替代 DevEco Profiler 的交互式时间线
- 不承诺在无 PMU 的设备上提供指令数/CPI

---

## 2. 核心设计决策

### D1：三条数据平面，六个并列采集器

**决策**：采集层不是一条链，而是六个独立 `Collector` 实现，各自声明能力。

**理由**：Phase B 证明同一指标在不同设备上通路不同（实时 FPS 在真机走 hidump-plugin、在模拟器走 hidumper）。任何"单一采集链"的设计都会在某一类设备上失效。

```
平面 A（富采集，需 hiprofilerd）  hiprofiler: ftrace/cpu/memory/gpu/xpower/network/diskio/hidump/nativehook/hisysevent
平面 B（轻采集，仅需 shell）      hitrace | hiperf | hidumper | procfs | uitest
平面 C（宿主解析，与设备无关）    trace_streamer → SQLite
```

### D2：能力矩阵是一等公民

**决策**：`Capability` 是显式类型；`Collector` 声明 `provides`，`Analyzer` 声明 `requires`；运行时解析为 `CapabilityMatrix`。

```ts
type CapabilityId =
  | 'trace.frames' | 'trace.sched' | 'trace.binder' | 'trace.thread_state'
  | 'perf.samples' | 'perf.pmu'
  | 'mem.procfs' | 'mem.native_hook' | 'mem.gpu'
  | 'render.fps_live' | 'render.hitch' | 'render.vsync'
  | 'ui.tree' | 'ui.gesture'
  | 'power.xpower' | 'net.io' | 'disk.io' | 'js.heap' | 'coverage'
  | 'startup.app_startup';

interface CapabilityState {
  id: CapabilityId;
  available: boolean;
  collector?: string;
  fidelity: 'exact' | 'approximate' | 'proxy';
  reason?: string;          // 不可用时的具体原因（含设备原始报错）
  probe: ProbeResult;       // 探测时执行了什么
}
```

**理由**：这是与 HapRay 最本质的差异。HapRay 的"空结果"无法诊断；我们的 `CapabilityState.reason` 携带设备原始报错（如 `Cannot set root run mode in undebuggable version.`），使 agent 能自主决定绕行。

### D3：指标携带溯源与保真度

```ts
interface Metric {
  id: string;                // 稳定语义 ID，如 'frame.jank.rate'
  value: number | string;
  unit: 'ms' | 'fps' | '%' | 'count' | 'bytes' | 'none';
  window?: TimeRange;
  provenance: {
    collector: string;       // 'hitrace+streamer' | 'hidumper' | 'hiprofiler'
    table?: string;          // 'frame_slice'
    rows?: number;
    device: string;
  };
  fidelity: 'exact' | 'approximate' | 'proxy';
  degraded?: { reason: string; fallback: string };
}
```

**理由**：模拟器 fps 来自 `hidumper fpsCount`（refresh-rate 计数）是 `proxy`；真机来自逐帧 `frame_slice` 是 `exact`。混用会得出错误结论。强制标注使错误不可能被静默传播。

### D4：证据图 + 下钻句柄

```ts
interface Evidence {
  id: string;
  kind: EvidenceKind;
  severity: 'info' | 'warn' | 'critical';
  subject: { process: string; thread?: string; frameNo?: number; pid?: number };
  window: TimeRange;
  signals: Record<string, number | string>;
  explain: string;
  drillDown: DrillDownHandle[];
}

interface DrillDownHandle {
  label: string;
  tool: string;                                  // 'frames.get' | 'binder.transactions' | 'sql'
  args: Record<string, unknown>;
  returns: string;                               // 结果形状的一句话描述
  estRows?: number;                              // 让 agent 预判体量
}
```

**理由**：这是"AI native"的落点。agent 不应被喂 249MB SQLite，而应先拿 `Evidence[]`，再按 `drillDown` 逐层取。`estRows` 让 agent 在调用前就知道代价。

### D5：确定性输出

**决策**：分析层禁止时间戳、随机数、依赖插入序的 Map 迭代、浮点累加顺序不确定。

**理由**：agent 迭代优化时，输入不变则输出必须不变，否则无法判断改动是否生效。所有输出数组显式排序。

### D6：零原生依赖优先

**决策**：SQLite 用 Node 内置 `node:sqlite`（Node ≥ 22.5），`better-sqlite3` 作为可选 peer 用于大库。

**理由**：作为"其他开发者依赖的包"，原生编译是分发灾难。`node:sqlite` 是同步 API，对 249MB 库的查询延迟可接受。

### D7：`.proto` 从 OpenHarmony 开源仓取，用 jar 校验

**决策**：hiprofiler 协议定义不手写、不逆向，而是从 OpenHarmony `developtools/profiler` 对应 tag 取 Apache-2.0 的 `.proto`，再用 DevEco jar 中嵌入的 `FileDescriptorProto` 校验字段号一致性。

**理由**：手写 proto 会在字段号上出错且无法验证；jar 里的 36 个顶层 message 与两个 service 是权威基准，可用于自动校验。校验脚本纳入 CI。

---

## 3. 架构

### 3.1 分层

```
L7  API / CLI / Skill
      Programmatic API · ohos-perf CLI · agent skill adapter
L6  Report
      Metric model · Evidence graph · Baseline comparison
L5  Analyze
      frames · jank · empty-frame · vsync · binder · threads · fault-tree
      memory · startup · ui · gc · components · flamegraph
L4  Query
      Typed accessors over 88 tables: FrameQuery SchedQuery CallstackQuery
      BinderQuery ProcessQuery MemoryQuery PerfQuery
L3  Ingest
      trace_streamer wrapper · scene artifact layout · db open/pragma
L2  Collectors
      hiprofiler(gRPC) | hitrace | hiperf | hidumper | procfs | uitest
L1  Device
      Device model · Capability probe · CapabilityMatrix · Emulator lifecycle
L0  Transport
      hdc client: shell · fport · file send/recv · targets · tconn
```

### 3.2 数据流

```
                   ┌──────────── CapabilityMatrix (探测一次，缓存) ────────────┐
                   │                                                          │
  device ──▶ Collector.select(requires) ──▶ raw artifacts ──▶ trace_streamer ──▶ trace.db
                   │                                                          │
                   └────────────▶ Analyzer(requires ⊂ available) ────────────┘
                                              │
                                       Metric[] + Evidence[]
                                              │
                                    Report / CLI / Skill
```

### 3.3 包结构

```
packages/
  core/                      @ohos-perf/core
    src/
      transport/hdc.ts
      device/{device,probe,capability,emulator}.ts
      collectors/{hiprofiler,hitrace,hiperf,hidumper,procfs,uitest}/
      ingest/{streamer,scene}.ts
      db/{driver,schema}.ts
      query/{frames,sched,callstack,binder,process,memory,perf}.ts
      analyze/{frames,binder,threads,fault-tree,memory,startup,ui}.ts
      report/{metric,evidence,compare}.ts
      index.ts
  cli/                       @ohos-perf/cli
  proto/                     .proto + extract/verify scripts
```

每个目录单一职责，可独立测试。`analyze/*` 是纯函数：输入 `Query` 句柄与 `TimeRange`，输出 `Metric[]`/`Evidence[]`，不碰 IO。

---

## 4. 核心接口

### 4.1 入口

```ts
import { connect } from '@ohos-perf/core';

const dev = await connect({ target: 'auto' });
// 或 { target: 'REDACTED-DEVICE-SERIAL' } / { target: '127.0.0.1:10178' }

const caps = await dev.capabilities();
// CapabilityState[]，含不可用原因

const session = await dev.collect({
  app: 'com.example.app',
  durationMs: 10_000,
  capabilities: ['trace.frames', 'trace.sched', 'perf.samples'],
  trigger: { type: 'coldStart', ability: 'EntryAbility' },   // 可选：绑定启动
});

const scene = await session.ingest();      // trace.db + perf.db
const report = await scene.analyze();      // { metrics, evidence }

for (const e of report.evidence) {
  console.log(e.severity, e.explain);
  for (const h of e.drillDown) console.log('  →', h.label, `(~${h.estRows} rows)`);
}
```

### 4.2 能力探测

```ts
interface Device {
  readonly id: string;
  readonly kind: 'real' | 'emulator';
  readonly abi: string;
  capabilities(): Promise<CapabilityState[]>;
  collect(opts: CollectOptions): Promise<CollectSession>;
  shell(cmd: string): Promise<ShellResult>;
  hidumper(service: string, args?: string): Promise<string>;
}
```

`raw()` 属于 `Scene` 而非 `Device`——逃生口针对的是解析后的 trace.db：

```ts
interface Scene {
  readonly dir: string;
  readonly traceDb: QueryHandle;
  readonly perfDb?: QueryHandle;
  raw(): QueryHandle;                                  // 直接对 trace.db 执行 SQL
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  analyze(opts?: AnalyzeOptions): Promise<Report>;
}
```

探测策略：一次性执行探针集（`which`、`param get`、`hiperf list`、`hidumper -ls`、`/proc` 可读性、`smode` 结果），结果缓存于 `CapabilityMatrix`。`ohos-perf doctor` 输出该矩阵的完整可读版本。

### 4.3 查询层

```ts
interface FrameQuery {
  all(range?: TimeRange): Promise<Frame[]>;
  actual(range?: TimeRange): Promise<Frame[]>;
  expect(range?: TimeRange): Promise<Frame[]>;
  stuttered(range?: TimeRange): Promise<Frame[]>;
  empty(range?: TimeRange): Promise<Frame[]>;
  mapped(): Array<{ src: Frame; dst: Frame }>;   // 经 frame_maps：跨进程同类型帧链接
  stats(range?: TimeRange): Promise<FrameStats>;
}
```

`Frame` 字段直接映射 `frame_slice`，并保留 `flag`/`type` 的语义枚举：

```ts
type FrameFlag = 0 | 1 | 2 | 3;   // 正常 / 卡顿 / 空帧 / RS-App异常
type FrameType = 0 | 1;           // 实际 / 期望
```

### 4.4 分析器契约

```ts
interface Analyzer {
  readonly id: string;
  readonly requires: CapabilityId[];
  run(ctx: AnalyzeContext): Promise<{ metrics: Metric[]; evidence: Evidence[] }>;
}

interface AnalyzeContext {
  trace: QueryHandle;
  perf?: QueryHandle;
  app: AppIdentity;        // { pids, processNames, packageName }
  window: TimeRange;
  caps: CapabilityMatrix;
}
```

引擎按 `requires ⊆ available` 选择执行；不满足则产出单条 `Metric`，`degraded.reason` 说明缺哪个能力、缺的探测证据是什么。

---

## 5. 分析层移植映射

| 分析器 | 数据源（表） | TS 模块 | 算法要点 | 移植难度 |
|---|---|---|---|---|
| 统一帧 | `frame_slice` `frame_maps` `perf_sample` | `analyze/frames` | flag/type 语义；`frame_maps` 为跨进程同类型帧链接（**非** actual/expect 配对，已实测证伪）；帧负载 = 帧窗口内 `event_count` 累加 | 中 |
| 空帧 + 唤醒链 | `frame_slice(flag=2)` `instant` `thread_state` `callstack` | `analyze/empty-frame` | 正向 flag=2；反向 RS skip 追溯；唤醒链 BFS | 高 |
| VSync 异常 | `frame_slice.vsync` `callstack` | `analyze/vsync` | 只有实际帧无期望帧 / 反之；符号匹配 `VSyncCallBackListener` | 中 |
| IPC Binder | `callstack` `data_dict` `thread` `process` | `analyze/binder` | `transaction id` 配对请求/响应；按进程/线程/接口三维聚合 | 中 |
| 冗余线程 | `sched_slice` `thread_state` `callstack` `perf_sample` | `analyze/threads` | 0–100 加权分：等待比、指令数、yield、短周期、运行比 | 中 |
| 故障树 | `callstack.name` LIKE 模式 | `analyze/fault-tree` | 事件名正则；arkui/RS/av/audio 四类 | 低 |
| 内存 | `native_hook` / `/proc/<pid>/status` | `analyze/memory` | 双通路；native 优先，降级 RSS/VmHWM | 中 |
| 冷启动 | `app_startup` / 首帧序列 | `analyze/startup` | 表优先；无表时用首帧 ts − `aa start` 时刻 | 中 |
| UI 动画 | inspector JSON + 截图 | `analyze/ui` | 组件树 diff + 区域图像 diff | 高 |
| GC | trace GC 事件 | `analyze/gc` | 事件计数与停顿 | 低 |
| 火焰图 | `perf_sample` `perf_callchain` `symbols` | `analyze/flamegraph` | 调用栈聚合 | 中 |

**移植原则**：SQL 查询逐字保留（含 `LEFT JOIN` 与过滤条件），只把 pandas 后处理改写成 TS 数组操作。这样可用同一份 trace.db 对拍验证——Python 输出与 TS 输出逐字段比对。

---

## 6. 依赖

| 依赖 | 类型 | 获取方式 | 缺失时行为 |
|---|---|---|---|
| `hdc` | 外部二进制 | SDK 路径搜索 / `OHOS_PERF_HDC` | 硬失败，`doctor` 指出期望路径 |
| `trace_streamer` | 外部二进制 | DevEco 安装路径搜索 / `OHOS_PERF_STREAMER` / `--streamer` | 降级：无 SQLite，仅原始产物 |
| `@grpc/grpc-js` | npm dependency | — | 仅影响平面 A |
| `@grpc/proto-loader` | npm dependency | — | 同上 |
| `node:sqlite` | Node 内置（≥22.5） | — | 降级到 `better-sqlite3` peer |
| `better-sqlite3` | optional peer | — | 可选 |
| Python | **不依赖** | — | — |

**不打包 `trace_streamer`**：17MB，Huawei 授权不明，且随 DevEco 版本更新。改为解析路径 + 版本校验（要求 ≥ 4.3.0，实测 4.3.7 可用）。

---

## 7. 能力矩阵（设计期基线）

| 能力 | 真机 | 模拟器 | 通路 |
|---|---|---|---|
| `trace.frames` | ✅ exact | ✅ exact | hitrace → frame_slice |
| `trace.sched` | ✅ exact | ✅ exact | hitrace → sched_slice |
| `trace.binder` | ✅ exact | ✅ exact | hitrace → callstack |
| `trace.thread_state` | ✅ exact | ✅ exact | hitrace → thread_state |
| `perf.samples` | ✅ exact | ⚠️ debug-app-only | hiperf `--app` |
| `perf.pmu` | ✅ exact | ❌ | hiperf `hw-*`（QEMU 无 PMU） |
| `mem.procfs` | ✅ exact | ✅ exact | `/proc/<pid>/status` |
| `mem.native_hook` | ✅ | ❌ | hiprofiler nativehook |
| `mem.gpu` | ✅ | ❌ | hiprofiler memory-plugin |
| `render.fps_live` | ✅ | ⚠️ proxy | hidump-plugin / hidumper fpsCount |
| `render.hitch` | ✅ | ✅ | hidumper hitchs |
| `render.vsync` | ✅ | ✅ | frame_slice.vsync |
| `ui.tree` | ✅ | ✅ | uitest dumpLayout |
| `power.xpower` | ✅ | ❌ | hiprofiler xpower-plugin |
| `net.io` / `disk.io` | ✅ | ❌ | hiprofiler 插件 |
| `js.heap` | ✅ | ❌ | ArkTS profiler |
| `coverage` | ✅ | ❌ | bjc_cov |
| `startup.app_startup` | ✅ | ⚠️ 帧序列推导 | hiprofiler / 帧时序 |

---

## 8. CLI 与 Skill

```
ohos-perf doctor [--target <id>]              体检：hdc / streamer / 设备 / 能力矩阵
ohos-perf caps [--target <id>] [--json]       能力矩阵
ohos-perf collect --app <pkg> --duration 10s [--cold-start <ability>]
ohos-perf analyze <scene-dir> [--json]
ohos-perf query <scene-dir> <query> [--limit N]   下钻逃生口
ohos-perf emulator {list,start,stop,create}
```

CLI 输出默认人类可读；`--json` 输出与 API 相同的结构。Skill 适配层只做三件事：把 CLI 的 `--json` 结果转成工具定义、暴露 `query` 下钻、把 `Evidence.drillDown` 翻译成下一次调用。

---

## 9. 错误与降级

| 情形 | 行为 |
|---|---|
| hdc 不存在 | 抛 `HdcNotFoundError`，含搜索路径列表 |
| 设备未连接 | 抛 `DeviceNotFoundError`，附 `hdc list targets` 原始输出 |
| 能力缺失 | **不抛错**；`CapabilityState.available=false` + `reason` |
| 分析器依赖缺失 | 不抛错；产出 `degraded` 指标，说明缺什么 |
| trace_streamer 失败 | 保留原始产物，抛 `IngestError` 含 stderr |
| SQLite 表为空 | 返回空数组 + `Evidence(kind='no_data')`，附该表应有数据源 |

**原则**：只有"无法继续"才抛错；"能继续但缺数据"一律走降级并显式记录。

---

## 10. 测试策略

1. **对拍测试**：用 `spike/out/emu_big.db`、`real_device.db` 等真实 trace.db，比对 TS 分析输出与 HapRay Python 输出的逐字段一致性。这是移植正确性的唯一可信判据。
2. **能力矩阵测试**：录制真机与模拟器的探针原始输出，断言解析结果。
3. **确定性测试**：同一输入运行两次，断言 JSON 逐字节相同。
4. **降级测试**：注入能力缺失，断言产出 `degraded` 而非抛错或空值。
5. **协议测试**：`.proto` 字段号与 jar descriptor 一致性校验。

---

## 11. 分期

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0 底座** | transport · device · capability · streamer ingest · query(frames) · analyze(frames) · CLI doctor | 真机与模拟器均能产出帧指标与能力矩阵 |
| **P1 主分析** | binder · threads · fault-tree · memory(procfs) · startup | 对拍 HapRay 一致 |
| **P2 富采集** | hiprofiler gRPC · proto 提取校验 · nativehook/gpu/xpower | 真机平面 A 打通 |
| **P3 AI 层** | 证据图 · drillDown · CLI query · skill 适配 | agent 可端到端下钻 |

---

## 12. 开放问题

1. `node:sqlite` 在 249MB 库上的查询延迟需实测；若不可接受则默认 `better-sqlite3`。
2. `trace_streamer` 是否有 macOS/Linux 版本随 DevEco 分发——影响跨平台承诺。
3. hiprofiler 的 `hdc fport` 是 TCP 还是 unix socket 转发，需在真机确认后固定传输实现。
4. 空帧唤醒链的反向追溯是移植中最复杂部分，可能延后到 P1 末期。
