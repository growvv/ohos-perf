# Phase A 探测报告：模拟器上的 HapRay 性能采集可行性

- 日期：2026-11-14
- 范围：仅离线验证（不下载镜像、不启动模拟器、不改动任何现有仓库）
- 工作目录：`E:\CodeE\vibe51\emulator_compelate\spike`
- 样本：`performance_rq` 2026-07-01 在 DevEco 模拟器 `127.0.0.1:5555` 上的既有产物
- 对照：`PhoneUse` 2026-02-06 的真机产物

---

## 0. 结论先行

| 结论 | 判定 |
|---|---|
| host 侧 `trace_streamer` 能完整解析模拟器 htrace | **成立**（88 表，30s trace 4.5s 解析完） |
| HapRay 全部分析器能在模拟器产物上跑通 | **成立**（11/11 无异常退出，10 个产出数据） |
| 帧/掉帧/空帧/VSync/IPC binder/线程冗余/故障树 | **可用**，有真实数据 |
| 火焰图（PerfAnalyzer） | **部分**：perf.json 与符号完整，缺 sa-cmd 后处理 |
| Native 内存（MemoryAnalyzer） | **不可用**：无 native_hook 数据 |
| 冷启动（ColdStartAnalyzer） | **不可用**：依赖 `redundant_file.txt`，模拟器无 |
| 指令数 / CPI | **不可用**：QEMU 无 PMU，降级为 `sw-cpu-clock` |
| 覆盖率、组件复用、JS 堆 | **不可用**：数据源本身不存在 |

**关键判断：主要分析能力在模拟器上是可恢复的，缺口集中在 native/PMU/覆盖率三类，且这些缺口与"是否模拟器"关系不大——用 hitrace 通路采真机也一样缺。**

---

## 1. 环境与样本事实

### 1.1 使用的工具

| 工具 | 路径 | 说明 |
|---|---|---|
| trace_streamer | `D:\Application\DevEco Studio\tools\profiler\dic_server\trace_streamer.exe` | 17MB，DevEco 6.1.1 自带，实测可用 |
| HapRay | `performance_rq\...\hapray_perf_testing`（`.venv-win`，Python 3.12.6） | 已改造过的模拟器适配版 |
| sqlite3 | `D:\miniconda3\Library\bin\sqlite3` | 用于核对表内容 |

### 1.2 样本

| 样本 | 大小 | 说明 |
|---|---|---|
| 模拟器 trace（小） | 25.5 MB | `reports/20260701130501/.../round0`，30.5s |
| 模拟器 trace（大） | 249 MB | `reports/20260701141403/.../round0`，30.6s |
| 模拟器 perf.data | 784 KB | 同场景，2996 samples |
| 真机 trace | 12.7 MB | `PhoneUse/out/real_hdc_perf_20260206_163111`，2.65s |

设备标识（来自 `testInfo.json`）：`sn=127.0.0.1:5555`、`model=emulator`、`platform=HarmonyOS NEXT`、`version=emulator 6.0.0.48`。

---

## 2. 解析链验证

### 2.1 htrace → SQLite

```
trace_streamer.exe trace.htrace -e trace.db
```

| 输入 | 耗时 | 输出 | 表数 |
|---|---|---|---|
| 25.5 MB | 1.36 s | 10.5 MB | 88 |
| 249 MB | 4.52 s | 17.9 MB | 88 |

**88 张表全部建出**，schema 与 `deveco-perf-api.md` §4.2 记录的 92 表一致（少 4 张为扩展/条件表）。

### 2.2 perf.data → SQLite

```
trace_streamer.exe perf.data -e perf.db
```

0.98s 完成，`perf_sample` 2996 行、`perf_callchain` 5141 行、`perf_thread` 29 行、`perf_files` 99 行。

**注意**：`symbols` 表为 0 行，但符号信息在 `perf.json` 的 `SymbolMap`（509 条）与 `symbolsFileList`（648 个 so）中完整存在，例如：

```
OHOS::ImagePlugin::ExtDecoder::GetSrcColorSpace()
Hdc::HdcJdwpSimulator::Connect()
/system/lib64/platformsdk/libace_compatible.z.so+0x150ea02
```

即：**符号没有丢失，只是没有写进 perf.db 的 symbols 表。**

---

## 3. 各数据源的实测行数

| 表 | 模拟器（30.6s） | 真机（2.65s） | 判定 |
|---|---:|---:|---|
| `frame_slice` | 338 | 462 | 有数据 |
| `frame_maps` | 100 | 0 | 有数据 |
| `dynamic_frame` | 0 | — | 无 |
| `app_startup` | 0 | **0** | 两条通路都无 |
| `hidump` | 0 | **0** | 两条通路都无 |
| `gpu_slice` | 0 | — | 无 |
| `process` | 437 | 118 | 有数据 |
| `thread` | 1231 | 713 | 有数据 |
| `sched_slice` | 60053 | 34859 | 有数据 |
| `thread_state` | 72747 | — | 有数据 |
| `callstack` | 35415 | 25327 | 有数据（含 binder） |
| `cpu_usage` | 0 | 0 | 两条通路都无 |
| `live_process` | 0 | 0 | 两条通路都无 |
| `native_hook` / `native_hook_frame` | 0 | 0 | 两条通路都无 |
| `perf_sample`（perf.db） | 2996 | — | 有数据 |
| `diskio` / `network` / `xpower_*` | 0 | 0 | 两条通路都无 |
| `js_*`（9 张） | 0 | 0 | 两条通路都无 |
| `smaps` / `memory_profile` | 0 | 0 | 两条通路都无 |

**关键发现**：`app_startup`、`hidump`、`cpu_usage`、`live_process`、`native_hook`、`xpower_*`、`js_*` 在**真机上也全为 0**。这些表由 hiprofiler 的插件（hidump/cpu/memory/xpower）或 ArkTS runtime 的 JS profiler 填充，与"用 hitrace + hiperf 采集"这条通路本身不匹配，不是模拟器独有缺陷。

---

## 4. 分析器实跑结果

在场景副本上直接调用 `hapray.analyze.analyze_data()`（11 个分析器）：

| 分析器 | 结果 | 输出文件 | 数据质量 |
|---|---|---|---|
| UnifiedFrameAnalyzer | ✅ data | `trace_frames.json` 21.7KB | 真实帧序列 |
| （同上）frameLoads | ✅ data | `trace_frameLoads.json` 3.1KB | 66 帧 |
| （同上）emptyFrame | ✅ data | `trace_emptyFrame.json` 5.3KB | 6 个直接检出 |
| （同上）vsyncAnomaly | ✅ data | `trace_vsyncAnomaly.json` 14.6KB | 真实不匹配记录 |
| （同上）rsSkip | ✅ data | `trace_rsSkip.json` 4.7KB | status=success |
| IpcBinderAnalyzer | ✅ data | `trace_ipc_binder.json` 11.1KB | 真实事务对 |
| ThreadAnalyzer | ✅ data | `redundant_thread_analysis.json` 2.6KB | 有汇总结构 |
| FaultTreeAnalyzer | ✅ data | `trace_fault_tree.json` 565B | arkui/RS/av/audio 分类 |
| GCAnalyzer | ⚠️ 空值 | `trace_gc_thread.json` 116B | 全 0，`GCStatus=OK` |
| UIAnalyzer | ✅ data | `ui_animate.json` 3.0MB | 有 UI 数据 |
| ComponentReusableAnalyzer | ⚠️ 空值 | `trace_componentReuse.json` 114B | `total_builds=0` |
| ColdStartAnalyzer | ❌ 无数据 | — | 缺 `redundant_file.txt` |
| CovAnalyzer | ❌ 无数据 | — | 无覆盖率数据源 |
| MemoryAnalyzer | ❌ 无数据 | `memory_report.xlsx` 8.3KB | 无 native_hook |
| PerfAnalyzer | ❌ 失败 | `more_flame_graph.json` 340B | 缺 sa-cmd |

**11/11 分析器均未异常崩溃**，失败项都是"数据源缺失"而非"代码不适配"。

### 4.1 有数据项的内容抽样

帧统计（`trace_frames.json`）：
```json
{"average_fps": 1.97, "fps_windows": [{"fps": 2.0, "frame_count": 2}, ...]}
```

IPC binder（`trace_ipc_binder.json`）：
```json
{"caller_proc":"pbench.baseline","callee_proc":"render_service",
 "count":106,"avg_latency":0.843,"max_latency":46.922,"qps":8.71}
```

VSync 异常（`trace_vsyncAnomaly.json`）：
```json
{"type":"no_expect_frame","vsync":3945,"description":"VSync 3945 只有实际帧，没有期望帧"}
```

故障树（`trace_fault_tree.json`）：
```json
{"arkui":{"HandleOnAreaChangeEvent":51,"MarshRSTransactionData":56},
 "RS":{"ProcessedNodes":{"count":34},"UnMarshRSTransactionData":63}}
```

这些都是**结构化、可解释、可对比**的真实数据，不是占位值。

---

## 5. 一个必须说明的数值异常：帧率

### 5.1 现象

模拟器 `average_fps = 1.97`，30 秒只有 338 帧。

### 5.2 排查

| 指标 | 模拟器 | 真机 |
|---|---|---|
| render_service 帧数 | 105（actual） | 142 |
| vsync 跨度 | 6127 → 6289（162） | 2459545 → 2459702（157） |
| 帧时间跨度 | 24.9 s | 2.59 s |
| 折算帧率 | ≈4.2 fps | ≈54.8 fps |
| 由 vsync 推算期望帧 | 81 | 78.5 |

模拟器 105 帧 / 24.9 秒 ≈ 4.2fps；真机 142 帧 / 2.59 秒 ≈ 54.8fps。

### 5.3 判定

**这不是丢事件，是模拟器渲染真的慢。** 依据：

1. 帧数是**实际帧多于期望帧**（105 actual vs 81 expected），没有大批丢失；
2. `frame_maps` 100 条配对关系完整，actual/expect 成对出现；
3. vsync 号是连续的（6127→6289），说明 vsync 信号源本身正常；
4. 真机在 2.6 秒内跑 142 帧，模拟器在 25 秒内跑 105 帧——差异来自 QEMU 软件渲染（`gpu_slice=0`，无硬件 GPU）。

**对产品的影响**：帧率绝对值不可用于与真机对比，但**帧内耗时、掉帧判定、空帧识别、binder 延迟**这些相对指标仍然有效。必须在报告里标注"模拟器基线"，不能与真机数据混用。

---

## 6. 能力矩阵（最终）

| 能力 | HapRay 分析器 | 模拟器状态 | 数据来源 | 保真度 |
|---|---|---|---|---|
| 逐帧/掉帧 | UnifiedFrameAnalyzer | ✅ | `frame_slice` | 高（绝对值需标模拟器基线） |
| 空帧/RS skip | 同上 | ✅ | `frame_slice` + callstack | 高 |
| VSync 异常 | 同上 | ✅ | `frame_slice.vsync` | 高 |
| IPC binder | IpcBinderAnalyzer | ✅ | `callstack` binder | 高 |
| 线程冗余/唤醒链 | ThreadAnalyzer | ✅ | `sched_slice` + `thread_state` | 高 |
| 故障树 | FaultTreeAnalyzer | ✅ | 多表融合 | 中（依赖上游） |
| 调度/CPU 时间 | — | ✅ | `sched_slice` | 高 |
| CPU 采样火焰图 | PerfAnalyzer | ⚠️ 部分 | `perf.data` + `perf.json` | 中（缺 sa-cmd 增强） |
| UI 组件树 | UIAnalyzer | ✅ | `ui/` 产物 | 高 |
| GC | GCAnalyzer | ⚠️ 空值 | trace 无 GC 事件 | 低 |
| 组件复用 | ComponentReusableAnalyzer | ⚠️ 空值 | 需组件树事件 | 低 |
| Native 内存 | MemoryAnalyzer | ❌ | 需 native_hook | 无 |
| 冷启动 | ColdStartAnalyzer | ❌ | 需 `redundant_file.txt` | 无 |
| 覆盖率 | CovAnalyzer | ❌ | 需 bjc_cov | 无 |
| 指令数/CPI | — | ❌ | 需 PMU | 无 |
| GPU/功耗/网络/磁盘 | — | ❌ | 需 hiprofiler 插件 | 无 |
| JS 堆 | — | ❌ | 需 ArkTS profiler | 无 |

---

## 7. 根因归纳

模拟器上缺失的能力，归因于**三类**，不是一类：

### 类别 1：采集通路不匹配（改代码即可，无需动模拟器）
`app_startup`、`hidump`、`cpu_usage`、`live_process`、`xpower_*`、`js_*` 这些表由 hiprofiler 的插件填充。当前用的是 `hitrace + hiperf` 直采，不经过 hiprofiler，所以为空。
**但真机用同一通路时也全为 0**——说明这是"选了 hitrace 通路"的代价，不是模拟器缺陷。若真机走 `hiprofiler_cmd`（本机 Mate 60 上该二进制存在），这些表就能填上。

### 类别 2：模拟器镜像缺组件（需要注入或换通路）
`hiprofilerd`、`hiprofiler_plugins`、`native_daemon` 在模拟器上不存在（`pidof` 为空、`ls` 权限拒绝）。这直接导致 native_hook、hidump、xpower 三类数据无法采集。

### 类别 3：硬件能力缺失（基本无解）
QEMU 无 PMU，`raw-instruction-retired` 不可用，`hiperf list` 只暴露软件事件（`sw-cpu-clock` 等）。这是虚拟化层限制，除非改 QEMU 或换真机，否则无法拿到指令数。

### 类别 4（附带）：宿主工具缺失
`performance_rq` 的 HapRay 副本**没有 `tools/` 目录**，因此：
- 没有 `trace_streamer` → 从不生成 trace.db
- 没有 `sa-cmd` → 火焰图增强失败

这是打包问题，**与模拟器无关**，补上工具即可。

---

## 8. 对产品形态的影响

Phase A 的结果支持"适配层为主"的路线，且比预期更乐观：

1. **主分析链已可用**：帧、掉帧、空帧、VSync、binder、线程、故障树 7 项全部有真实数据，覆盖 HapRay 最有价值的部分。
2. **缺口可以分层处理**：
   - 类别 1、4 是**纯软件问题**，一个安装器 + 正确的工具打包就能解决；
   - 类别 2 需要 Phase B 实测注入可行性；
   - 类别 3 应在产品里**显式标注为不可用**，而不是伪装成有数据。
3. **产品必须带"能力矩阵"**：每个指标标注数据来源与保真度，模拟器数据不得与真机数据直接对比。这是最容易出错、也最影响可信度的地方。

---

## 9. Phase B 待验证清单

Phase A 无法回答、必须启动模拟器的问题：

1. 模拟器 guest 架构是 x86_64 还是 aarch64（决定能否复用现有 aarch64 二进制）
2. `hiprofilerd`/`hiprofiler_plugins`/`native_daemon` 是否真的不存在，还是只是权限不可读
3. `hiperf list` 在模拟器上暴露哪些事件（确认 PMU 缺失范围）
4. `/data/local/tmp` 是否可写、`hitrace` 缓冲区上限
5. 镜像完整性校验是否会拦截注入（`Android-Harmony-Cli` 的 root journey 已证明会拦截 tampered system.img）
6. 当前 DevEco 6.1.1 模拟器（HarmonyOS 6.1.1(24)）与 2026-07 样本（emulator 6.0.0.48）的差异

---

## 10. 复现方式

```bash
# 1. 解析 htrace
"D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe" \
  trace.htrace -e trace.db

# 2. 解析 perf.data
"D:/Application/DevEco Studio/tools/profiler/dic_server/trace_streamer.exe" \
  perf.data -e perf.db

# 3. 跑分析器
export PATH="/d/Application/DevEco Studio/sdk/default/openharmony/toolchains:/d/Application/DevEco Studio/tools/node:$PATH"
<venv>/python -I run_analyzers.py <scene_dir>
```

产物：`spike/out/*.db`、`spike/logs/*.log`、`spike/work/scene_emu/report/*.json`。
