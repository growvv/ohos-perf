# @ohos-perf/core P0 底座 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `@ohos-perf/core` 的 P0 底座——能在真机与模拟器上探测设备能力、采集 trace、用 `trace_streamer` 解析成 SQLite、并提供带溯源与保真度标注的帧指标与证据。

**Architecture:** 七层分层，但 P0 只实现其中五层的骨架：L0 Transport（hdc 客户端）、L1 Device（设备模型 + 能力探测 + 能力矩阵）、L2 Collectors（hitrace 与 hiperf 两个采集器）、L3 Ingest（trace_streamer 封装 + 场景目录）、L4 Query（帧与进程/线程访问器）、L5 Analyze（帧分析器）、L6 Report（Metric/Evidence 模型）。每个分析器是纯函数，输入查询句柄与时间窗，输出 `Metric[]` 与 `Evidence[]`。

**Tech Stack:** TypeScript 5.x、Node ≥ 22.13（使用内置 `node:sqlite`）、`tsup` 打包、`vitest` 测试、`commander` 做 CLI。无原生依赖，无 Python 依赖。（2026-11-15 更正：实测 `node:sqlite` 无 flag 需 22.13+，23.0–23.3 不支持，据此修正版本下限。）

**Spec:** `E:/CodeE/vibe51/emulator_compelate/design/2026-11-14-ohos-perf-core-design.md`

## Global Constraints

- Node 版本下限：`^22.13.0 || >=23.4.0`（`node:sqlite` 内置；23.0–23.3 不支持）。实测环境 Node v26.13.0。
- 禁止原生编译依赖。SQLite 只用 `node:sqlite`。
- 不打包 `trace_streamer`（17MB，授权不明）。只做路径搜索 + 版本校验，最低版本 `4.3.0`（实测 4.3.7）。
- 时间戳单位：`frame_slice.ts`、`trace_range.start_ts` 等全部为**纳秒**。
- `frame_slice.type_desc` 的真实值是 `'actural'`（数据源本身拼写错误，不是 `'actual'`）。任何按该字段匹配的代码必须用 `'actural'`。
- `frame_slice.flag` 语义：`0` 正常、`1` 卡顿、`2` 空帧、`3` RS-App 异常。
- `frame_slice.type` 语义：`0` 实际帧、`1` 期望帧。
- 所有对外输出数组必须显式排序，禁止依赖 Map 迭代序、时间戳或随机数（确定性要求，Spec D5）。
- 能力缺失一律走降级（`degraded`/`available:false` + `reason`），只有"无法继续"才抛错（Spec §9）。
- 包名 `@ohos-perf/core`，CLI 包名 `@ohos-perf/cli`，CLI 可执行名 `ohos-perf`。

## Review Focus

- **`trace_streamer` 路径含空格**：DevEco 默认装在 `D:/Application/DevEco Studio/...`，路径含空格。若用字符串拼接命令而不做引号处理，解析会静默失败。测试必须覆盖含空格路径。
- **Git Bash / MSYS 路径转换**：`hdc file recv /data/local/tmp/x.htrace out/` 在 Windows Git Bash 下会被改写成 `D:/.../data/local/tmp/...`。实现必须在 spawn 时设置 `MSYS_NO_PATHCONV=1`，且测试覆盖设备绝对路径。
- **设备返回空表而非报错**：`frame_slice` 为空可能意味着"桌面静止无重绘"（Phase B 实测：空闲 3 秒 0 帧）而非采集失败。分析器必须产出 `no_data` 证据并附解释，不能返回 `[]` 了事。
- **hdc 端口静默失败**：`Emulator.exe -start -hdcPort 5555` 退出码为 0 但不启动（合法范围 10000–16555）。设备连接逻辑不能以退出码判定成功。
- ~~**`node:sqlite` 对大库的延迟**：249MB 的 trace.db 未实测。~~ **已实测（2026-11-15，Task 5）**：249MB 是输入 `.htrace`，其转换出的 SQLite 是 17.9MB / 88 表。在 `node:sqlite` 上：打开 2.8ms、全帧有序查询 0.2ms、帧+双 JOIN 0.9ms、`sched_slice` COUNT 2.2ms、`thread_state` COUNT 4.5ms、`callstack` COUNT 4.5ms。全部远低于 2 秒阈值，**不需要 `better-sqlite3` 切换边界**，D6（零原生依赖）成立。
- **期望帧的 flag 多为 NULL**：实测 249MB trace 中，`type_desc='expect'` 的 169 行里有 161 行 `flag` 为 NULL，仅 8 行为整数。HapRay 全链路带 `WHERE flag IS NOT NULL`，因此 `expect()` 返回的帧数远少于期望帧总数，这是**既有行为而非缺陷**。任何按期望帧计数的指标必须知道这一点，否则会误判为采集不全。

---

## 文件结构

```
emulator_compelate/
  package.json                          workspace 根
  tsconfig.base.json
  packages/
    core/
      package.json
      tsconfig.json
      src/
        index.ts                        公共导出面
        errors.ts                       错误类型
        types.ts                        共享类型（TimeRange、AppIdentity 等）
        transport/
          hdc.ts                        hdc 客户端：targets/tconn/shell/file/fport
        device/
          device.ts                     Device 实现
          probe.ts                      探针集执行与解析
          capability.ts                 能力定义与矩阵解析
        collectors/
          types.ts                      Collector 接口
          hitrace.ts                    hitrace 采集器（P0）
          hiperf.ts                     hiperf 采集器（P1，本计划不实现）
        ingest/
          streamer.ts                   trace_streamer 封装
          scene.ts                      场景目录布局与 Scene 对象
        db/
          driver.ts                     SQLite 打开与查询（node:sqlite 封装）
        query/
          frames.ts                     FrameQuery
          process.ts                    ProcessQuery / ThreadQuery
        analyze/
          types.ts                      Analyzer 接口与 AnalyzeContext
          frames.ts                     帧分析器
        report/
          metric.ts                     Metric 构造与保真度
          evidence.ts                   Evidence 构造与下钻句柄
    cli/
      package.json
      src/index.ts                     ohos-perf 命令入口
  test/
    fixtures/
      probe-real.txt                  真机探针录制输出
      probe-emulator.txt              模拟器探针录制输出
    ...
```

P0 的边界：`collectors/hiprofiler`、`analyze/{binder,threads,fault-tree,memory,startup,ui}`、`proto/` 均不在本计划内（P1/P2）。

---

### Task 1: 工作区骨架与错误类型

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/types.ts`
- Test: `packages/core/test/errors.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class OhosPerfError extends Error`，构造参数 `(message: string, opts?: { cause?: unknown; code?: string })`，字段 `code?: string`
  - `class HdcNotFoundError extends OhosPerfError`，字段 `searchedPaths: string[]`
  - `class DeviceNotFoundError extends OhosPerfError`，字段 `targetsOutput: string`
  - `class StreamerNotFoundError extends OhosPerfError`，字段 `searchedPaths: string[]`
  - `class IngestError extends OhosPerfError`，字段 `stderr: string`
  - `type TimeRange = { startNs: number; endNs: number }`
  - `type AppIdentity = { packageName: string; pids: number[]; processNames: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/errors.test.ts
import { describe, it, expect } from 'vitest';
import { HdcNotFoundError, IngestError, OhosPerfError } from '../src/errors';

describe('errors', () => {
  it('HdcNotFoundError carries searched paths', () => {
    const e = new HdcNotFoundError(['/a/hdc', '/b/hdc']);
    expect(e).toBeInstanceOf(OhosPerfError);
    expect(e.searchedPaths).toEqual(['/a/hdc', '/b/hdc']);
    expect(e.message).toContain('/a/hdc');
  });

  it('IngestError carries stderr and code', () => {
    const e = new IngestError('streamer failed', 'boom', 'STREAMER_EXIT_1');
    expect(e.stderr).toBe('boom');
    expect(e.code).toBe('STREAMER_EXIT_1');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/errors.test.ts`
Expected: FAIL — 无法解析 `../src/errors`

- [ ] **Step 3: 实现骨架与错误类型**

`package.json`（根，workspace）：
```json
{
  "name": "ohos-perf-workspace",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "build": "npm run build -w @ohos-perf/core",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsup": "^8.3.0",
    "@types/node": "^22.7.0"
  }
}
```

`tsconfig.base.json`：`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`declaration: true`。

`packages/core/package.json`：`name: "@ohos-perf/core"`、`type: "module"`、`exports` 指向 `dist/index.js` 与 `dist/index.d.ts`、`engines.node: ">=22.13.0"`。

`errors.ts` 按 Interfaces 定义五个类。基类：
```ts
export class OhosPerfError extends Error {
  readonly code?: string;
  constructor(message: string, opts: { cause?: unknown; code?: string } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
  }
}
```
`HdcNotFoundError` 的 message 必须包含 `searchedPaths.join(', ')`。

`types.ts` 定义 `TimeRange` 与 `AppIdentity`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/errors.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git init && git add -A
git commit -m "chore: scaffold @ohos-perf workspace with error types"
```

---

### Task 2: hdc 传输层

**Files:**
- Create: `packages/core/src/transport/hdc.ts`
- Test: `packages/core/test/hdc.test.ts`

**Interfaces:**
- Consumes: `HdcNotFoundError`, `DeviceNotFoundError`（Task 1）
- Produces:
  - `interface HdcOptions { hdcPath?: string; env?: NodeJS.ProcessEnv }`
  - `class Hdc`，构造 `(opts?: HdcOptions)`
  - `Hdc.resolvePath(): Promise<string>` —— 搜索顺序：`opts.hdcPath` → `env.OHOS_PERF_HDC` → 常见 SDK 路径 → PATH 上的 `hdc`
  - `Hdc.listTargets(): Promise<Array<{ id: string; connected: boolean; raw: string }>>`
  - `Hdc.tconn(target: string): Promise<void>`
  - `Hdc.shell(target: string, cmd: string): Promise<{ stdout: string; stderr: string; code: number }>`
  - `Hdc.recv(target: string, devicePath: string, localPath: string): Promise<void>`
  - `Hdc.send(target: string, localPath: string, devicePath: string): Promise<void>`
  - `Hdc.fport(target: string, local: number, remote: number): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/hdc.test.ts
import { describe, it, expect } from 'vitest';
import { Hdc } from '../src/transport/hdc';

describe('Hdc', () => {
  it('builds argv for shell without shell-quoting the device path', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const argv = hdc.buildArgv('shell', { target: '127.0.0.1:10178', cmd: 'ls /data/local/tmp' });
    expect(argv).toEqual(['-t', '127.0.0.1:10178', 'shell', 'ls /data/local/tmp']);
  });

  it('sets MSYS_NO_PATHCONV in spawned env', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const env = hdc.buildEnv({ PATH: '/usr/bin' });
    expect(env.MSYS_NO_PATHCONV).toBe('1');
  });

  it('builds argv for recv with device path unmodified', () => {
    const hdc = new Hdc({ hdcPath: 'C:/fake/hdc.exe' });
    const argv = hdc.buildArgv('recv', {
      target: 't1', devicePath: '/data/local/tmp/a.htrace', localPath: 'out/a.htrace',
    });
    expect(argv).toEqual(['-t', 't1', 'file', 'recv', '/data/local/tmp/a.htrace', 'out/a.htrace']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/hdc.test.ts`
Expected: FAIL — `Hdc` 未定义

- [ ] **Step 3: 实现 `Hdc`**

`buildArgv(op, params)` 是纯函数，便于测试。`shell` 的命令作为**单个 argv 元素**传递（不经 shell），避免引号问题。`recv`/`send` 分别产出 `['-t', target, 'file', 'recv', device, local]` 与 `['-t', target, 'file', 'send', local, device]`。

`buildEnv(base)` 返回 `{ ...base, MSYS_NO_PATHCONV: '1' }`。

`resolvePath()` 搜索顺序与失败时抛 `HdcNotFoundError(searchedPaths)`。常见路径包含：
- `D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe`
- `C:/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe`
- 以及 `%LOCALAPPDATA%/Huawei/Sdk` 下的同构路径

`run()` 用 `child_process.spawn`，不经 shell（`shell: false`），以 `buildEnv` 为 env。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/hdc.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/transport/hdc.ts packages/core/test/hdc.test.ts
git commit -m "feat: add hdc transport with MSYS path-conversion guard"
```

---

### Task 3: 能力定义与矩阵

**Files:**
- Create: `packages/core/src/device/capability.ts`
- Test: `packages/core/test/capability.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type CapabilityId`（Spec §2 D2 的完整联合类型）
  - `type Fidelity = 'exact' | 'approximate' | 'proxy'`
  - `interface ProbeResult { command: string; stdout: string; stderr: string; code: number }`
  - `interface CapabilityState { id: CapabilityId; available: boolean; collector?: string; fidelity: Fidelity; reason?: string; probe: ProbeResult }`
  - `class CapabilityMatrix`，构造 `(states: CapabilityState[])`
    - `has(id: CapabilityId): boolean`
    - `get(id: CapabilityId): CapabilityState | undefined`
    - `all(): CapabilityState[]`（按 `id` 字典序排序）
    - `satisfies(required: CapabilityId[]): { ok: boolean; missing: CapabilityState[] }`
  - `function buildMatrix(input: CapabilityInputs): CapabilityMatrix`
  - `interface CapabilityInputs`：`{ abi: string; isEmulator: boolean; binaries: Record<string, boolean>; hiperfHwEvents: string[]; hiperfSwEvents: string[]; probes: Record<string, ProbeResult> }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/capability.test.ts
import { describe, it, expect } from 'vitest';
import { CapabilityMatrix, buildMatrix } from '../src/device/capability';
import type { CapabilityState, ProbeResult } from '../src/device/capability';

const p = (cmd: string, out = ''): ProbeResult => ({ command: cmd, stdout: out, stderr: '', code: 0 });

describe('buildMatrix', () => {
  it('marks frames available when hitrace exists', () => {
    const m = buildMatrix({
      abi: 'aarch64', isEmulator: false,
      binaries: { hitrace: true, hiperf: true, hidumper: true, hiprofiler_cmd: true },
      hiperfHwEvents: ['hw-cpu-cycles'], hiperfSwEvents: ['sw-cpu-clock'],
      probes: { hitrace: p('which hitrace', '/bin/hitrace') },
    });
    const s = m.get('trace.frames')!;
    expect(s.available).toBe(true);
    expect(s.collector).toBe('hitrace');
    expect(s.fidelity).toBe('exact');
  });

  it('marks pmu unavailable with reason on emulator without hw events', () => {
    const m = buildMatrix({
      abi: 'x86_64', isEmulator: true,
      binaries: { hitrace: true, hiperf: true, hidumper: true },
      hiperfHwEvents: [], hiperfSwEvents: ['sw-cpu-clock'],
      probes: { 'hiperf list hw': p('hiperf list hw', '') },
    });
    const s = m.get('perf.pmu')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('no hardware PMU events');
  });

  it('marks native_hook unavailable when hiprofiler_cmd absent', () => {
    const m = buildMatrix({
      abi: 'x86_64', isEmulator: true,
      binaries: { hitrace: true, hiperf: true, hidumper: true },
      hiperfHwEvents: [], hiperfSwEvents: [],
      probes: { 'which hiprofiler_cmd': p('which hiprofiler_cmd', 'MISSING') },
    });
    const s = m.get('mem.native_hook')!;
    expect(s.available).toBe(false);
    expect(s.reason).toContain('hiprofiler');
  });

  it('satisfies reports missing capabilities sorted by id', () => {
    const m = new CapabilityMatrix([
      { id: 'perf.pmu', available: false, fidelity: 'exact', reason: 'x', probe: p('a') },
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('b') },
    ]);
    const r = m.satisfies(['trace.frames', 'perf.pmu', 'mem.gpu']);
    expect(r.ok).toBe(false);
    expect(r.missing.map((s) => s.id)).toEqual(['mem.gpu', 'perf.pmu']);
  });

  it('all() is deterministically sorted', () => {
    const m = new CapabilityMatrix([
      { id: 'ui.tree', available: true, fidelity: 'exact', probe: p('a') },
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: p('b') },
    ]);
    expect(m.all().map((s) => s.id)).toEqual(['trace.frames', 'ui.tree']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/capability.test.ts`
Expected: FAIL — `buildMatrix` 未定义

- [ ] **Step 3: 实现 `capability.ts`**

`buildMatrix` 的判定规则（每条都要落到代码，`reason` 用测试里断言的原文）：

| 能力 | 可用条件 | collector | fidelity |
|---|---|---|---|
| `trace.frames`/`trace.sched`/`trace.binder`/`trace.thread_state` | `binaries.hitrace` | `hitrace` | `exact` |
| `perf.samples` | `binaries.hiperf` | `hiperf` | `exact` |
| `perf.pmu` | `hiperfHwEvents.length > 0` | `hiperf` | `exact` |
| `mem.procfs` | 恒 `true`（`/proc` 可读） | `procfs` | `exact` |
| `mem.native_hook` | `binaries.hiprofiler_cmd` | `hiprofiler` | `exact` |
| `mem.gpu` | `binaries.hiprofiler_cmd` | `hiprofiler` | `exact` |
| `render.fps_live` | `binaries.hidumper` | `hidumper` | 真机 `exact` / 模拟器 `proxy` |
| `render.hitch` | `binaries.hidumper` | `hidumper` | `exact` |
| `render.vsync` | `binaries.hitrace` | `hitrace` | `exact` |
| `ui.tree` | `binaries.uitest` | `uitest` | `exact` |
| `power.xpower`/`net.io`/`disk.io`/`js.heap`/`coverage` | `binaries.hiprofiler_cmd` | `hiprofiler` | `exact` |
| `startup.app_startup` | `binaries.hiprofiler_cmd` | `hiprofiler` | `exact` |

不可用时的 `reason` 文案固定：
- `perf.pmu` 无硬件事件：`'no hardware PMU events reported by hiperf list hw'`
- 依赖 `hiprofiler_cmd` 的能力缺失：`'hiprofiler not present on device (hiprofiler_cmd missing)'`
- 其他二进制缺失：`` `${binary} not present on device` ``

`all()` 与 `satisfies().missing` 均按 `id` 字典序排序。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/capability.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/device/capability.ts packages/core/test/capability.test.ts
git commit -m "feat: add capability model and matrix with degradation reasons"
```

---

### Task 4: 设备探针

**Files:**
- Create: `packages/core/src/device/probe.ts`
- Test: `packages/core/test/probe.test.ts`
- Create: `test/fixtures/probe-real.txt`
- Create: `test/fixtures/probe-emulator.txt`

**Interfaces:**
- Consumes: `Hdc`（Task 2）、`CapabilityInputs`（Task 3）、`ProbeResult`（Task 3）
- Produces:
  - `interface ProbeRunner { shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> }`
  - `interface DeviceIdentity { abi: string; productName: string; softwareVersion: string; osFullName: string; deviceType: string; isEmulator: boolean }`
  - `interface ProbeSnapshot { identity: DeviceIdentity; binaries: Record<string, boolean>; hiperfHwEvents: string[]; hiperfSwEvents: string[]; probes: Record<string, ProbeResult> }`
  - `async function runProbe(runner: ProbeRunner): Promise<ProbeSnapshot>`
  - `function parseBinaries(whichOutputs: Record<string, string>): Record<string, boolean>`
  - `function parseHiperfEvents(listOutput: string): { hw: string[]; sw: string[] }`

- [ ] **Step 1: 录制并保存 fixtures**

先用手上证据构造两个 fixture 文件（真机取 `spike/logs/probe_*.log` 与 Phase A 记录；模拟器取 Phase B 记录）。格式为每行 `CMD\tSTDOUT_ESCAPED`：

`test/fixtures/probe-emulator.txt` 关键行（Phase B 实测值）：
```
param get const.product.cpu.abilist	x86_64
param get const.product.name	emulator
param get const.product.software.version	emulator 6.1.0.126(SP1DEVC00E120R4P11)
param get const.ohos.fullname	OpenHarmony-6.1.1.125
param get const.product.devicetype	phone
which hiprofiler_cmd	MISSING
which hiperf	/bin/hiperf
which hitrace	/bin/hitrace
which hidumper	/bin/hidumper
which uitest	/bin/uitest
hiperf list hw	Supported events for hardware:\n
```

- [ ] **Step 2: 写失败测试**

```ts
// packages/core/test/probe.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBinaries, parseHiperfEvents, runProbe } from '../src/device/probe';

function fixtureRunner(path: string) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const table = new Map<string, string>();
  for (const line of lines) {
    const [cmd, ...rest] = line.split('\t');
    table.set(cmd, rest.join('\t').replace(/\\n/g, '\n'));
  }
  return {
    calls: [] as string[],
    async shell(cmd: string) {
      this.calls.push(cmd);
      return { stdout: table.get(cmd) ?? '', stderr: '', code: 0 };
    },
  };
}

describe('parseBinaries', () => {
  it('treats MISSING and empty output as absent', () => {
    expect(parseBinaries({ hiperf: '/bin/hiperf', hitrace: 'MISSING', uitest: '' }))
      .toEqual({ hiperf: true, hitrace: false, uitest: false });
  });
});

describe('parseHiperfEvents', () => {
  it('splits hw and sw event lists', () => {
    const out = 'Supported events for hardware:\nhw-cpu-cycles\nhw-instructions\n'
      + 'Supported events for software:\nsw-cpu-clock\nsw-task-clock\n';
    expect(parseHiperfEvents(out)).toEqual({
      hw: ['hw-cpu-cycles', 'hw-instructions'],
      sw: ['sw-cpu-clock', 'sw-task-clock'],
    });
  });

  it('returns empty hw list when header present but no events', () => {
    expect(parseHiperfEvents('Supported events for hardware:\n').hw).toEqual([]);
  });
});

describe('runProbe', () => {
  it('detects emulator identity from fixture', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-emulator.txt'));
    expect(snap.identity.abi).toBe('x86_64');
    expect(snap.identity.isEmulator).toBe(true);
    expect(snap.identity.productName).toBe('emulator');
    expect(snap.binaries.hiprofiler_cmd).toBe(false);
    expect(snap.binaries.hitrace).toBe(true);
  });

  it('detects real device identity from fixture', async () => {
    const snap = await runProbe(fixtureRunner('test/fixtures/probe-real.txt'));
    expect(snap.identity.isEmulator).toBe(false);
    expect(snap.binaries.hiprofiler_cmd).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/core/test/probe.test.ts`
Expected: FAIL — `parseBinaries` 未定义

- [ ] **Step 4: 实现 `probe.ts`**

`parseBinaries`：输出含 `MISSING`、`No such file`、空串 → `false`；否则 `true`。

`parseHiperfEvents`：按行扫描，遇到 `Supported events for hardware:` 切到 hw 区，遇到 `Supported events for software:` 切到 sw 区；区内非空、不含冒号的行加入对应数组。行首尾空白裁剪。

`runProbe` 执行的命令集（顺序固定，便于 fixture 复现）：
```
param get const.product.cpu.abilist
param get const.product.name
param get const.product.software.version
param get const.ohos.fullname
param get const.product.devicetype
which hiprofiler_cmd
which hiperf
which hitrace
which hidumper
which uitest
hiperf list hw
hiperf list
```
`isEmulator` 判定：`productName === 'emulator'` 或 `softwareVersion` 以 `emulator` 开头。

`probes` 记录每条命令的 `ProbeResult`（`command` 为命令原文）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/core/test/probe.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/device/probe.ts packages/core/test/probe.test.ts test/fixtures/
git commit -m "feat: add device probe with recorded real/emulator fixtures"
```

---

### Task 5: SQLite 驱动

**Files:**
- Create: `packages/core/src/db/driver.ts`
- Test: `packages/core/test/driver.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface QueryHandle { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[]; close(): void; readonly path: string }`
  - `function openDb(path: string): QueryHandle`
  - `function tableRowCounts(db: QueryHandle): Record<string, number>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/driver.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, tableRowCounts } from '../src/db/driver';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-'));
  dbPath = join(dir, 't.db');
  const d = new DatabaseSync(dbPath);
  d.exec('CREATE TABLE frame_slice(id INT, ts INT, flag INT)');
  d.exec('INSERT INTO frame_slice VALUES (0, 100, 0), (1, 200, 1)');
  d.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('openDb', () => {
  it('queries rows with params', () => {
    const db = openDb(dbPath);
    const rows = db.query<{ ts: number }>('SELECT ts FROM frame_slice WHERE flag = ? ORDER BY ts', [0]);
    expect(rows).toEqual([{ ts: 100 }]);
    db.close();
  });

  it('reports row counts per table', () => {
    const db = openDb(dbPath);
    expect(tableRowCounts(db)).toEqual({ frame_slice: 2 });
    db.close();
  });

  it('exposes the db path', () => {
    const db = openDb(dbPath);
    expect(db.path).toBe(dbPath);
    db.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/driver.test.ts`
Expected: FAIL — 无法解析 `../src/db/driver`

- [ ] **Step 3: 实现 `driver.ts`**

用 `node:sqlite` 的 `DatabaseSync`，以只读方式打开（`{ readOnly: true }`）。`query` 返回普通对象数组（`DatabaseSync` 的 `all()` 已返回对象）。`tableRowCounts` 查询 `sqlite_master` 中 `type='table'` 的表名，逐表 `SELECT COUNT(*)`，返回按表名排序的对象。

若 `DatabaseSync` 打开失败且错误信息包含 `readonly`，回退为可写打开（`trace_streamer` 产物偶尔需要 `-wal` 恢复）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/driver.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/db/driver.ts packages/core/test/driver.test.ts
git commit -m "feat: add node:sqlite driver with read-only open"
```

---

### Task 6: trace_streamer 封装

**Files:**
- Create: `packages/core/src/ingest/streamer.ts`
- Test: `packages/core/test/streamer.test.ts`

**Interfaces:**
- Consumes: `StreamerNotFoundError`、`IngestError`（Task 1）
- Produces:
  - `interface StreamerOptions { streamerPath?: string; env?: NodeJS.ProcessEnv }`
  - `class Streamer`，构造 `(opts?: StreamerOptions)`
    - `resolvePath(): Promise<string>` —— `opts.streamerPath` → `env.OHOS_PERF_STREAMER` → 常见 DevEco 路径 → PATH
    - `version(): Promise<string>`
    - `assertSupported(): Promise<void>` —— 版本 `< 4.3.0` 抛 `IngestError`
    - `convert(inputPath: string, outputDbPath: string): Promise<void>`
  - `function buildConvertArgv(inputPath: string, outputDbPath: string): string[]`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/streamer.test.ts
import { describe, it, expect } from 'vitest';
import { Streamer, buildConvertArgv, parseVersion } from '../src/ingest/streamer';

describe('buildConvertArgv', () => {
  it('passes input, -e, output in that order', () => {
    expect(buildConvertArgv('a.htrace', 'b.db')).toEqual(['a.htrace', '-e', 'b.db']);
  });
});

describe('parseVersion', () => {
  it('extracts semver from streamer banner', () => {
    expect(parseVersion('version 4.3.7')).toBe('4.3.7');
    expect(parseVersion('Trace Streamer 4.3.7 (build x)')).toBe('4.3.7');
  });
});

describe('Streamer path handling', () => {
  it('spawns without shell so paths with spaces stay intact', () => {
    const s = new Streamer({ streamerPath: 'D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe' });
    const spec = s.spawnSpec('in.htrace', 'out.db');
    expect(spec.command).toBe('D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe');
    expect(spec.args).toEqual(['in.htrace', '-e', 'out.db']);
    expect(spec.shell).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/streamer.test.ts`
Expected: FAIL — `buildConvertArgv` 未定义

- [ ] **Step 3: 实现 `streamer.ts`**

`buildConvertArgv` 返回 `[inputPath, '-e', outputDbPath]`（实测 trace_streamer 4.3.7 的参数形式）。

`parseVersion` 用正则 `/v?(\d+\.\d+\.\d+)/` 取第一个匹配。

`spawnSpec(input, output)` 返回 `{ command, args, shell: false }`——**必须 `shell: false`**，否则含空格路径被拆断。

`resolvePath()` 常见路径：
- `D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe`
- `C:/Program Files/Huawei/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe`

失败抛 `StreamerNotFoundError`。

`convert()` 用 `spawn` 执行，收集 stderr；非零退出抛 `IngestError(message, stderr, 'STREAMER_EXIT_<code>')`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/streamer.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/ingest/streamer.ts packages/core/test/streamer.test.ts
git commit -m "feat: add trace_streamer wrapper with space-safe spawn"
```

---

### Task 7: Metric 与 Evidence 模型

**Files:**
- Create: `packages/core/src/report/metric.ts`
- Create: `packages/core/src/report/evidence.ts`
- Test: `packages/core/test/report.test.ts`

**Interfaces:**
- Consumes: `TimeRange`（Task 1）、`Fidelity`（Task 3）
- Produces:
  - `type MetricUnit = 'ms' | 'fps' | '%' | 'count' | 'bytes' | 'none'`
  - `interface Provenance { collector: string; table?: string; rows?: number; device: string }`
  - `interface Metric { id: string; value: number | string; unit: MetricUnit; window?: TimeRange; provenance: Provenance; fidelity: Fidelity; degraded?: { reason: string; fallback: string } }`
  - `function metric(input: Omit<Metric, 'unit'> & { unit?: MetricUnit }): Metric`
  - `type EvidenceKind = 'no_data' | 'jank' | 'empty_frame' | 'vsync_anomaly' | 'fps_baseline' | 'degraded_capability'`
  - `interface DrillDownHandle { label: string; tool: string; args: Record<string, unknown>; returns: string; estRows?: number }`
  - `interface Evidence { id: string; kind: EvidenceKind; severity: 'info' | 'warn' | 'critical'; subject: { process: string; thread?: string; frameNo?: number; pid?: number }; window: TimeRange; signals: Record<string, number | string>; explain: string; drillDown: DrillDownHandle[] }`
  - `function evidence(input: Omit<Evidence, 'id'>): Evidence` —— id 由 `kind + subject + window` 稳定哈希生成

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/report.test.ts
import { describe, it, expect } from 'vitest';
import { metric } from '../src/report/metric';
import { evidence } from '../src/report/evidence';

describe('metric', () => {
  it('defaults unit to none and keeps provenance', () => {
    const m = metric({
      id: 'frame.jank.rate', value: 3.2,
      provenance: { collector: 'hitrace+streamer', table: 'frame_slice', rows: 220, device: 'emu' },
      fidelity: 'exact',
    });
    expect(m.unit).toBe('none');
    expect(m.provenance.rows).toBe(220);
  });
});

describe('evidence', () => {
  it('generates stable id for identical content', () => {
    const base = {
      kind: 'jank' as const, severity: 'warn' as const,
      subject: { process: 'render_service' },
      window: { startNs: 1, endNs: 2 },
      signals: { frames: 3 }, explain: 'x', drillDown: [],
    };
    expect(evidence(base).id).toBe(evidence(base).id);
  });

  it('generates different ids for different windows', () => {
    const base = {
      kind: 'jank' as const, severity: 'warn' as const,
      subject: { process: 'a' }, signals: {}, explain: 'x', drillDown: [],
    };
    const a = evidence({ ...base, window: { startNs: 1, endNs: 2 } });
    const b = evidence({ ...base, window: { startNs: 1, endNs: 3 } });
    expect(a.id).not.toBe(b.id);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/report.test.ts`
Expected: FAIL — `metric` 未定义

- [ ] **Step 3: 实现 `metric.ts` 与 `evidence.ts`**

`metric()` 返回 `{ ...input, unit: input.unit ?? 'none' }`。

`evidence()` 的 id：对 `JSON.stringify({ kind, subject, window })` 用 `node:crypto` 的 `createHash('sha1')` 取前 12 位十六进制。`JSON.stringify` 的 key 顺序由对象字面量决定，为保证确定性，显式按 `kind|process|thread|frameNo|pid|startNs|endNs` 拼接字符串再哈希。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/report.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/report/ packages/core/test/report.test.ts
git commit -m "feat: add metric and evidence models with stable ids"
```

---

### Task 8: 场景目录与 Scene

**Files:**
- Create: `packages/core/src/ingest/scene.ts`
- Test: `packages/core/test/scene.test.ts`

**Interfaces:**
- Consumes: `QueryHandle`、`openDb`（Task 5）、`Streamer`（Task 6）
- Produces:
  - `interface SceneLayout { root: string; traceFile: string; perfFile?: string; traceDb: string; perfDb?: string }`
  - `function createSceneLayout(root: string): SceneLayout`
  - `class Scene`，构造 `(layout: SceneLayout, db: QueryHandle)`
    - `readonly dir: string`
    - `readonly traceDb: QueryHandle`
    - `query<T>(sql: string, params?: unknown[]): T[]`
    - `close(): void`
  - `async function ingestScene(streamer: Streamer, layout: SceneLayout): Promise<Scene>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/scene.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneLayout, ingestScene } from '../src/ingest/scene';
import type { Streamer } from '../src/ingest/streamer';

let dir: string;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ohosperf-scene-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createSceneLayout', () => {
  it('derives trace.db path from root', () => {
    const l = createSceneLayout(dir);
    expect(l.traceDb).toBe(join(dir, 'trace.db'));
    expect(l.traceFile).toBe(join(dir, 'trace.htrace'));
  });
});

describe('ingestScene', () => {
  it('converts trace file then opens db', async () => {
    const l = createSceneLayout(dir);
    writeFileSync(l.traceFile, 'fake');
    const fake = {
      convert: async (_in: string, out: string) => {
        const d = new DatabaseSync(out);
        d.exec('CREATE TABLE frame_slice(id INT, ts INT, flag INT)');
        d.exec('INSERT INTO frame_slice VALUES (0, 1, 0)');
        d.close();
      },
    } as unknown as Streamer;
    const scene = await ingestScene(fake, l);
    expect(scene.query<{ ts: number }>('SELECT ts FROM frame_slice')).toEqual([{ ts: 1 }]);
    scene.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/scene.test.ts`
Expected: FAIL — `createSceneLayout` 未定义

- [ ] **Step 3: 实现 `scene.ts`**

`createSceneLayout(root)`：`traceFile = join(root, 'trace.htrace')`、`traceDb = join(root, 'trace.db')`、`perfFile = join(root, 'perf.data')`、`perfDb = join(root, 'perf.db')`。

`ingestScene`：若 `traceDb` 不存在则调用 `streamer.convert(traceFile, traceDb)`，然后 `openDb(traceDb)` 构造 `Scene`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/scene.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/ingest/scene.ts packages/core/test/scene.test.ts
git commit -m "feat: add scene layout and ingest pipeline"
```

---

### Task 9: FrameQuery

**Files:**
- Create: `packages/core/src/query/frames.ts`
- Test: `packages/core/test/query-frames.test.ts`

**Interfaces:**
- Consumes: `QueryHandle`（Task 5）、`TimeRange`（Task 1）
- Produces:
  - `type FrameFlag = 0 | 1 | 2 | 3`
  - `type FrameType = 0 | 1`
  - `interface Frame { id: number; ts: number; dur: number; vsync: number; ipid: number; itid: number; callstackId: number; flag: FrameFlag; type: FrameType; typeDesc: string; src: string; dst: number; depth: number; frameNo: number }`
  - `interface FrameStats { total: number; actual: number; expect: number; stuttered: number; empty: number; normal: number }`
  - `class FrameQuery`，构造 `(db: QueryHandle)`
    - `all(range?: TimeRange): Frame[]`
    - `actual(range?: TimeRange): Frame[]`
    - `expect(range?: TimeRange): Frame[]`
    - `stuttered(range?: TimeRange): Frame[]`
    - `empty(range?: TimeRange): Frame[]`
    - `mapped(): Array<{ src: Frame; dst: Frame }>`
    - `stats(range?: TimeRange): FrameStats`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/query-frames.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';

let dir: string;
let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-frames-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  d.exec(`INSERT INTO frame_slice VALUES
    (0, 100, 10, 17, 44, 94, 318000, '', 0, 0, 'actural', 0, 0, 0),
    (1, 90,  10, 17, 44, 94, 200000, '', 0, 1, 'expect',  NULL, 0, 0),
    (2, 300, 11, 17, 44, 95, 900000, '', 0, 0, 'actural', 1, 0, 1),
    (3, 400, 12, 17, 44, 96, 100000, '', 0, 0, 'actural', 2, 0, 2)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('FrameQuery', () => {
  it('excludes rows with null flag (incomplete data)', () => {
    const q = new FrameQuery(db);
    expect(q.all().map((f) => f.id)).toEqual([0, 2, 3]);
  });

  it('filters by flag semantics', () => {
    const q = new FrameQuery(db);
    expect(q.stuttered().map((f) => f.id)).toEqual([2]);
    expect(q.empty().map((f) => f.id)).toEqual([3]);
  });

  it('filters by type', () => {
    const q = new FrameQuery(db);
    expect(q.actual().map((f) => f.id)).toEqual([0, 2, 3]);
    expect(q.expect().map((f) => f.id)).toEqual([1]);
  });

  it('expect() excludes rows whose flag is null', () => {
    const q = new FrameQuery(db);
    // 真实数据里 161/169 条 expect 帧 flag 为 NULL；它们被 flag IS NOT NULL 过滤掉
    expect(q.expect().every((f) => f.flag !== null)).toBe(true);
  });

  it('applies time range on ts', () => {
    const q = new FrameQuery(db);
    expect(q.all({ startNs: 200, endNs: 350 }).map((f) => f.id)).toEqual([2]);
  });

  it('computes stats over the same row set as all()', () => {
    const q = new FrameQuery(db);
    // 行集对齐 HapRay get_frame_statistics：同样排除 flag 为 NULL 的行。
    // 2026-11-15 更正：flag 分桶只统计 actual(type=0)，与指标口径一致；
    // HapRay 的分桶不区分 type（本 trace 上 empty 为 16），此处刻意不同。
    expect(q.stats()).toEqual({
      total: 3, actual: 3, expect: 0, stuttered: 1, empty: 1, normal: 1,
    });
  });

  it('maps camelCase fields from snake_case columns', () => {
    const q = new FrameQuery(db);
    const f = q.all()[0];
    expect(f.typeDesc).toBe('actural');
    expect(f.callstackId).toBe(94);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/query-frames.test.ts`
Expected: FAIL — `FrameQuery` 未定义

- [ ] **Step 3: 实现 `frames.ts`**

`all()` 的 SQL 固定为：
```sql
SELECT id, ts, vsync, ipid, itid, callstack_id, dur, src, dst,
       type, type_desc, flag, depth, frame_no
FROM frame_slice
WHERE flag IS NOT NULL
ORDER BY ts
```
带 range 时追加 `AND ts >= ? AND ts <= ?`。

`stats()` 的口径**与 `all()` 一致**：`WHERE flag IS NOT NULL`。这与 HapRay `get_frame_statistics`（内部调用 `get_frames_data`，同样带该过滤）对齐。测试中 flag 为 NULL 的那行（id=1，`type=1` 的 expect 帧）因此不计入任何计数——这正对应真实数据里 161/169 条 expect 帧被过滤的现象。

`Frame` 的 `flag` 与 `type` 类型标注为 `FrameFlag`/`FrameType`，但实现上 `all()` 已保证非 NULL；无需在类型层表达 nullable。

映射：`callstack_id → callstackId`、`type_desc → typeDesc`、`frame_no → frameNo`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/query-frames.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/query/frames.ts packages/core/test/query-frames.test.ts
git commit -m "feat: add FrameQuery with flag/type semantics"
```

---

### Task 10: 进程与线程查询

**Files:**
- Create: `packages/core/src/query/process.ts`
- Test: `packages/core/test/query-process.test.ts`

**Interfaces:**
- Consumes: `QueryHandle`（Task 5）
- Produces:
  - `interface ProcessInfo { id: number; ipid: number; pid: number; name: string; startTs: number; switchCount: number; threadCount: number; sliceCount: number; memCount: number }`
  - `interface ThreadInfo { id: number; itid: number; tid: number; name: string; startTs: number; endTs: number; ipid: number; isMainThread: boolean; switchCount: number }`
  - `class ProcessQuery`，构造 `(db: QueryHandle)`
    - `all(): ProcessInfo[]`
    - `byName(name: string): ProcessInfo | undefined`
    - `pidsFor(names: string[]): number[]`
  - `class ThreadQuery`，构造 `(db: QueryHandle)`
    - `all(): ThreadInfo[]`
    - `mainThreads(): ThreadInfo[]`
    - `forProcess(ipid: number): ThreadInfo[]`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/query-process.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { ProcessQuery, ThreadQuery } from '../src/query/process';

let dir: string; let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-proc-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 100, 5, 3, 3, 0),
    (1, 18, 100, 'render_service', 90, 9, 4, 4, 0)`);
  d.exec(`CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`);
  d.exec(`INSERT INTO thread VALUES (44, 44, 4999, 'main', 100, 200, 17, 1, 5),
    (45, 45, 5000, 'worker', 100, 200, 17, 0, 2)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('ProcessQuery', () => {
  it('finds process by name', () => {
    expect(new ProcessQuery(db).byName('com.demo')?.pid).toBe(4999);
  });
  it('returns pids for names in given order', () => {
    expect(new ProcessQuery(db).pidsFor(['render_service', 'com.demo'])).toEqual([100, 4999]);
  });
  it('skips unknown names', () => {
    expect(new ProcessQuery(db).pidsFor(['nope'])).toEqual([]);
  });
});

describe('ThreadQuery', () => {
  it('filters main threads', () => {
    expect(new ThreadQuery(db).mainThreads().map((t) => t.id)).toEqual([44]);
  });
  it('filters by process ipid', () => {
    expect(new ThreadQuery(db).forProcess(17).map((t) => t.id)).toEqual([44, 45]);
  });
  it('maps is_main_thread to boolean', () => {
    expect(new ThreadQuery(db).all()[0].isMainThread).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/query-process.test.ts`
Expected: FAIL — `ProcessQuery` 未定义

- [ ] **Step 3: 实现 `process.ts`**

`pidsFor(names)` 按**传入顺序**返回，跳过未找到的名字（测试固定此行为）。`ThreadQuery.all()` 按 `id` 排序。`isMainThread` 由 `is_main_thread === 1` 得出。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/query-process.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/query/process.ts packages/core/test/query-process.test.ts
git commit -m "feat: add process and thread queries"
```

---

### Task 11: 帧分析器

**Files:**
- Create: `packages/core/src/analyze/types.ts`
- Create: `packages/core/src/analyze/frames.ts`
- Test: `packages/core/test/analyze-frames.test.ts`

**Interfaces:**
- Consumes: `FrameQuery`、`Frame`、`FrameStats`（Task 9）、`ProcessQuery`（Task 10）、`Metric`（Task 7）、`Evidence`（Task 7）、`CapabilityMatrix`（Task 3）、`AppIdentity`（Task 1）
- Produces:
  - `interface AnalyzeContext { frames: FrameQuery; processes: ProcessQuery; app: AppIdentity; window: TimeRange; caps: CapabilityMatrix; deviceId: string }`
  - `interface AnalyzeResult { metrics: Metric[]; evidence: Evidence[] }`
  - `interface Analyzer { readonly id: string; readonly requires: CapabilityId[]; run(ctx: AnalyzeContext): Promise<AnalyzeResult> }`
  - `class FrameAnalyzer implements Analyzer`
    - `id = 'frames'`、`requires = ['trace.frames']`
    - `run(ctx)` 产出指标 id：`frame.count`、`frame.jank.rate`、`frame.empty.rate`、`frame.avg.duration`、`frame.fps`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/analyze-frames.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameAnalyzer } from '../src/analyze/frames';

let dir: string; let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-an-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  // 10 帧：7 正常 / 1 卡顿 / 2 空帧，跨 1 秒 → fps≈10
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const flag = i === 3 ? 1 : (i >= 8 ? 2 : 0);
    rows.push(`(${i}, ${1_000_000_000 + i * 100_000_000}, ${i}, 17, 44, 94, 16000000,
      '', 0, 0, 'actural', ${flag}, 0, ${i})`);
  }
  d.exec(`INSERT INTO frame_slice VALUES ${rows.join(',')}`);
  d.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 100, 0, 1, 1, 0)`);
  d.exec(`CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT, start_ts INT,
    end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function ctx() {
  const caps = new CapabilityMatrix([
    { id: 'trace.frames', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'which hitrace', stdout: '/bin/hitrace', stderr: '', code: 0 } },
  ]);
  return {
    frames: new FrameQuery(db), processes: new ProcessQuery(db),
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 2_000_000_000 },
    caps, deviceId: 'emu',
  };
}

describe('FrameAnalyzer', () => {
  it('reports jank rate over actual frames', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.jank.rate')!;
    expect(m.value).toBeCloseTo(10, 5);   // 1 卡顿 / 10 实际帧
    expect(m.unit).toBe('%');
    expect(m.fidelity).toBe('exact');
  });

  it('reports empty frame rate', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.empty.rate')!;
    expect(m.value).toBeCloseTo(20, 5);   // 2 空帧 / 10
  });

  it('carries provenance with table and device', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const m = r.metrics.find((x) => x.id === 'frame.count')!;
    expect(m.provenance.table).toBe('frame_slice');
    expect(m.provenance.device).toBe('emu');
  });

  it('emits no_data evidence when no frames in window', async () => {
    const c = ctx();
    c.window = { startNs: 9_000_000_000, endNs: 9_100_000_000 };
    const r = await new FrameAnalyzer().run(c);
    const e = r.evidence.find((x) => x.kind === 'no_data')!;
    expect(e).toBeDefined();
    expect(e.explain).toContain('no frames');
    expect(e.drillDown[0].tool).toBe('frames.all');
  });

  it('emits one evidence per stuttered frame with drilldown', async () => {
    const r = await new FrameAnalyzer().run(ctx());
    const jank = r.evidence.filter((x) => x.kind === 'jank');
    expect(jank).toHaveLength(1);
    expect(jank[0].subject.frameNo).toBe(3);
    expect(jank[0].drillDown.map((d) => d.tool)).toContain('frames.get');
  });

  it('is deterministic across runs', async () => {
    const a = await new FrameAnalyzer().run(ctx());
    const b = await new FrameAnalyzer().run(ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/analyze-frames.test.ts`
Expected: FAIL — `FrameAnalyzer` 未定义

- [ ] **Step 3: 实现 `analyze/types.ts` 与 `analyze/frames.ts`**

`analyze/types.ts` 只放 Interfaces 中的三个类型。

`frames.ts` 的 `run()` 逻辑：
1. `const frames = ctx.frames.all(ctx.window)`（已排除 flag 为 NULL）
2. 若 `frames.length === 0` → 返回 `{ metrics: [], evidence: [noDataEvidence] }`。`noDataEvidence.explain` 必须是 `'no frames captured in window; the UI may have been static (no redraw)'`，`drillDown` 第一项 `{ label: 'All frames in window', tool: 'frames.all', args: { window }, returns: 'Frame[]', estRows: 0 }`
3. 计算 `actual = frames.filter(f => f.type === 0)`
4. 指标：
   - `frame.count`：`actual.length`，unit `count`
   - `frame.jank.rate`：`stuttered.length / actual.length * 100`，unit `%`
   - `frame.empty.rate`：`empty.length / actual.length * 100`，unit `%`
   - `frame.avg.duration`：`actual` 的 `dur` 均值 / 1e6，unit `ms`
   - `frame.fps`：`actual.length / ((window.endNs - window.startNs) / 1e9)`，unit `fps`
5. 每个 `flag === 1` 的帧产出一条 `jank` 证据：`severity: 'warn'`、`signals: { durMs, vsync }`、`explain` 为 `` `frame ${frameNo} took ${durMs.toFixed(1)}ms (budget 16.7ms)` ``、`drillDown` 含 `{ label: 'Frame detail', tool: 'frames.get', args: { id }, returns: 'Frame' }` 与 `{ label: 'Callstack for frame', tool: 'callstack.under', args: { ipid, itid, startNs, endNs }, returns: 'CallstackEntry[]' }`
6. 所有 `metrics` 按 `id` 字典序排序，`evidence` 按 `(kind, frameNo)` 排序

`provenance` 统一为 `{ collector: 'hitrace+streamer', table: 'frame_slice', rows: frames.length, device: ctx.deviceId }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/analyze-frames.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/analyze/ packages/core/test/analyze-frames.test.ts
git commit -m "feat: add frame analyzer with provenance and evidence drilldown"
```

---

### Task 12: hitrace 采集器

**Files:**
- Create: `packages/core/src/collectors/types.ts`
- Create: `packages/core/src/collectors/hitrace.ts`
- Test: `packages/core/test/collector-hitrace.test.ts`

**Interfaces:**
- Consumes: `Hdc`（Task 2）、`CapabilityId`（Task 3）、`SceneLayout`（Task 8）
- Produces:
  - `interface Collector { readonly id: string; readonly provides: CapabilityId[]; }`
  - `interface TraceCollectOptions { app: string; durationMs: number; bufferKb?: number; categories?: string[] }`
  - `const HITRACE_DEFAULT_CATEGORIES: string[]`
  - `class HitraceCollector implements Collector`
    - `id = 'hitrace'`、`provides = ['trace.frames','trace.sched','trace.binder','trace.thread_state','render.vsync']`
    - `beginCommand(opts: TraceCollectOptions): string`
    - `finishCommand(devicePath: string): string`
    - `collect(hdc: Hdc, target: string, opts: TraceCollectOptions, layout: SceneLayout): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/collector-hitrace.test.ts
import { describe, it, expect } from 'vitest';
import { HitraceCollector, HITRACE_DEFAULT_CATEGORIES } from '../src/collectors/hitrace';

describe('HitraceCollector', () => {
  it('declares the trace capabilities', () => {
    const c = new HitraceCollector();
    expect(c.provides).toContain('trace.frames');
    expect(c.provides).toContain('trace.binder');
    expect(c.provides).not.toContain('mem.native_hook');
  });

  it('builds begin command with buffer and categories', () => {
    const c = new HitraceCollector();
    expect(c.beginCommand({ app: 'com.demo', durationMs: 1000 }))
      .toBe(`hitrace --trace_begin -b 204800 ${HITRACE_DEFAULT_CATEGORIES.join(' ')}`);
  });

  it('honours custom buffer and categories', () => {
    const c = new HitraceCollector();
    expect(c.beginCommand({ app: 'x', durationMs: 1, bufferKb: 8192, categories: ['ace', 'app'] }))
      .toBe('hitrace --trace_begin -b 8192 ace app');
  });

  it('builds finish command writing to device path', () => {
    const c = new HitraceCollector();
    expect(c.finishCommand('/data/local/tmp/x.htrace'))
      .toBe('hitrace --trace_finish -o /data/local/tmp/x.htrace');
  });

  it('default categories include frame-relevant ones', () => {
    expect(HITRACE_DEFAULT_CATEGORIES).toEqual(expect.arrayContaining(['ability', 'ace', 'app', 'graphic', 'sched', 'window']));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/collector-hitrace.test.ts`
Expected: FAIL — `HitraceCollector` 未定义

- [ ] **Step 3: 实现 `collectors/types.ts` 与 `collectors/hitrace.ts`**

`HITRACE_DEFAULT_CATEGORIES` 与 HapRay `command_templates.py` 一致：
```ts
['ability','ace','app','ark','binder','disk','freq','graphic','idle','irq',
 'memreclaim','mmc','multimodalinput','notification','ohos','pagecache','rpc',
 'sched','sync','window','workq','zaudio','zcamera','zimage','zmedia']
```
默认 buffer `204800`（KB）。

`beginCommand` 的格式严格为 `hitrace --trace_begin -b {kb} {categories.join(' ')}`。

`collect()`：`hdc.shell(begin)` → 等待 `durationMs` → `hdc.shell(finishCommand(devicePath))` → `hdc.recv(target, devicePath, layout.traceFile)`。`devicePath` 固定为 `/data/local/tmp/ohosperf_trace.htrace`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/collector-hitrace.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/collectors/ packages/core/test/collector-hitrace.test.ts
git commit -m "feat: add hitrace collector matching HapRay category set"
```

---

### Task 13: Device 对象与 collect 编排

**Files:**
- Create: `packages/core/src/device/device.ts`
- Test: `packages/core/test/device.test.ts`

**Interfaces:**
- Consumes: `Hdc`（Task 2）、`runProbe`、`ProbeSnapshot`（Task 4）、`buildMatrix`、`CapabilityMatrix`（Task 3）、`HitraceCollector`（Task 12）、`Streamer`（Task 6）、`ingestScene`、`Scene`（Task 8）
- Produces:
  - `interface ConnectOptions { target?: string; hdcPath?: string; streamerPath?: string }`
  - `class Device`
    - `readonly id: string`
    - `readonly kind: 'real' | 'emulator'`
    - `readonly abi: string`
    - `capabilities(): Promise<CapabilityMatrix>`
    - `shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>`
    - `collect(opts: CollectOptions): Promise<CollectSession>`
  - `interface CollectOptions { app: string; durationMs: number; bufferKb?: number; categories?: string[]; sceneRoot: string }`
  - `interface CollectSession { ingest(): Promise<Scene> }`
  - `async function connect(opts?: ConnectOptions): Promise<Device>`

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/device.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Device, connect } from '../src/device/device';
import { CapabilityMatrix } from '../src/device/capability';
import { DeviceNotFoundError } from '../src/errors';

const probe = {
  identity: { abi: 'x86_64', productName: 'emulator', softwareVersion: 'emulator 6.1.0.126',
    osFullName: 'OpenHarmony-6.1.1.125', deviceType: 'phone', isEmulator: true },
  binaries: { hitrace: true, hiperf: true, hidumper: true, uitest: true, hiprofiler_cmd: false },
  hiperfHwEvents: [], hiperfSwEvents: ['sw-cpu-clock'],
  probes: {},
};

describe('Device', () => {
  it('exposes identity from probe snapshot', () => {
    const d = new Device('t1', probe as any, {} as any);
    expect(d.id).toBe('t1');
    expect(d.kind).toBe('emulator');
    expect(d.abi).toBe('x86_64');
  });

  it('derives capability matrix from snapshot', async () => {
    const d = new Device('t1', probe as any, {} as any);
    const caps = await d.capabilities();
    expect(caps).toBeInstanceOf(CapabilityMatrix);
    expect(caps.get('perf.pmu')!.available).toBe(false);
    expect(caps.get('trace.frames')!.available).toBe(true);
  });

  it('caches capability matrix across calls', async () => {
    const d = new Device('t1', probe as any, {} as any);
    const a = await d.capabilities();
    const b = await d.capabilities();
    expect(a).toBe(b);
  });

  it('rejects collect when frames capability missing', async () => {
    const noTrace = { ...probe, binaries: { ...probe.binaries, hitrace: false } };
    const d = new Device('t1', noTrace as any, {} as any);
    await expect(d.collect({ app: 'x', durationMs: 1, sceneRoot: '/tmp/x' }))
      .rejects.toThrow(/trace\.frames/);
  });

  it('connect fails with DeviceNotFoundError when no targets are connected', async () => {
    // 模拟器 hdcPort 非法时 Emulator.exe 退出码为 0 但无 target——不能以退出码判定成功
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [{ id: '127.0.0.1:5555', connected: false, raw: '127.0.0.1:5555\tOffline' }],
      tconn: async () => {},
    };
    await expect(connect({ hdc: fakeHdc as any, probe: async () => probe as any }))
      .rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('connect selects the requested target even when others are online', async () => {
    const connected: string[] = [];
    const fakeHdc = {
      resolvePath: async () => '/hdc',
      listTargets: async () => [
        { id: 'real-1', connected: true, raw: 'real-1\tConnected' },
        { id: '127.0.0.1:10178', connected: true, raw: '127.0.0.1:10178\tConnected' },
      ],
      tconn: async (t: string) => { connected.push(t); },
    };
    const d = await connect({
      target: '127.0.0.1:10178', hdc: fakeHdc as any, probe: async () => probe as any,
    });
    expect(d.id).toBe('127.0.0.1:10178');
    expect(connected).toContain('127.0.0.1:10178');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/device.test.ts`
Expected: FAIL — `Device` 未定义

- [ ] **Step 3: 实现 `device.ts`**

构造参数 `(id: string, snapshot: ProbeSnapshot, deps: { hdc?: Hdc; streamer?: Streamer; collector?: HitraceCollector })`——`deps` 允许注入以便测试。

`capabilities()` 懒加载并缓存 `CapabilityMatrix`。

`collect()`：先 `const caps = await this.capabilities()`，若 `!caps.has('trace.frames')` 则抛 `OhosPerfError('collect requires trace.frames capability', { code: 'MISSING_CAPABILITY' })`——测试断言错误信息含 `trace.frames`。否则返回 `CollectSession`，其 `ingest()` 执行 `collector.collect(...)` 后 `ingestScene(streamer, layout)`。

`connect()` 的签名需支持注入以便测试：`connect(opts?: ConnectOptions & { hdc?: Hdc; probe?: (runner: ProbeRunner) => Promise<ProbeSnapshot> })`。

流程：`new Hdc({ hdcPath })` → `listTargets()` → 选定 target（`opts.target` 指定则必须存在且 `connected`；否则取第一个 `connected`）→ `tconn` → 探针 → 构造 `Device`。

**关键**：判定成功依据是 `listTargets()` 返回的 `connected` 字段，**不是**任何进程退出码。无可用 target 时抛 `DeviceNotFoundError`，其 `targetsOutput` 为原始 `listTargets` 文本。这直接对应 Review Focus 中"hdc 端口静默失败"——模拟器启动失败时退出码为 0，只有 `hdc list targets` 能暴露真相。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/device.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/device/device.ts packages/core/test/device.test.ts
git commit -m "feat: add Device with cached capability matrix and collect orchestration"
```

---

### Task 14: 公共导出面

**Files:**
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/index.test.ts`

**Interfaces:**
- Consumes: 全部前置任务的公开符号
- Produces: 包的唯一入口，导出 `connect`、`Device`、`CapabilityMatrix`、`buildMatrix`、`FrameQuery`、`ProcessQuery`、`ThreadQuery`、`FrameAnalyzer`、`Scene`、`metric`、`evidence`、全部错误类、全部公开类型

- [ ] **Step 1: 写失败测试**

```ts
// packages/core/test/index.test.ts
import { describe, it, expect } from 'vitest';
import * as api from '../src/index';

describe('public surface', () => {
  it('exports the connect entry point', () => {
    expect(typeof api.connect).toBe('function');
  });

  it('exports all error classes', () => {
    for (const n of ['OhosPerfError', 'HdcNotFoundError', 'DeviceNotFoundError',
                     'StreamerNotFoundError', 'IngestError']) {
      expect((api as any)[n]).toBeDefined();
    }
  });

  it('exports analyzers and queries', () => {
    for (const n of ['FrameQuery', 'ProcessQuery', 'ThreadQuery', 'FrameAnalyzer',
                     'CapabilityMatrix', 'buildMatrix', 'metric', 'evidence']) {
      expect((api as any)[n]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/index.test.ts`
Expected: FAIL — 未导出

- [ ] **Step 3: 实现 `index.ts`**

显式具名导出（`export { ... }` 与 `export type { ... }`），不用 `export *`，以便导出面稳定可控。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/index.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/index.ts packages/core/test/index.test.ts
git commit -m "feat: expose stable public API surface"
```

---

### Task 15: CLI 与 doctor

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `@ohos-perf/core` 的 `connect`、`Device`、`Streamer`、`Hdc`
- Produces:
  - `async function doctorReport(deps: DoctorDeps): Promise<DoctorReport>`（纯函数式，可测试）
  - `interface DoctorReport { hdc: { ok: boolean; path?: string; error?: string }; streamer: { ok: boolean; path?: string; version?: string; error?: string }; device?: { id: string; kind: string; abi: string }; capabilities: CapabilityState[] }`
  - CLI 命令：`ohos-perf doctor [--json]`、`ohos-perf caps [--json]`、`ohos-perf analyze <scene-dir> [--json]`

- [ ] **Step 1: 写失败测试**

```ts
// packages/cli/test/doctor.test.ts
import { describe, it, expect } from 'vitest';
import { doctorReport } from '../src/doctor';

describe('doctorReport', () => {
  it('reports hdc failure without throwing', async () => {
    const r = await doctorReport({
      resolveHdc: async () => { throw new Error('no hdc'); },
      resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    });
    expect(r.hdc.ok).toBe(false);
    expect(r.hdc.error).toContain('no hdc');
    expect(r.streamer.ok).toBe(true);
    expect(r.device).toBeUndefined();
    expect(r.capabilities).toEqual([]);
  });

  it('reports full success with sorted capabilities', async () => {
    const r = await doctorReport({
      resolveHdc: async () => '/h',
      resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }),
      connectDevice: async () => ({
        id: 't1', kind: 'emulator', abi: 'x86_64',
        capabilities: async () => ({
          all: () => [
            { id: 'ui.tree', available: true, fidelity: 'exact', probe: {} },
            { id: 'perf.pmu', available: false, fidelity: 'exact', reason: 'x', probe: {} },
          ],
        }),
      }) as any,
    });
    expect(r.hdc.ok).toBe(true);
    expect(r.device?.id).toBe('t1');
    expect(r.capabilities.map((c) => c.id)).toEqual(['perf.pmu', 'ui.tree']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/cli/test/doctor.test.ts`
Expected: FAIL — `doctorReport` 未定义

- [ ] **Step 3: 实现 `doctor.ts` 与 CLI 入口**

`doctorReport(deps)` 只依赖注入的三个函数，不直接 IO，便于测试。三个函数各自 try/catch，失败写入 `error` 字段，**绝不抛出**（Spec §9：诊断命令不能因单项失败而中断）。

CLI 入口用 `commander`。`--json` 时 `process.stdout.write(JSON.stringify(report, null, 2) + '\n')`；否则打印人类可读表格，能力行格式为 `✓ trace.frames   hitrace   exact` / `✗ perf.pmu       —         no hardware PMU events reported by hiperf list hw`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/cli/test/doctor.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add packages/cli/ packages/cli/test/doctor.test.ts
git commit -m "feat: add ohos-perf CLI with doctor diagnostics"
```

---

### Task 16: 端到端验证

**Files:**
- Create: `packages/core/test/e2e-offline.test.ts`
- Create: `test/fixtures/README.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 一个不依赖设备的端到端测试，用 `spike/out/emu_big.db` 验证整条分析链

- [ ] **Step 1: 写测试**

```ts
// packages/core/test/e2e-offline.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { openDb } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameAnalyzer } from '../src/analyze/frames';

const DB = 'E:/CodeE/vibe51/emulator_compelate/spike/out/emu_big.db';

describe.skipIf(!existsSync(DB))('e2e on recorded emulator trace', () => {
  it('produces frame metrics from a real 249MB trace', async () => {
    const db = openDb(DB);
    const caps = new CapabilityMatrix([
      { id: 'trace.frames', available: true, collector: 'hitrace', fidelity: 'exact',
        probe: { command: 'which hitrace', stdout: '/bin/hitrace', stderr: '', code: 0 } },
    ]);
    const r = await new FrameAnalyzer().run({
      frames: new FrameQuery(db), processes: new ProcessQuery(db),
      app: { packageName: 'pbench.baseline', pids: [], processNames: [] },
      window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
      caps, deviceId: 'emulator-6.0.0.48',
    });
    expect(r.metrics.find((m) => m.id === 'frame.count')!.value).toBeGreaterThan(0);
    expect(r.metrics.every((m) => m.provenance.table === 'frame_slice')).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run packages/core/test/e2e-offline.test.ts`
Expected: PASS（若 trace.db 不存在则 skip）

- [ ] **Step 3: 记录 fixture 来源**

`test/fixtures/README.md` 说明两个探针 fixture 的来源与录制日期，以及 `emu_big.db` 的生成方式。端口不要写死：`spike/logs/probe_emulator.log` 记录快照采集时是 `127.0.0.1:10178`，而 2026-11-15 的 `hdc list targets -v` 显示当时运行的模拟器是 `127.0.0.1:5555`——两次不同的会话，两个都是真实观测。

- [ ] **Step 4: 全量测试与构建**

Run: `npm test`
Expected: 全部 PASS，`packages/core/dist/` 生成

- [ ] **Step 5: 提交**

```bash
git add packages/core/test/e2e-offline.test.ts test/fixtures/README.md
git commit -m "test: add offline end-to-end verification on recorded trace"
```

---

## 验收标准

P0 完成的判据：

1. `npm test` 全部通过（会先构建两个包，干净检出也能跑）（约 50 个测试）。
2. `npm run build -w @ohos-perf/core` 无错误，产出 `dist/index.js` 与 `dist/index.d.ts`。
3. 在真机上执行 `ohos-perf doctor --json` 返回 `hdc.ok=true`、`streamer.ok=true`、能力矩阵中 `trace.frames` 与 `perf.pmu` 均为 `available: true`。
4. 在模拟器上执行同样命令，`perf.pmu` 为 `available: false` 且 `reason` 含 `no hardware PMU events`，`mem.native_hook` 为 `available: false` 且 `reason` 含 `hiprofiler`。端口以当时的 `hdc list targets -v` 为准——不要从任何文档抄端口，本仓库先后观测到过 `10178`（2026-11-14 采集快照时）和 `5555`（2026-11-15 验收时）两个不同会话的地址。
   - **2026-11-15 已实测通过**：模拟器 `127.0.0.1:5555`（x86_64）上 `perf.pmu` → `no hardware PMU events reported by hiperf list hw`；所有 hiprofiler 能力 → `hiprofiler not present on device (hiprofiler_cmd missing)`；`render.fps_live` 的 `fidelity` 为 `proxy`；共 9 项可用。同机真机 `REDACTED-DEVICE-SERIAL`（arm64-v8a）20 项全部可用，`perf.pmu` 为 `exact`。
5. 对 `spike/out/emu_big.db` 运行帧分析，`frame.count > 0` 且所有指标的 `provenance.table` 为 `frame_slice`。
6. 同一输入连续两次分析，`JSON.stringify` 结果完全相同。
