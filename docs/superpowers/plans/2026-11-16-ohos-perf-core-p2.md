# ohos-perf P2 Rich Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: complete (verified 2026-11-16).** All 8 tasks shipped. Re-verified: `hdc` emits `-cwd /` with a relative device path; the HapRay plugin templates and `expand_pids` expansion are pinned by tests; the recorded Mate 60 probe fixture is committed at `test/fixtures/probe-mate60-hiprofiler.txt` (the plan's path said `packages/core/test/fixtures/`, which is a plan typo — the test reads the real one); `collect-hiprofiler.device.test.ts` passes against the attached device.

**Goal:** Add the rich-collection plane: a hiprofiler collector driven by `hiprofiler_cmd` with plugin configurations ported from HapRay (ftrace, nativehook, gpu, xpower), producing a scene that converts through `trace_streamer` into the same 88-table SQLite the existing analyzers already read — plus honest capability reporting for those plugins.

**Architecture:** A pure config builder renders hiprofiler's protobuf-text session config from a list of plugins. A collector writes that config to the device, runs one `hiprofiler_cmd` session, pulls the resulting `.htrace` into the scene, and hands it to the existing `Streamer`. No gRPC and no proto extraction: `hiprofiler_cmd` is the control path HapRay itself uses, and it is verified working on the real device as the shell user.

**Tech Stack:** TypeScript (ESM), `node:sqlite`, Vitest, Node `^22.13.0 || >=23.4.0`, no new npm dependencies, external binaries `hdc` / `trace_streamer` / `hiprofiler_cmd`.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` (§3, §6, §9, §11 P2)

## Global Constraints

- Node engines: `^22.13.0 || >=23.4.0`; ESM only; no new runtime dependencies. `hiprofiler_cmd` is an external device binary resolved over the existing `Hdc` transport, exactly like `hitrace`.
- Source of truth for ported plugin templates: HapRay `9386e4e` at `E:\CodeE\vibe51\performance_rq\performance_rq\hapray_perf_testing`. Template text is copied verbatim; only placeholders are parameterized.
- **License:** templates carry the header `Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.` The rest of the project stays MIT.
- **Device safety:** every capture stops its session on every path (including errors). A failed capture must never leave `hiprofilerd` running, and must never leave a partial `.htrace` that later converts as if it were a completed capture.
- **No stale scenes:** a failed hiprofiler capture must not leave a previous capture's `trace.db` looking like this capture's result.
- **Capability honesty:** a capability is reported available only when the package can actually drive it. When a plugin's session cannot start, the matrix says so with the daemon's own message.
- Every metric still carries `provenance` and `fidelity`; no `NaN`/`Infinity`/`null`.
- Read-only databases: never write to a scene's `trace.db`.
- Each task ends with `npm test` green and one commit containing code, tests and exports.

## Verified device facts (measured 2026-11-16, Mate 60 / API 26, shell uid 2000, no root)

These drive several decisions below; do not re-litigate them without new measurements.

| Fact | Consequence |
|---|---|
| `hiprofiler_cmd --start` → `--getport` = `127.0.0.1:50051`; `hdc fport tcp:50051 tcp:50051` works | gRPC transport exists, but is **not needed**: the CLI path works unprivileged |
| A config needs `session_config { buffers { pages: 16384 } }`; `pages: 4096` was rejected | Builder pins 16384 as the default and validates `pages >= 16384` |
| Every `plugin_configs` entry needs a `config_data { }` block — without it the daemon answers `unknown plugin: <name>` and `CreateSession FAIL` | Builder always emits `config_data`, even when empty |
| `ftrace-plugin`, `gpu-plugin`, `xpower-plugin`, `nativehook`, `memory-plugin` all complete sessions and write `<out>.htrace` | Plane A is viable on this device |
| The resulting `.htrace` converts through `trace_streamer` into the same 88 tables (ftrace-plugin: 4883 `sched_slice`, 8698 `thread_state`) | No new ingest path; `Streamer.convert` is reused |
| `hiperf record --all` needs root; `hiperf record --app <pkg>` works only for debug/profileable apps | hiperf belongs to a later plan; do not claim it here |
| This `hdc` build resolves `file send/recv` paths against the server cwd (`D:/Application/Git`); only `file recv -cwd / <relative-remote> <absolute-local>` worked | Task 1 fixes the transport before any collector uses it |

**Ruling (deviation from design D7):** P2 drives hiprofiler through `hiprofiler_cmd` and does **not** add `@grpc/grpc-js`, `@grpc/proto-loader`, or a `packages/proto` workspace. Rationale: the CLI path is what HapRay uses and it is verified on the real device; gRPC adds two dependencies and a proto-extraction/verification pipeline for no capability the CLI cannot reach. Cost if wrong: if a later capability needs live plugin control (streaming start/stop without files), the proto work returns as a separate plan.

## Review Focus

1. **A session that fails after starting** — `hiprofiler_cmd` may leave `hiprofilerd` running. Every failure path must still issue `hiprofiler_cmd --kill`.
2. **A config the builder accepts but the daemon rejects** — `unknown plugin` is the daemon's response to a missing `config_data`, not to a bad name. The collector must surface that message verbatim, not retry blindly.
3. **Absolute device paths in `file send/recv`** — they fail on hdc builds whose server cwd is not `/`. Task 1 pins the relative form; a regression silently breaks `collect` on real devices while every test passes.
4. **Scene reuse** — re-capturing into an existing `sceneRoot` after a failed hiprofiler run must not let `analyze` read the old `trace.db` as the new capture.
5. **Shell interpolation** — plugin names, pids, durations and paths are interpolated into device commands; validate each with a bare-name/positive-integer rule before the first device call.

---

### Task 1: Fix hdc file transfer on real devices

**Files:**
- Modify: `packages/core/src/transport/hdc.ts:146-175` (`buildArgv`), `:314-330` (`recv`/`send`)
- Test: `packages/core/test/hdc.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Hdc.recv(target, devicePath, localPath)` and `Hdc.send(target, localPath, devicePath)` now emit `file recv|send -cwd / <relative-device-path> <absolute-local-path>`, so every later collector can transfer files on this hdc build.

- [x] **Step 1: Write the failing test**

```ts
it('passes -cwd / and a relative device path to file recv', async () => {
  const spawn = vi.fn().mockResolvedValue(msg('FileTransfer finish, Size: 1'));
  const hdc = new Hdc({ hdcPath: 'hdc', spawn });
  await hdc.recv('dev-1', '/data/local/tmp/x.htrace', '/tmp/x.htrace');
  expect(spawn).toHaveBeenCalledWith([
    '-t', 'dev-1', 'file', 'recv', '-cwd', '/',
    'data/local/tmp/x.htrace', expect.stringMatching(/x\.htrace$/),
  ]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/hdc.test.ts -t "file recv"`
Expected: FAIL — the argv has no `-cwd /` and keeps the leading slash.

- [x] **Step 3: Implement the argv change**

In `buildArgv`, for `recv`/`send`, emit `['-t', target, 'file', op, '-cwd', '/', relativeDevicePath, localPath]`. Add `toRelativeDevicePath(path)` that strips exactly one leading `/` (and rejects a path that is not absolute, so a caller cannot silently rely on the server cwd).

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/hdc.test.ts`
Expected: PASS, including the existing send/recv assertions updated to the new argv.

- [x] **Step 5: Verify on the device**

Send a small config file and receive it back; record both commands and their output in the task report.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/transport/hdc.ts packages/core/test/hdc.test.ts
git commit -m "fix: transfer hdc files with -cwd / and relative device paths"
```

---

### Task 2: Hiprofiler session config builder

**Files:**
- Create: `packages/core/src/collectors/hiprofiler/config.ts`
- Test: `packages/core/test/collector-hiprofiler-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface HiprofilerPlugin {
    readonly pluginName: string;       // 'ftrace-plugin', 'gpu-plugin', …
    readonly sampleIntervalMs?: number; // default 1000
    readonly configData: string;        // protobuf-text body, no outer braces
  }
  export interface HiprofilerConfigOptions {
    readonly plugins: readonly HiprofilerPlugin[];
    readonly bufferPages?: number;      // default 16384, must be >= 16384
  }
  export function buildHiprofilerConfig(opts: HiprofilerConfigOptions): string;
  ```

- [x] **Step 1: Write the failing test**

```ts
it('emits the session envelope the daemon requires', () => {
  const text = buildHiprofilerConfig({
    plugins: [{ pluginName: 'gpu-plugin', configData: '' }],
  });
  expect(text).toBe([
    'request_id: 1',
    'session_config {',
    '  buffers {',
    '    pages: 16384',
    '  }',
    '}',
    'plugin_configs {',
    '  plugin_name: "gpu-plugin"',
    '  sample_interval: 1000',
    '  config_data {',
    '  }',
    '}',
    '',
  ].join('\n'));
});

it('rejects a buffer page count below the measured minimum', () => {
  expect(() => buildHiprofilerConfig({ plugins: [], bufferPages: 4096 }))
    .toThrow(/HIPROFILER_BAD_BUFFER/);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/test/collector-hiprofiler-config.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Implement the builder**

Validate each `pluginName` against `/^[a-z][a-z0-9_-]*$/` and each `configData` line against `^[a-zA-Z0-9_]+: .+$` (protobuf text is line-oriented; rejecting anything else prevents both injection and silently malformed configs). Always emit `config_data {` … `}` even when empty. Indent `configData` by four spaces inside the block.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/collector-hiprofiler-config.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/collectors/hiprofiler/config.ts packages/core/test/collector-hiprofiler-config.test.ts
git commit -m "feat: build hiprofiler session configs with the required envelope"
```

---

### Task 3: Plugin templates ported from HapRay

**Files:**
- Create: `packages/core/src/collectors/hiprofiler/templates.ts`
- Modify: `THIRD_PARTY_NOTICES.md` (if it does not already name the templates)
- Test: `packages/core/test/collector-hiprofiler-templates.test.ts`

**Interfaces:**
- Consumes: `HiprofilerPlugin` from Task 2.
- Produces:
  ```ts
  export function ftracePlugin(opts?: { categories?: string[]; bufferKb?: number }): HiprofilerPlugin;
  export function nativehookPlugin(opts: { pids: number[] }): HiprofilerPlugin;
  export function gpuPlugin(): HiprofilerPlugin;
  export function xpowerPlugin(): HiprofilerPlugin;
  export const PLANE_A_PLUGINS: readonly HiprofilerPlugin[];
  ```

- [x] **Step 1: Write the failing tests**

```ts
it('expands nativehook pids into repeated expand_pids lines', () => {
  const p = nativehookPlugin({ pids: [6115, 6120] });
  expect(p.pluginName).toBe('nativehook');
  expect(p.configData).toContain('expand_pids: "6115,6120"');
});

it('keeps the HapRay ftrace event set verbatim', () => {
  const p = ftracePlugin();
  expect(p.configData).toContain('ftrace_events: "sched/sched_switch"');
  expect(p.configData).toContain('buffer_size_kb: 204800');
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/collector-hiprofiler-templates.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Implement the templates**

Copy `FTRACE_PLUGIN_CONFIG`, `MEMORY_PLUGIN_CONFIG` (as `nativehookPlugin`) and `PERF_PLUGIN_CONFIG` text from `hapray/core/collection/command_templates.py`, unescaping the doubled braces. `gpuPlugin()` and `xpowerPlugin()` are empty `config_data` blocks — measured to work. Add the license header to this file.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/collector-hiprofiler-templates.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/collectors/hiprofiler/templates.ts THIRD_PARTY_NOTICES.md packages/core/test/collector-hiprofiler-templates.test.ts
git commit -m "feat: port HapRay plugin templates for hiprofiler"
```

---

### Task 4: HiprofilerCollector

**Files:**
- Create: `packages/core/src/collectors/hiprofiler/index.ts`
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/collector-hiprofiler.test.ts`

**Interfaces:**
- Consumes: `buildHiprofilerConfig` (Task 2), plugin factories (Task 3), `Hdc`, `SceneLayout`.
- Produces:
  ```ts
  export interface HiprofilerCollectOptions {
    readonly durationMs: number;
    readonly plugins: readonly HiprofilerPlugin[];
    readonly bufferPages?: number;
  }
  export class HiprofilerCollector {
    readonly id: 'hiprofiler';
    readonly provides: CapabilityId[];
    collect(hdc: Hdc, target: string, opts: HiprofilerCollectOptions, layout: SceneLayout): Promise<void>;
  }
  ```

- [x] **Step 1: Write the failing tests** (fake `Hdc` records shell/send/recv calls)

Cover: stale device file removed before the session; config sent; `hiprofiler_cmd -c … -o … -t N -s -k` issued; `DONE` required; size > 0 required before recv; `--kill` issued when the session fails; no partial `layout.traceFile` on failure.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/collector-hiprofiler.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Implement the collector**

Mirror `HitraceCollector`'s safety ordering: remove the fixed device paths, `send` the config, run the session, require the `DONE` marker, require a positive file size, then `recv` into `layout.traceFile`. In `finally`, always issue `hiprofiler_cmd --kill` (swallow its error). Validate duration (`(0, 2^31-1]`), pid lists (positive integers) and buffer pages before the first device call.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/collector-hiprofiler.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/collectors/hiprofiler/index.ts packages/core/src/index.ts packages/core/test/collector-hiprofiler.test.ts
git commit -m "feat: add the hiprofiler collector"
```

---

### Task 5: Wire hiprofiler into Device.collect

**Files:**
- Modify: `packages/core/src/device/device.ts` (`CollectOptions`, `ingest()`)
- Test: `packages/core/test/device.test.ts`

**Interfaces:**
- Consumes: `HiprofilerCollector` (Task 4).
- Produces: ``CollectOptions.hiprofiler?: { plugins?: readonly HiprofilerPlugin[]; bufferPages?: number }``. When set, the trace artifact comes from hiprofiler instead of hitrace, and `scene.json` records `collectors: ['hiprofiler']`.

- [x] **Step 1: Write the failing tests**

`collect({ hiprofiler: { plugins: [gpuPlugin()] } })` calls `HiprofilerCollector.collect` once and not `HitraceCollector.collect`; `scene.json` records `['hiprofiler']`; a hiprofiler failure leaves the previous scene's `trace.db` and `scene.json` untouched.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/device.test.ts -t hiprofiler`
Expected: FAIL.

- [x] **Step 3: Implement the branch**

Gate on the same `trace.frames` capability. Keep the existing conversion ordering: the new `.htrace` is written to the scene's `traceFile` and converted by the existing `Streamer`; `scene.json` is written only after conversion succeeds.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/device.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/device/device.ts packages/core/test/device.test.ts
git commit -m "feat: collect scenes through hiprofiler"
```

---

### Task 6: Plugin-aware capability reporting

**Files:**
- Modify: `packages/core/src/device/probe.ts`, `packages/core/src/device/capability.ts`
- Test: `packages/core/test/probe.test.ts`, `packages/core/test/capability.test.ts`

**Interfaces:**
- Consumes: the existing probe snapshot.
- Produces: `ProbeSnapshot.hiprofilerPlugins: string[] | undefined` parsed from `hiprofiler_cmd --list` (tolerating `Service not started`), and capability verdicts that cite the plugin list as their evidence.

- [x] **Step 1: Write the failing tests**

`parseHiprofilerPlugins` extracts `cpu-plugin`, `gpu-plugin`, `nativehook`, … from the `capabilities { name: "…" }` blocks and returns `undefined` for `Service not started`. `mem.gpu` is available only when `gpu-plugin` is listed, not merely when `hiprofiler_cmd` exists.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/core/test/probe.test.ts packages/core/test/capability.test.ts -t hiprofiler`
Expected: FAIL.

- [x] **Step 3: Implement**

Add one probe command (`hiprofiler_cmd --list`) to the fixed command order; when it reports `Service not started`, treat the plugin list as unknown and keep today's binary-based verdicts (documented in the matrix reason). When it returns a list, gate each hiprofiler-backed capability on its plugin.

- [x] **Step 4: Run the tests**

Run: `npx vitest run packages/core/test/probe.test.ts packages/core/test/capability.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/core/src/device/probe.ts packages/core/src/device/capability.ts packages/core/test/probe.test.ts packages/core/test/capability.test.ts
git commit -m "feat: gate hiprofiler capabilities on the device's plugin list"
```

---

### Task 7: CLI and documentation

**Files:**
- Modify: `packages/cli/src/program.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/collect.ts`
- Modify: `README.md`, `site/index.html`
- Test: `packages/cli/test/program.test.ts`, `packages/cli/test/deps.test.ts`

**Interfaces:**
- Consumes: Task 5's `CollectOptions.hiprofiler`.
- Produces: `collect --hiprofiler --plugins gpu,xpower,nativehook`.

- [x] **Step 1: Write the failing tests**

`--plugins gpu,xpower` maps to the two plugin factories; an unknown name exits 1 with one stderr line and empty stdout.

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/cli/test/program.test.ts packages/cli/test/deps.test.ts -t hiprofiler`
Expected: FAIL.

- [x] **Step 3: Implement and document**

Add the flag, wire it through `runCollect`, and update README's collector list and the site's L2 line (both languages).

- [x] **Step 4: Run the tests**

Run: `npm test`
Expected: all green.

- [x] **Step 5: Commit**

```bash
git add packages/cli/src README.md site/index.html packages/cli/test
git commit -m "feat(cli): expose hiprofiler collection"
```

---

### Task 8: Real-device acceptance and fixtures

**Files:**
- Create: `packages/core/test/collect-hiprofiler.device.test.ts`
- Create: `packages/core/test/fixtures/probe-mate60-hiprofiler.txt` (recorded `hiprofiler_cmd --list` output)

**Interfaces:**
- Consumes: everything above.
- Produces: a skipped-unless-a-device-is-attached test that captures 3 s with `ftrace-plugin`, converts, and asserts `sched_slice` is non-empty; plus the recorded probe fixture used by Task 6's tests.

- [x] **Step 1: Record the fixture** from the connected device and commit it.
- [x] **Step 2: Write the acceptance test** using `it.skipIf(!deviceAttached)`.
- [x] **Step 3: Run it on the device** and paste the full command/output in the task report.
- [x] **Step 4: Commit**

```bash
git add packages/core/test/collect-hiprofiler.device.test.ts packages/core/test/fixtures/probe-mate60-hiprofiler.txt
git commit -m "test: accept hiprofiler collection on a real device"
```

---

## Deferred (explicitly out of this plan)

- **Plane B collectors** — `hiperf` (debug/profileable apps only), `hidumper`, `uitest`. Their commands are known (`hiperf record --app`, `hidumper -s WindowManagerService -a '-a'`, `uitest screenCap`), but each needs its own collection contract and fixtures.
- **gRPC + proto extraction (design D7)** — deferred by the ruling above.
- **Multi-artifact ingestion** (`trace_streamer -D` with `.htrace` + `perf.data`) — `-D` produced no database in a manual test; `perf_sample` stays empty until this is resolved.
- **hiprofiler `memory-plugin` / `network-plugin` / `diskio-plugin` analyzers** — collection only becomes useful once an analyzer consumes their tables; not part of P2's acceptance.
