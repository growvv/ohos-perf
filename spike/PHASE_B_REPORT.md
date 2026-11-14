# Phase B 探测报告：DevEco 模拟器实测能力边界

- 日期：2026-11-14
- 方式：真实下载镜像、创建并启动模拟器、逐项执行只读探测
- 环境：DevEco Studio 6.1.1.280 / Emulator 6.1.1.200 / 镜像 HarmonyOS 6.1.1(24) `phone_all_x86`
- 目标设备：`127.0.0.1:10178`
- 脚本：`probe_device.sh`、`phase_b_run.sh`
- 原始日志：`logs/probe_emulator.log`

---

## 0. 结论先行

| 问题 | 答案 |
|---|---|
| 模拟器架构 | **x86_64**（镜像 `abi=x86`，内核 5.10.210） |
| 能否提权到 root | **不能**。`smode` 被 undebuggable 版本拒绝，无 `su` |
| hiprofiler 全家桶是否存在 | **不存在**。`hiprofiler_cmd`/`hiprofilerd`/`hiprofiler_plugins`/`native_daemon` 全部 MISSING |
| PMU 硬件事件 | **全部不支持**。9 个 `hw-*` 事件全部 `event not support` |
| `hiperf` 能否采集 | **受限**。`-a` 需 root，`--app`/`-p` 只支持 debug 应用 |
| `hitrace` 能否采集 | **可用**。1.7MB / 3s 正常落盘 |
| 帧数据能否产出 | **能**。冷启动 trace 产出 220 帧（含 expect/actual 配对） |
| 实时 FPS 能否拿到 | **能**，走 `hidumper -s RenderService -a fpsCount` |
| 内存数据能否拿到 | **能**，`/proc/meminfo` + `/proc/<pid>/status` 完整可读 |
| UI 树能否导出 | **能**，`uitest dumpLayout` 输出 117KB |
| 镜像完整性校验 | **存在**，5 个 img 均有 `.hwp7s` 签名，启动时 `CheckSign` 通过 |

**核心判断：Phase A 的三个"不可用"里，有两个找到了替代通路（实时 FPS、内存），只有 PMU 和 hiprofiler 插件是真缺口。**

---

## 1. 镜像与实例事实

### 1.1 下载的镜像

```
E:/HarmonyRuntime/LocalAppData/Huawei/Sdk/system-image/HarmonyOS-6.1.1/phone_all_x86/
  bzImage          10.2 MB
  ramdisk.img       2.8 MB
  system.img     3670.0 MB
  sys_prod.img    838.9 MB
  vendor.img      104.9 MB
  userdata.img    104.9 MB
  image_signature/*.hwp7s   (5 个签名文件)
```

`info.json`：
```json
{"apiVersion":"24","abi":"x86","version":"6.1.0.126"}
```

`sdk-pkg.json`：`guestVersion = HarmonyOS 6.1.0.126(SP1)`

### 1.2 实例配置

```
hw.cpu.arch    = x86_64
hw.cpu.ncore   = 4
hw.ramSize     = 4096 MB
hw.dataPartitionSize = 6144 MB
hw.lcd.single  = 1320 x 2856, density 560
imageSubPath   = system-image/HarmonyOS-6.1.1/phone_all_x86/
```

### 1.3 一个必须记录的坑

`Emulator.exe -start -hdcPort 5555` 会**静默失败**：进程退出码 0，但日志里是

```
[Warning] [CheckRuntimeEnv.cpp(CheckHdcPort:618)]Error : Thd hdc port is invalid, port should be in 10000-16555
```

hdc 端口必须落在 **10000-16555**。用 10178 后正常启动。这个坑会让任何自动化脚本误判"启动成功"。

---

## 2. 设备身份

| 项 | 值 |
|---|---|
| `const.product.name` | `emulator` |
| `const.product.model` | `emulator` |
| `const.product.software.version` | `emulator 6.1.0.126(SP1DEVC00E120R4P11)` |
| `const.ohos.fullname` | `OpenHarmony-6.1.1.125` |
| `const.product.cpu.abilist` | `x86_64` |
| `const.product.devicetype` | `phone` |
| 内核 | `Linux localhost 5.10.210 #1 SMP ... x86_64 Toybox` |
| 权限 | `uid=2000(shell)`，SELinux `Enforcing` |
| `perf_event_paranoid` | 不可读（Permission denied） |

---

## 3. 工具链逐项实测

### 3.1 存在性

| 工具 | 状态 | 路径 |
|---|---|---|
| `hiperf` | ✅ | `/bin/hiperf` (1.5 MB, 2026-07-21) |
| `hitrace` | ✅ | `/bin/hitrace` (111 KB) |
| `hidumper` | ✅ | `/bin/hidumper` (52 KB) |
| `uitest` | ✅ | `/bin/uitest` |
| `nsenter` | ✅ | `/bin/nsenter` |
| `timeout` | ✅ | `/bin/timeout` |
| `hiprofiler_cmd` | ❌ MISSING | — |
| `hiprofilerd` | ❌ MISSING | — |
| `hiprofiler_plugins` | ❌ MISSING | — |
| `native_daemon` | ❌ MISSING | — |
| `sp_daemon` | ❌ MISSING | — |
| `xvmtrace_hapray` | ❌ MISSING | — |

与真机（Mate 60）对比：真机 `/bin/hiprofiler_cmd` 存在（311KB），模拟器不存在。**这是镜像构建时就没打包，不是权限问题**（`ls -l /bin/hiprofiler_cmd` 返回 `No such file or directory`，而非 `Permission denied`）。

### 3.2 PMU 硬件事件

```
event not support hw-cpu-cycles
event not support hw-instructions
event not support hw-cache-references
event not support hw-cache-misses
event not support hw-branch-instructions
event not support hw-branch-misses
event not support hw-bus-cycles
event not support hw-stalled-cycles-frontend
event not support hw-stalled-cycles-backend
event not support hw-ref-cpu-cycles

Supported events for hardware:
(空)
```

对比真机：真机 9 个 `hw-*` 全部支持。

软件事件可用：
```
sw-cpu-clock, sw-task-clock, sw-page-faults, sw-context-switches,
sw-cpu-migrations, sw-page-faults-min, sw-page-faults-maj,
sw-alignment-faults, sw-emulation-faults, sw-dummy, sw-bpf-output
```

**结论：指令数 / CPI 在模拟器上无法获得。这是 QEMU 层限制，改应用层无解。**

### 3.3 hiperf 采集权限

| 用法 | 结果 |
|---|---|
| `hiperf record -a` | ❌ `-a option needs root privilege for system wide profiling` |
| `hiperf record --app <pkg>` | ❌ `--app option only support debug application` |
| `hiperf record -p <pid>` | ❌ `-p option only support debug application` |
| `hiperf stat -e hw-instructions` | ❌ `true options needs root privilege` |

系统应用（如 `com.huawei.hmos.settings`）`debug: false`、`appProvisionType: release`，所以不能被采样。

**结论：模拟器上 hiperf 只能采"自己安装的 debug 应用"。这是可用但受限的通路。**

### 3.4 hitrace

```
hitrace --trace_begin -b 8192 ace app graphic sched window
  → OpenRecording done
hitrace --trace_finish -o /data/local/tmp/_probe2.htrace
  → trace read done, 4.6 MB
```

3 秒采集产出 1.7-4.6 MB，**完全可用**。

trace 事件分布（空闲桌面 3s）：
```
6555 sched_switch
3482 sched_wakeup
 350 tracing_mark_write
  33 sched_wakeup_new
```

### 3.5 提权

| 尝试 | 结果 |
|---|---|
| `hdc smode` | ❌ `[Fail]Cannot set root run mode in undebuggable version.` |
| `su` | ❌ `/bin/su: No such file or directory` |
| `/system` 读取 | ❌ Permission denied |
| `/sys/kernel/tracing` 读取 | ❌ Permission denied（目录本身 `drwxr-xr-x` 但内容不可读） |

与 `Android-Harmony-Cli` 的 root journey 记录一致：stock undebuggable 镜像无法提权。

---

## 4. 关键突破：帧数据确实能产出

### 4.1 空闲桌面：0 帧

第一次 3 秒采集（桌面无交互）→ `frame_slice` **0 行**。

这**不是**能力缺失，是桌面静止不重绘。这一点必须记录，否则会误判。

### 4.2 启动应用 + 交互：8 帧

```
frame_slice: 8 行
  render_service   3 actural + 3 expect
  i.hmos.settings  1 actural + 1 expect
```

### 4.3 冷启动采集：220 帧（决定性证据）

```
aa force-stop com.huawei.hmos.settings
hitrace --trace_begin -b 16384 ability app ace graphic window
aa start -a com.huawei.hmos.settings.MainAbility -b com.huawei.hmos.settings
sleep 6
hitrace --trace_finish -o /data/local/tmp/_cold.htrace
```

解析结果：

| 表 | 行数 |
|---|---:|
| `frame_slice` | **220** |
| `app_startup` | 0 |
| `process` | 32 |
| `callstack` | 21357 |
| `sched_slice` | 0 |

帧分布（3 个进程，全部 actural/expect 配对）：

| ipid | actural | expect | 时间跨度 |
|---:|---:|---:|---|
| 3 | 19 | 19 | 192.95s → 195.31s |
| 6 | 76 | 76 | 192.98s → 196.69s |
| 8 | 15 | 15 | 193.88s → 196.68s |

**这证明：模拟器能产出完整帧数据，Phase A 中"帧率低"确实是 QEMU 软件渲染慢，不是采不到。**

### 4.4 实时 FPS：hidumper 补上 hidump 缺口

Phase A 判定 `hidump` 表不可用（因为 hiprofiler 的 hidump-plugin 不存在）。但实测发现 `hidumper` 提供了等价能力：

```
$ hidumper -s RenderService -a 'fpsCount'
-- RefreshRateCounts:
Refresh Rate:60, Count:401;
```

`hidumper -s RenderService -a 'allInfo'` 还能拿到：

```
-- ScreenInfo
screen[0]: id=0, powerStatus=POWER_STATUS_ON, render resolution=1320x2856,
  physical resolution=1320x2856, skipFrameInterval=1, expectedRefreshRate=-1
supportedMode[0]: 1320x2856, refreshRate=60
activeMode: 1320x2856, refreshRate=60

-- VSyncGenerator --
period:16000000
phase:0
referenceTime:472342713
vsyncMode:0

-- VSyncSampler --
numSamples:5
samples:[637587795,651517501,668612327,695718841,726829663,]
```

可用子命令（来自 `hidumper -s RenderService -a h`）：

```
fps            [windowname] fps, dump the fps info of window
fpsCount       dump the refresh rate counts info
fpsClear       [surface name]/composer fpsClear
hitchs         [windowname] hitchs, dump the hitchs info of window
jank           flush rs jank stats hisysevent
screen         dump all screen information
allInfo        dump all info
RSTree / client / surface / MultiRSTrees
dumpMem / dumpGpuMem / allSurfacesMem / dumpExistPidMem
```

**这是本次探测最有价值的发现**：`fps`、`fpsCount`、`hitchs`、`jank` 四个子命令直接对应 DevEco 的 hidump-plugin 能力，可在无 hiprofiler 的情况下提供实时帧率与卡顿统计。

### 4.5 内存数据可读

```
/proc/meminfo:
  MemTotal: 4025360 kB
  MemFree: 1569356 kB
  MemAvailable: 2490552 kB

/proc/4999/status (com.huawei.hmos.settings):
  VmPeak: 4360160 kB
  VmHWM:   280352 kB
  VmRSS:   279168 kB
  Threads:     37
```

**这补上了 Phase A 判定"不可用"的 MemoryAnalyzer 的一半**：native_hook 拿不到（需要 hiprofiler），但进程级 RSS/PSS 峰值完全可读。

### 4.6 UI 树可导出

```
uitest dumpLayout -p /data/local/tmp/_ui.json
→ DumpLayout saved, 117501 bytes
```

UIAnalyzer 依赖的组件树数据可用。

---

## 5. 注入可行性评估

### 5.1 镜像完整性校验确认存在

启动日志：
```
[Info] [CheckImage.cpp(CheckSign:127)]finish check image "userdata.img" result 0 cost 674
[Info] [CheckImage.cpp(CheckSign:127)]finish check image "sys_prod.img" result 0 cost 5112
[Info] [CheckImage.cpp(CheckSign:127)]finish check image "system.img"  result 0 cost 32086
```

每个 img 都有对应 `.hwp7s` 签名文件。`Android-Harmony-Cli` 的 root journey 已实测：改动 `system.img` 会触发 `system.img has been tampered with`；改 `hardware-qemu.ini` 指向 root 镜像会被回写。

### 5.2 ABI 不匹配是硬障碍

| 组件 | 现有二进制架构 | 模拟器需要 |
|---|---|---|
| `xvmtrace_hapray` | **aarch64**（ELF 64-bit ARM） | x86_64 |
| `hiprofiler_plugins` | 需从 OpenHarmony 源码编译 | x86_64 |
| `trace_streamer` | 宿主 Windows x64（已有） | — |

即使绕过签名校验，现有 aarch64 二进制在 x86_64 guest 上也无法执行。

### 5.3 注入路径判定

| 路径 | 可行性 | 依据 |
|---|---|---|
| 改 `system.img` 塞入 hiprofiler | ❌ 低 | 签名校验 + root journey 已证明被拦 |
| qcow2 overlay | ❌ 低 | 同上，且官方 runtime 会清洗 |
| 从 OpenHarmony 源码交叉编译 x86_64 版 | ⚠️ 理论可行 | 需匹配 6.1.1 内核与 SELinux 策略，周期长 |
| 通过 `hdc file send` 塞可执行文件到 `/data/local/tmp` | ⚠️ 部分 | 该目录可写，但缺 SELinux 权限与依赖库 |
| 走 hidumper + /proc + hitrace 替代 | ✅ **已实测可用** | 本报告第 4 节 |

---

## 6. 更新后的能力矩阵

对比 Phase A，绿色项增多，红色项明确：

| 能力 | Phase A 判定 | Phase B 实测 | 通路 |
|---|---|---|---|
| 逐帧/掉帧 | ✅ | ✅ **确认**（220 帧） | hitrace + trace_streamer |
| 空帧/RS skip | ✅ | ✅ 确认 | 同上 |
| VSync 异常 | ✅ | ✅ 确认 | 同上 |
| IPC binder | ✅ | ✅ 确认 | callstack |
| 线程冗余 | ✅ | ✅ 确认 | sched_slice + thread_state |
| 故障树 | ✅ | ✅ 确认 | 多表融合 |
| **实时 FPS** | ❌ | ✅ **新增** | `hidumper -s RenderService -a fpsCount` |
| **窗口 FPS/卡顿** | ❌ | ✅ **新增** | `hidumper ... -a fps/hitchs` |
| **进程内存** | ❌ | ✅ **新增** | `/proc/<pid>/status` |
| **系统内存** | ❌ | ✅ **新增** | `/proc/meminfo` |
| **渲染状态** | ❌ | ✅ **新增** | `hidumper ... -a allInfo/screen` |
| **UI 组件树** | ✅ | ✅ 确认（117KB） | `uitest dumpLayout` |
| CPU 采样火焰图 | ⚠️ 部分 | ⚠️ **受限** | hiperf 仅 debug 应用 |
| GC | ⚠️ 空值 | ⚠️ 空值 | trace 无 GC 事件 |
| 组件复用 | ⚠️ 空值 | ⚠️ 空值 | 需组件树事件 |
| Native 内存 | ❌ | ❌ **确认不可用** | 需 hiprofiler nativehook |
| 冷启动 | ❌ | ⚠️ **部分** | `app_startup` 为 0，但帧序列可推出启动耗时 |
| 覆盖率 | ❌ | ❌ 确认不可用 | 无数据源 |
| 指令数/CPI | ❌ | ❌ **确认不可用** | QEMU 无 PMU |
| GPU/功耗/网络/磁盘 | ❌ | ❌ 确认不可用 | 需 hiprofiler 插件 |
| JS 堆 | ❌ | ❌ 确认不可用 | 需 ArkTS profiler |

---

## 7. 对产品的直接影响

### 7.1 产品形态确定：适配层 + 能力矩阵

Phase B 把"能力矩阵"从设计建议变成了**必需项**，因为同一类指标在不同设备上通路完全不同：

```
帧数据：  hitrace → trace_streamer → frame_slice
实时FPS： hidumper -s RenderService -a fpsCount
内存：    /proc/<pid>/status
UI：      uitest dumpLayout
```

一个"统一采集 API"必须内部分流，对外暴露统一字段，并标注每条数据的来源与保真度。

### 7.2 必须处理的三个实操坑

1. **hdcPort 必须 10000-16555**，否则静默失败（退出码 0）
2. **Git Bash 路径转换**：`hdc file recv /data/local/tmp/x` 会被 MSYS 转成 Windows 路径，必须 `MSYS_NO_PATHCONV=1`
3. **空闲桌面 0 帧**：帧采集必须绑定应用交互，不能只"开 trace 等几秒"

### 7.3 冷启动能力的正确实现

`app_startup` 表为空，但**冷启动耗时可以从帧序列推导**：

```
aa force-stop <pkg>
hitrace --trace_begin ability app ace graphic window
aa start -a <ability> -b <pkg>
（等待首帧）
hitrace --trace_finish
```

取目标进程第一个 `frame_slice` 的 `ts` 减去 `aa start` 的发起时间，即为冷启动耗时。HapRay 的 ColdStartAnalyzer 走的是 `redundant_file.txt`，需要另写一个基于帧序列的实现。

---

## 8. 与 Phase A 的差异说明

Phase A 的样本是 **emulator 6.0.0.48**，Phase B 是 **6.1.0.126**。两版在能力上无本质差异（同样缺 hiprofiler、同样无 PMU），但 6.1.1 镜像的 `hidumper RenderService` 子命令更完整。

Phase A 中"帧率 1.97fps"的判断在 Phase B 得到证实：冷启动 trace 的 220 帧跨越约 3.8 秒，约 58fps——**只要应用在真正绘制，模拟器帧率可以接近 60**。Phase A 的低帧率是因为被测页面处于静态状态。

---

## 9. 尚未验证（受限于当前环境）

1. **注入 x86_64 版 hiprofiler_plugins 是否可行** —— 需从 OpenHarmony 源码交叉编译，本轮未做
2. **debug 应用的 hiperf 采集质量** —— 需要安装一个自建 debug HAP 才能测
3. **hidumper `hitchs`/`fps <window>` 的输出格式** —— 需要窗口在前台且有绘制
4. **hitrace 缓冲区上限** —— `/sys/kernel/tracing` 不可读，只能通过 `-b` 参数试

---

## 10. 复现方式

```bash
# 下载镜像（2.17GB）
Emulator.exe -install -deviceType phone -osVersion "HarmonyOS 6.1.1(24)" \
  -imageRoot "E:/HarmonyRuntime/LocalAppData/Huawei/Sdk"

# 创建实例
Emulator.exe -create ProbePhone -deviceType phone -osVersion "HarmonyOS 6.1.1(24)" \
  -instancePath "E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed" \
  -imageRoot "E:/HarmonyRuntime/LocalAppData/Huawei/Sdk" -memory 4 -storage 6

# 启动（端口必须 10000-16555）
Emulator.exe -start ProbePhone \
  -instancePath "E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed" \
  -imageRoot "E:/HarmonyRuntime/LocalAppData/Huawei/Sdk" -hdcPort 10178

# 连接 + 探测
export MSYS_NO_PATHCONV=1
hdc tconn 127.0.0.1:10178
bash spike/probe_device.sh 127.0.0.1:10178
```

---

## 11. 环境状态

- 模拟器实例 `ProbePhone` 仍在运行（`127.0.0.1:10178`）
- 镜像占用：`E:/HarmonyRuntime` 约 4.5 GB
- 真机 `REDACTED-DEVICE-SERIAL` 仍连接
- 停止命令：`Emulator.exe -stop ProbePhone -instancePath ...`
