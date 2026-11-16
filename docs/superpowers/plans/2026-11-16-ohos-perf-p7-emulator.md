# P7 Emulator Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ohos-perf emulator {list,start,stop,create}` — a core module that drives DevEco's `Emulator.exe` and an `hdc` poller to take an emulator from "installed on this machine" to "a target id `collect --target` accepts", plus a thin CLI command group.

**Architecture:** `packages/core/src/device/emulator.ts` holds two layers. `EmulatorClient` is the only thing that spawns `Emulator.exe`; it resolves the binary, builds argv, and classifies output — necessary because the binary exits `0` on every failure measured. `EmulatorLifecycle` owns state and waiting, taking a client-shaped object and a structural `hdc` slice so both are injectable. The CLI parses arguments and renders; it holds no lifecycle logic.

**Tech Stack:** TypeScript (ESM), Vitest, commander, npm workspaces. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-16-ohos-perf-p7-emulator-design.md` — read it first. Its §3 (measured facts) and §6 (behaviour) are the authority this plan argues from.

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- **The exit code carries no information.** `Emulator.exe` exits `0` for `Unable to start the emulator`, `Emulator: Unknown option 'bogus'.` and a silently rejected `-create`. Success is proven by re-reading state or by the absence of a failure line — never by `$?`.
- Failure detection is structural: a trimmed output line matching `/^Emulator: /` or `/^Unable to /` is a failure. Measured warnings (`Windows Hypervisor Platform accelerator is operational`, `GLib: g_hash_table_remove_all: assertion … failed`, `[dshow …] Could not enumerate video devices`) must **not** count as failures.
- Every new value export goes into `VALUE_EXPORTS` in `packages/core/test/types.test.ts`; every type referenced by a public signature is exported from `packages/core/src/index.ts`.
- `spawn(command, args, { shell: false, windowsHide: true })` — never a shell. Install paths contain spaces (`D:\Application\DevEco Studio\...`).
- The determinism contract (D5) governs analysis output, not this feature. Lifecycle `--json` promises stable key order and array order only; `waitedMs` is wall-clock.
- No image download. `create` fails with a copy-pasteable `-install` command instead.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Measured facts

From the spec §3, repeated because tasks use them verbatim.

| Fact | Value |
| --- | --- |
| `-version` | `HarmonyOS Emulator :6.1.1.200` (trailing CRLF) |
| `-list` with no instances | `[Empty]` |
| `-list -details` | JSON array; `isRunning` is the **string** `"true"`/`"false"` |
| `-start` on an unknown name | `Unable to start the emulator`, **no trailing newline** |
| `-stop` success line | `Stop emulator <name> successfully` |
| `-create` success line | `Device create success. You can use the '-start' command to start it.` |
| `-create` with a bad deviceType/osVersion/name | silent, exit 0, nothing created |
| Instance root on this machine | `E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed` via `.emu_config` `emuPath` |
| Image root on this machine | `E:/HarmonyRuntime/LocalAppData/Huawei/Sdk` via `.emu_config` `imagePath` |
| Boot param | `hdc -t <target> shell "param get bootevent.boot.completed"` → `true` |
| Emulator hdc target | `127.0.0.1:5555  TCP  Connected` |
| Real device target | `9CN0224924009344  USB  Connected` — excluded by the TCP filter |

## Review Focus

1. **A non-fatal line starting `Emulator: ` aborts the command.** Structural matching cannot tell a warning from an error. Task 2 pins the documented behaviour so it is a deliberate choice, not an accident.
2. **`emulator list` with nothing running must not touch `hdc`.** A machine with no `hdc` on `PATH` still has to be able to list instances. Task 4's test fails if `list()` consults hdc unconditionally.
3. **`--timeout 0` must be rejected, not spin.** A zero or negative budget would make the poll loop exit on its first check with a confusing message. Task 8's test pins the rejection.
4. **An instance name becomes a directory name.** `../x` must be rejected before any spawn. Task 6's test.
5. **A path with a space must reach the binary as one argv element.** `D:\Application\DevEco Studio\...` is the real install path. Task 3's test asserts the argv array.

---

### Task 1: `EmulatorClient` — binary discovery and version

**Files:**
- Create: `packages/core/src/device/emulator.ts`
- Modify: `packages/core/src/errors.ts` (append one class)
- Test: `packages/core/test/emulator-client.test.ts`

**Interfaces:**
- Consumes: `Env` from `../transport/hdc`; `OhosPerfError` from `../errors`.
- Produces:
  - `class EmulatorNotFoundError extends OhosPerfError { readonly searchedPaths: string[] }`, constructor `(searchedPaths: string[], opts?: { cause?: unknown; code?: string })`.
  - `interface EmulatorClientOptions { emulatorPath?: string; env?: Env; commonPaths?: string[]; instancePath?: string; imageRoot?: string }`
  - `class EmulatorClient`, constructor `(opts?: EmulatorClientOptions)`, `resolvePath(): Promise<string>`, `version(): Promise<string>`, and `protected spawnProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>` (the test seam; overridden by stubs).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/emulator-client.test.ts
import { describe, it, expect } from 'vitest';
import { EmulatorClient, EmulatorNotFoundError } from '../src/device/emulator';

const BIN = 'C:/fake/Emulator.exe';

class StubEmulator extends EmulatorClient {
  readonly calls: { command: string; args: string[] }[] = [];
  constructor(
    private readonly result: { stdout?: string; stderr?: string; code?: number },
    opts: ConstructorParameters<typeof EmulatorClient>[0] = { emulatorPath: BIN },
  ) {
    super(opts);
  }
  protected override async spawnProcess(command: string, args: string[]) {
    this.calls.push({ command, args });
    return { stdout: this.result.stdout ?? '', stderr: this.result.stderr ?? '', code: this.result.code ?? 0 };
  }
}

describe('EmulatorClient.resolvePath', () => {
  it('prefers the explicit path', async () => {
    const client = new EmulatorClient({ emulatorPath: BIN, env: { PATH: '' }, commonPaths: [] });
    await expect(client.resolvePath()).resolves.toBe(BIN);
  });

  it('reads OHOS_PERF_EMULATOR when no explicit path is given', async () => {
    const client = new EmulatorClient({ env: { OHOS_PERF_EMULATOR: BIN, PATH: '' }, commonPaths: [] });
    await expect(client.resolvePath()).resolves.toBe(BIN);
  });

  it('lists every candidate in search order when nothing is found', async () => {
    const client = new EmulatorClient({
      emulatorPath: 'C:/nope/a.exe',
      env: { OHOS_PERF_EMULATOR: 'C:/nope/b.exe', PATH: 'C:/nope/bin' },
      commonPaths: ['C:/nope/c.exe'],
    });
    const error = await client.resolvePath().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorNotFoundError);
    expect((error as EmulatorNotFoundError).searchedPaths).toEqual([
      'C:/nope/a.exe', 'C:/nope/b.exe', 'C:/nope/c.exe', 'C:/nope/bin/Emulator.exe',
    ]);
  });
});

describe('EmulatorClient.version', () => {
  it('parses the banner the real binary prints', async () => {
    const client = new StubEmulator({ stdout: 'HarmonyOS Emulator :6.1.1.200\r\n' });
    await expect(client.version()).resolves.toBe('6.1.1.200');
    expect(client.calls[0]).toEqual({ command: BIN, args: ['-version'] });
  });

  it('fails loudly on an unrecognised banner instead of returning garbage', async () => {
    const client = new StubEmulator({ stdout: 'something else entirely' });
    await expect(client.version()).rejects.toThrow(/unrecognised -version output/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: FAIL — cannot resolve `../src/device/emulator`.

- [ ] **Step 3: Implement**

In `packages/core/src/errors.ts`, append beside `StreamerNotFoundError`:

```ts
export class EmulatorNotFoundError extends OhosPerfError {
  readonly searchedPaths: string[];
  constructor(searchedPaths: string[], opts: { cause?: unknown; code?: string } = {}) {
    super(
      `HarmonyOS emulator executable not found. Searched paths: ${searchedPaths.join(', ')}`,
      opts,
    );
    this.searchedPaths = searchedPaths;
  }
}
```

In `packages/core/src/device/emulator.ts`:

- `resolvePath()` builds candidates in this order, de-duplicated, and returns the first that `existsSync` accepts: `opts.emulatorPath`, `env.OHOS_PERF_EMULATOR`, `opts.commonPaths ?? defaultCommonPaths(env, platform)`, then every `PATH` entry joined with the binary name.
- `defaultCommonPaths(env, platform)`: on `win32` returns `join(env.DEVECO_SDK_HOME ?? '', 'tools', 'emulator', 'Emulator.exe')` (only when the var is set), `join('D:', 'Application', 'DevEco Studio', 'tools', 'emulator', 'Emulator.exe')`, `join('C:', 'Program Files', 'Huawei', 'DevEco Studio', 'tools', 'emulator', 'Emulator.exe')`. On any other platform returns `[]` — the spec forbids inventing a macOS path.
- Binary name: `Emulator.exe` on `win32`, `Emulator` elsewhere (used only for the `PATH` join).
- `version()` spawns `['-version']`, matches `/HarmonyOS Emulator\s*:\s*(\d+\.\d+\.\d+)/` against stdout, returns group 1. No match → throw `OhosPerfError` with message starting `unrecognised -version output: ` followed by the trimmed stdout. Cache the parsed value per instance.
- `spawnProcess` is `protected`, copies the shape of `Hdc`'s private spawn: `spawn(command, args, { shell: false, windowsHide: true, env: this.env })`, accumulate `stdout`/`stderr` as utf8, resolve `{ stdout, stderr, code: code ?? -1 }`, reject with `OhosPerfError` carrying code `EMULATOR_SPAWN_FAILED` on `error`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/device/emulator.ts packages/core/test/emulator-client.test.ts
git commit -m "feat(core): locate the HarmonyOS emulator binary and read its version"
```

---

### Task 2: `EmulatorClient` — `listDetailed`, `imageList`, failure classification

**Files:**
- Modify: `packages/core/src/device/emulator.ts`
- Modify: `packages/core/src/errors.ts` (append one class)
- Create: `packages/core/test/fixtures/emulator/list-details.json`
- Create: `packages/core/test/fixtures/emulator/image-list.json`
- Create: `packages/core/test/fixtures/emulator/list-empty.txt`
- Create: `packages/core/test/fixtures/emulator/start-failure.txt`
- Test: `packages/core/test/emulator-client.test.ts`

**Interfaces:**
- Consumes: `EmulatorClient` and `EmulatorClientOptions` from Task 1.
- Produces:
  - `interface EmulatorInstance { name: string; running: boolean; apiVersion?: string; imageDir?: string; instancePath: string; uuid?: string; osVersion?: string; target?: string; targetReason?: string }`
  - `interface EmulatorImage { deviceType: string; osVersion: string; downloaded: boolean; softwareVersion: string; releaseType?: string }`
  - `class EmulatorCommandError extends OhosPerfError { readonly output: string }`, constructor `(message: string, output: string, opts?: { cause?: unknown; code?: string })`.
  - `EmulatorClient.listDetailed(): Promise<EmulatorInstance[]>` and `EmulatorClient.imageList(): Promise<EmulatorImage[]>`, both sorted deterministically (instances by `name`; images by `deviceType` then `osVersion`).

- [ ] **Step 1: Write the failing test**

```ts
// appended to packages/core/test/emulator-client.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EmulatorCommandError } from '../src/device/emulator';

const FIXTURES = fileURLToPath(new URL('./fixtures/emulator/', import.meta.url));
const fixture = (name: string): string => readFileSync(FIXTURES + name, 'utf8');

describe('EmulatorClient.listDetailed', () => {
  it('parses the real -details JSON, reading isRunning as a string', async () => {
    const client = new StubEmulator({ stdout: fixture('list-details.json') });
    const [instance] = await client.listDetailed();
    expect(instance).toEqual({
      name: 'ProbePhone',
      running: false,
      apiVersion: '24',
      imageDir: 'system-image/HarmonyOS-6.1.1/phone_all_x86/',
      instancePath: 'E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed/ProbePhone',
      uuid: '1813e81f-a5ec-4cd2-b347-b5074c756dbd',
      osVersion: 'HarmonyOS 6.1.1(24)',
    });
    expect(client.calls[0].args).toEqual(['-list', '-details']);
  });

  it('passes -path when an instance root is configured', async () => {
    const client = new StubEmulator(
      { stdout: '[]' },
      { emulatorPath: BIN, instancePath: 'C:/Users/me/DevEco Studio/instances' },
    );
    await client.listDetailed();
    expect(client.calls[0].args).toEqual([
      '-list', '-details', '-path', 'C:/Users/me/DevEco Studio/instances',
    ]);
  });

  it('reads [Empty] as zero instances', async () => {
    const client = new StubEmulator({ stdout: fixture('list-empty.txt') });
    await expect(client.listDetailed()).resolves.toEqual([]);
  });

  it('sorts instances by name', async () => {
    const rows = JSON.stringify([
      { name: 'beta', isRunning: 'false', instancePath: '/b' },
      { name: 'alpha', isRunning: 'false', instancePath: '/a' },
    ]);
    const client = new StubEmulator({ stdout: rows });
    await expect(client.listDetailed()).resolves.toEqual([
      { name: 'alpha', running: false, instancePath: '/a' },
      { name: 'beta', running: false, instancePath: '/b' },
    ]);
  });
});

describe('EmulatorClient.imageList', () => {
  it('parses downloaded images and stringifies nothing', async () => {
    const client = new StubEmulator({ stdout: fixture('image-list.json') });
    const images = await client.imageList();
    expect(images[0]).toEqual({
      deviceType: 'foldable',
      osVersion: 'HarmonyOS 6.1.1(24)',
      downloaded: true,
      softwareVersion: '6.1.0.126',
      releaseType: 'Release',
    });
    expect(client.calls[0].args).toEqual(['-imageList', '-downloaded', 'true']);
  });
});

describe('EmulatorClient failure classification', () => {
  it('throws on "Unable to …" even though the exit code is 0', async () => {
    const client = new StubEmulator({ stdout: fixture('start-failure.txt'), code: 0 });
    const error = await client.listDetailed().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorCommandError);
    expect((error as EmulatorCommandError).output).toContain('Unable to start the emulator');
  });

  it('throws on an "Emulator: " line', async () => {
    const client = new StubEmulator({ stdout: "Emulator: Unknown option 'bogus'.\r\n" });
    await expect(client.listDetailed()).rejects.toThrow(/Unknown option/);
  });

  it('does not treat the warnings a real -start prints as failure', async () => {
    const warnings = [
      'Windows Hypervisor Platform accelerator is operational',
      "D:\\Application\\DevEco Studio\\tools\\emulator\\Emulator.exe: GLib: g_hash_table_remove_all: assertion 'hash_table != NULL' failed",
      '[dshow @ 000001E1FD218080] Could not enumerate video devices (or none found).',
    ].join('\r\n');
    const client = new StubEmulator({ stdout: warnings });
    // No JSON to parse, so the parse error is what proves the scan passed.
    await expect(client.listDetailed()).rejects.toThrow(/JSON/);
  });

  it('fails loudly when a future build returns a non-zero exit code', async () => {
    const client = new StubEmulator({ stdout: '[]', code: 1 });
    await expect(client.listDetailed()).rejects.toThrow(EmulatorCommandError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: FAIL — `listDetailed`/`imageList`/`EmulatorCommandError` not exported.

- [ ] **Step 3: Write the fixtures**

Create the directory and these files, copied verbatim from the real binary's output:

`list-details.json` — the exact output of `Emulator.exe -list -details` on this machine (one object, every key, `"isRunning": "false"`).

`image-list.json` — the exact output of `Emulator.exe -imageList -downloaded true`, trimmed to the first two objects so the file stays small; keep the trailing `]`.

`list-empty.txt` — the single line `[Empty]` followed by CRLF.

`start-failure.txt` — `Unable to start the emulator` with **no trailing newline** (the real output has none; `printf` it, do not `echo`).

Each file's first line is not a comment (JSON cannot hold one); record the producing command in `packages/core/test/emulator-client.test.ts` above `const FIXTURES`.

- [ ] **Step 4: Implement**

`EmulatorCommandError` in `errors.ts`:

```ts
export class EmulatorCommandError extends OhosPerfError {
  readonly output: string;
  constructor(message: string, output: string, opts: { cause?: unknown; code?: string } = {}) {
    super(message, opts);
    this.output = output;
  }
}
```

In `emulator.ts`, a private `run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>` that calls `resolvePath()` then `spawnProcess`, then a private `assertOk(args, result)`:

- Split `stdout + '\n' + stderr` into lines, trim each.
- If `result.code !== 0` → throw `EmulatorCommandError` with `` `${args[0]} exited ${code}` `` and the full output.
- If any trimmed line matches `/^Emulator: /` or `/^Unable to /` → throw `EmulatorCommandError` whose message is that line and whose `output` is the full output.
- Return the result otherwise.

`listDetailed()`: args `['-list', '-details', ...(instancePath ? ['-path', instancePath] : [])]`. After `assertOk`: if `stdout.trim() === '[Empty]'` return `[]`; `JSON.parse` inside a `try` and on failure throw `EmulatorCommandError` with message `` `unrecognised -list -details output: ${firstLine}` `` and the raw output. Map each row with the exact key names from the fixture (`name`, `isRunning`, `os.apiVersion`, `imageSubPath`, `instancePath`, `uuid`, `os.osVersion`), **omitting** optional fields that are absent rather than setting them to `undefined`, and sort by `name` with `localeCompare` on the raw string (not a locale-aware collator — determinism).

`imageList()`: args `['-imageList', '-downloaded', 'true', ...(imageRoot ? ['-imageRoot', imageRoot] : [])]`; parse the same way; map `SoftWareVersion` → `softwareVersion`, `downloaded` → `downloaded === 'true'`; sort by `deviceType`, then `osVersion`.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/device/emulator.ts packages/core/test/emulator-client.test.ts packages/core/test/fixtures/emulator
git commit -m "feat(core): parse emulator instance and image listings, and classify failures by output"
```

---

### Task 3: `EmulatorClient` — `startInstance`, `stopInstance`, `createInstance`

**Files:**
- Modify: `packages/core/src/device/emulator.ts`
- Test: `packages/core/test/emulator-client.test.ts`

**Interfaces:**
- Consumes: `assertOk`/`run` from Task 2.
- Produces:
  - `interface CreateEmulatorRequest { name: string; deviceType: string; osVersion: string; screenProfile?: string; memoryGb?: number; storageGb?: number }`
  - `EmulatorClient.startInstance(name: string): Promise<void>`
  - `EmulatorClient.stopInstance(name: string): Promise<void>`
  - `EmulatorClient.createInstance(req: CreateEmulatorRequest): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
describe('EmulatorClient mutating commands', () => {
  const withPaths = (): StubEmulator => new StubEmulator(
    { stdout: '' },
    {
      emulatorPath: BIN,
      instancePath: 'C:/Users/me/DevEco Studio/instances',
      imageRoot: 'C:/Users/me/DevEco Studio/sdk',
    },
  );

  it('builds -start argv with the instance root as one element', async () => {
    const client = withPaths();
    await client.startInstance('ProbePhone');
    expect(client.calls[0]).toEqual({
      command: BIN,
      args: [
        '-start', 'ProbePhone',
        '-instancePath', 'C:/Users/me/DevEco Studio/instances',
        '-imageRoot', 'C:/Users/me/DevEco Studio/sdk',
      ],
    });
  });

  it('builds -stop argv without -imageRoot', async () => {
    const client = withPaths();
    await client.stopInstance('ProbePhone');
    expect(client.calls[0].args).toEqual([
      '-stop', 'ProbePhone', '-instancePath', 'C:/Users/me/DevEco Studio/instances',
    ]);
  });

  it('builds -create argv from every supplied field', async () => {
    const client = withPaths();
    await client.createInstance({
      name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)',
      screenProfile: 'Mate 60', memoryGb: 6, storageGb: 8,
    });
    expect(client.calls[0].args).toEqual([
      '-create', 'SpecProbe',
      '-deviceType', 'phone',
      '-osVersion', 'HarmonyOS 6.1.1(24)',
      '-screenProfile', 'Mate 60',
      '-memory', '6',
      '-storage', '8',
      '-instancePath', 'C:/Users/me/DevEco Studio/instances',
      '-imageRoot', 'C:/Users/me/DevEco Studio/sdk',
    ]);
  });

  it('omits optional -create flags that were not supplied', async () => {
    const client = new StubEmulator({ stdout: '' }, { emulatorPath: BIN });
    await client.createInstance({ name: 'A', deviceType: 'phone', osVersion: 'V' });
    expect(client.calls[0].args).toEqual([
      '-create', 'A', '-deviceType', 'phone', '-osVersion', 'V',
    ]);
  });

  it('treats a silent exit-0 no-op as success at this layer', async () => {
    // The binary prints nothing and exits 0 when it rejects a create; the
    // lifecycle layer is what verifies the instance exists afterwards.
    const client = new StubEmulator({ stdout: '' });
    await expect(client.createInstance({ name: 'A', deviceType: 'phone', osVersion: 'V' }))
      .resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: FAIL — `startInstance` is not a function.

- [ ] **Step 3: Implement**

Three thin methods over `run` + `assertOk`:

- `startInstance(name)` → `['-start', name, ...instancePathArg, ...imageRootArg]`
- `stopInstance(name)` → `['-stop', name, ...instancePathArg]`
- `createInstance(req)` → `['-create', req.name, '-deviceType', req.deviceType, '-osVersion', req.osVersion, ...(screenProfile ? ['-screenProfile', req.screenProfile] : []), ...(memoryGb === undefined ? [] : ['-memory', String(req.memoryGb)]), ...(storageGb === undefined ? [] : ['-storage', String(req.storageGb)]), ...instancePathArg, ...imageRootArg]`

Where `instancePathArg` is `opts.instancePath === undefined ? [] : ['-instancePath', opts.instancePath]` and likewise for `imageRoot`. All three `await this.assertOk(args, await this.run(args))`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-client.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/device/emulator.ts packages/core/test/emulator-client.test.ts
git commit -m "feat(core): drive emulator start, stop and create with explicit argv"
```

---

### Task 4: `EmulatorLifecycle` — `list` and target attribution

**Files:**
- Modify: `packages/core/src/device/emulator.ts`
- Test: `packages/core/test/emulator-lifecycle.test.ts`

**Interfaces:**
- Consumes: `EmulatorInstance`, `EmulatorImage`, `CreateEmulatorRequest` from Tasks 2–3; `HdcTarget` from `../transport/hdc`.
- Produces:
  - `interface EmulatorBackend { listDetailed(): Promise<EmulatorInstance[]>; imageList(): Promise<EmulatorImage[]>; startInstance(name: string): Promise<void>; stopInstance(name: string): Promise<void>; createInstance(req: CreateEmulatorRequest): Promise<void> }`
  - `interface HdcSlice { listTargets(): Promise<HdcTarget[]>; shell(target: string, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> }`
  - `interface EmulatorLifecycleOptions { client?: EmulatorBackend; hdc?: HdcSlice; startTimeoutMs?: number; stopTimeoutMs?: number; pollMs?: number; now?: () => number }`
  - `class EmulatorLifecycle`, constructor `(opts?: EmulatorLifecycleOptions)`, `list(): Promise<EmulatorInstance[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/emulator-lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import {
  EmulatorLifecycle, type EmulatorInstance,
} from '../src/device/emulator';
import type { HdcTarget } from '../src/transport/hdc';

const instance = (name: string, running: boolean): EmulatorInstance =>
  ({ name, running, instancePath: `/instances/${name}` });

const target = (id: string, transport: string, connected: boolean): HdcTarget =>
  ({ id, connected, raw: `${id}\t\t${transport}\t${connected ? 'Connected' : 'Offline'}\tlocalhost\thdc` });

function fakeClient(instances: EmulatorInstance[]) {
  return {
    listDetailed: async () => instances,
    imageList: async () => [],
    startInstance: async () => {},
    stopInstance: async () => {},
    createInstance: async () => {},
  };
}

describe('EmulatorLifecycle.list target attribution', () => {
  it('does not consult hdc when nothing is running', async () => {
    let asked = false;
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', false)]),
      hdc: { listTargets: async () => { asked = true; return []; }, shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
    });
    const [a] = await lifecycle.list();
    expect(a.target).toBeUndefined();
    expect(a.targetReason).toBeUndefined();
    expect(asked).toBe(false);
  });

  it('attributes the single TCP target when exactly one instance runs', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true), instance('B', false)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true), target('REDACTED-DEVICE-SERIAL', 'USB', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const instances = await lifecycle.list();
    expect(instances.find((i) => i.name === 'A')?.target).toBe('127.0.0.1:5555');
    expect(instances.find((i) => i.name === 'B')?.target).toBeUndefined();
  });

  it('refuses to attribute when two emulators run', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true), instance('B', true)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.target).toBeUndefined();
    expect(a.targetReason).toContain('two emulators are running');
  });

  it('explains a missing TCP target', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true)]),
      hdc: {
        listTargets: async () => [target('REDACTED-DEVICE-SERIAL', 'USB', true), target('127.0.0.1:5555', 'TCP', false)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.targetReason).toContain('no connected TCP target');
  });

  it('refuses to attribute when two TCP targets are connected', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true)]),
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true), target('127.0.0.1:5557', 'TCP', true)],
        shell: async () => ({ stdout: '', stderr: '', code: 0 }),
      },
    });
    const [a] = await lifecycle.list();
    expect(a.targetReason).toContain('2 connected TCP targets');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: FAIL — `EmulatorLifecycle` is not exported.

- [ ] **Step 3: Implement**

Constructor defaults: `client = new EmulatorClient()` is **not** acceptable here (it would spawn during unit tests); instead require the caller to pass one and let `EmulatorLifecycleOptions.client` be optional only for the production factory in Task 8 — implement it as `this.client = opts.client ?? new EmulatorClient()`, which is lazy and never runs unless a method is called. `hdc` defaults to `new Hdc()`. `startTimeoutMs` 180_000, `stopTimeoutMs` 30_000, `pollMs` 1_000, `now` `Date.now`.

`list()`:

1. `const instances = await this.client.listDetailed()`.
2. `const running = instances.filter((i) => i.running)`; if `running.length === 0`, return `instances` unchanged (no `target`, no `targetReason`) — **before** touching hdc.
3. `const tcp = (await this.hdc.listTargets()).filter(isConnectedTcp)` where `isConnectedTcp` checks `t.connected` and `t.raw.split('\t').filter((s) => s !== '')[1] === 'TCP'`.
4. Decide, in this order: `running.length > 1` → reason `` `${running.length} emulators are running, so a target cannot be attributed` ``; `tcp.length === 0` → reason `'no connected TCP target was found'`; `tcp.length > 1` → reason `` `${tcp.length} connected TCP targets were found, so a target cannot be attributed` ``; otherwise the single `tcp[0].id`.
5. Return the running instance with `target` or `targetReason` set, all other instances untouched. Never mutate the array from the client.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/device/emulator.ts packages/core/test/emulator-lifecycle.test.ts
git commit -m "feat(core): list emulator instances and attribute a target only when unambiguous"
```

---

### Task 5: `EmulatorLifecycle` — `start` with three phases

**Files:**
- Modify: `packages/core/src/device/emulator.ts`
- Test: `packages/core/test/emulator-lifecycle.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `interface EmulatorStartResult { name: string; target: string; alreadyRunning: boolean; waitedMs: number }`; `EmulatorLifecycle.start(name: string, opts?: { timeoutMs?: number }): Promise<EmulatorStartResult>`.

- [ ] **Step 1: Write the failing test**

```ts
describe('EmulatorLifecycle.start', () => {
  /** A client whose isRunning flips after N listDetailed calls. */
  function startingClient(before: EmulatorInstance[], after: EmulatorInstance[]) {
    let calls = 0;
    const started: string[] = [];
    return {
      started,
      client: {
        listDetailed: async () => (calls++ === 0 ? before : after),
        imageList: async () => [],
        startInstance: async (name: string) => { started.push(name); },
        stopInstance: async () => {},
        createInstance: async () => {},
      },
    };
  }

  it('waits through instance, target and boot, then reports the target', async () => {
    const { client, started } = startingClient([instance('A', false)], [instance('A', true)]);
    const boots = ['', 'true'];
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: boots.shift() ?? 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    const result = await lifecycle.start('A');
    expect(started).toEqual(['A']);
    expect(result).toEqual({ name: 'A', target: '127.0.0.1:5555', alreadyRunning: false, waitedMs: expect.any(Number) });
  });

  it('is idempotent: a second start never spawns another emulator', async () => {
    const { client, started } = startingClient([instance('A', true)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    const result = await lifecycle.start('A');
    expect(started).toEqual([]);
    expect(result.alreadyRunning).toBe(true);
    expect(result.target).toBe('127.0.0.1:5555');
  });

  it('names the instance phase when isRunning never flips', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', false)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => { clock += 100; return []; }, shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/did not report isRunning after 100ms/);
  });

  it('names the target phase when no new TCP target appears', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', true)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => { clock += 100; return []; }, shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/no new TCP target appeared after 100ms/);
  });

  it('names the boot phase when bootevent.boot.completed stays false', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', true)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => { clock += 100; return { stdout: 'false', stderr: '', code: 0 }; },
      },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/bootevent\.boot\.completed never became true/);
  });

  it('every timeout tells the caller how to clean up', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', false)]);
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => { clock += 100; return []; }, shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
      startTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/ohos-perf emulator stop A/);
  });

  it('rejects two new TCP targets instead of picking one', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', true)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [
          target('127.0.0.1:5555', 'TCP', true), target('127.0.0.1:5557', 'TCP', true),
        ],
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/127\.0\.0\.1:5555.*127\.0\.0\.1:5557/);
  });

  it('reports the wall-clock wait', async () => {
    const { client } = startingClient([instance('A', false)], [instance('A', true)]);
    let calls = 0;
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: {
        listTargets: async () => [target('127.0.0.1:5555', 'TCP', true)],
        shell: async () => ({ stdout: 'true', stderr: '', code: 0 }),
      },
      pollMs: 0,
      now: () => (calls++ === 0 ? 1_000 : 61_000),
    });
    const result = await lifecycle.start('A');
    expect(result.waitedMs).toBe(60_000);
  });

  it('fails when the named instance does not exist', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('B', false)]),
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.start('A')).rejects.toThrow(/no emulator instance named "A".*B/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: FAIL — `start` is not a function.

- [ ] **Step 3: Implement**

A private `waitUntil<T>(phase: string, budgetMs: number, attempt: () => Promise<T | undefined>): Promise<T>`:

- Record `startedAt = this.now()`.
- Loop: `if (this.now() - startedAt >= budgetMs) throw ...`; `const value = await attempt()`; if `value !== undefined` return it; `await sleep(this.pollMs)`.
- The thrown message is `` `${phase} after ${budgetMs}ms. The emulator may be half-started; run \`ohos-perf emulator stop <name>\` to remove it.` ``.

`start(name, opts)`:

1. `const budget = opts?.timeoutMs ?? this.startTimeoutMs`.
2. `const instances = await this.client.listDetailed()`; find by exact `name`. Missing → throw `OhosPerfError` with `` `no emulator instance named "${name}". Instances: ${names.join(', ') || 'none'}` ``.
3. `const before = new Set((await this.hdc.listTargets()).map((t) => t.id))`.
4. If the instance is already running: take the connected TCP targets from that same call; exactly one → `target = tcp[0].id`, `alreadyRunning = true`; zero or more than one → throw with the §6.3 reason text from Task 4.
5. Otherwise: `await this.client.startInstance(name)`; `alreadyRunning = false`; then `await this.waitUntil(`the instance did not report isRunning`, budget, async () => ((await this.client.listDetailed()).find((i) => i.name === name)?.running === true ? true : undefined))`.
6. Then `target = await this.waitUntil('no new TCP target appeared', budget, async () => { const fresh = (await this.hdc.listTargets()).filter(isConnectedTcp).filter((t) => !before.has(t.id)); if (fresh.length > 1) throw new OhosPerfError(`two new TCP targets appeared after starting "${name}": ${fresh.map((t) => t.id).join(', ')}`); return fresh[0]?.id; })`.
7. Then `await this.waitUntil('the target was up but bootevent.boot.completed never became true', budget, async () => { try { const r = await this.hdc.shell(target, 'param get bootevent.boot.completed'); return r.stdout.trim() === 'true' ? true : undefined; } catch { return undefined; } })` — a shell failure during boot is "not ready yet", not an error.
8. Return `{ name, target, alreadyRunning, waitedMs: this.now() - startedAt }`, where `startedAt` is captured at the top of `start`, not inside `waitUntil`. The budget in steps 5–7 is `budget` measured from that same `startedAt`; pass a `deadline` instead of a per-phase budget so one timeout covers all three (spec §6.4).

To keep one budget across phases, `waitUntil` takes `deadline: number` (absolute) and throws when `this.now() >= deadline`. Step 4's `budget` is only used to compute `deadline = startedAt + budget`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/device/emulator.ts packages/core/test/emulator-lifecycle.test.ts
git commit -m "feat(core): start an emulator and wait through instance, target and boot"
```

---

### Task 6: `EmulatorLifecycle` — `stop` and `create`

**Files:**
- Modify: `packages/core/src/device/emulator.ts`
- Modify: `packages/core/src/errors.ts` (append one class)
- Test: `packages/core/test/emulator-lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces:
  - `interface EmulatorStopResult { name: string; wasRunning: boolean }`
  - `class EmulatorImageMissingError extends OhosPerfError { readonly installCommand: string }`, constructor `(message: string, installCommand: string, opts?: { cause?: unknown; code?: string })`.
  - `EmulatorLifecycle.stop(name: string, opts?: { timeoutMs?: number }): Promise<EmulatorStopResult>`
  - `EmulatorLifecycle.create(req: CreateEmulatorRequest): Promise<EmulatorInstance>`

- [ ] **Step 1: Write the failing test**

```ts
import { EmulatorImageMissingError } from '../src/device/emulator';

describe('EmulatorLifecycle.stop', () => {
  it('does nothing when the instance is not running', async () => {
    let stopped = false;
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([instance('A', false)]), stopInstance: async () => { stopped = true; } },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.stop('A')).resolves.toEqual({ name: 'A', wasRunning: false });
    expect(stopped).toBe(false);
  });

  it('polls until isRunning goes false, because -stop returns early', async () => {
    let calls = 0;
    const lifecycle = new EmulatorLifecycle({
      client: {
        listDetailed: async () => [instance('A', calls++ === 0)],
        imageList: async () => [],
        startInstance: async () => {},
        stopInstance: async () => {},
        createInstance: async () => {},
      },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.stop('A')).resolves.toEqual({ name: 'A', wasRunning: true });
    expect(calls).toBeGreaterThan(1);
  });

  it('names the measured fire-and-forget behaviour on timeout', async () => {
    let clock = 0;
    const lifecycle = new EmulatorLifecycle({
      client: fakeClient([instance('A', true)]),
      hdc: { listTargets: async () => [], shell: async () => { clock += 100; return { stdout: '', stderr: '', code: 0 }; } },
      pollMs: 0,
      stopTimeoutMs: 100,
      now: () => clock,
    });
    await expect(lifecycle.stop('A')).rejects.toThrow(/still reports isRunning: true/);
  });
});

describe('EmulatorLifecycle.create', () => {
  const images = [{ deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)', downloaded: true, softwareVersion: '6.1.0.126' }];

  function createClient(existing: EmulatorInstance[] = []) {
    const created: unknown[] = [];
    const after: EmulatorInstance[] = [];
    return {
      created,
      client: {
        listDetailed: async () => [...existing, ...after],
        imageList: async () => images,
        startInstance: async () => {},
        stopInstance: async () => {},
        createInstance: async (req: unknown) => { created.push(req); after.push(instance((req as { name: string }).name, false)); },
      },
    };
  }

  it('creates an instance and returns it as list() reports it', async () => {
    const { client, created } = createClient();
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    const result = await lifecycle.create({ name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)' });
    expect(created).toHaveLength(1);
    expect(result).toEqual({ name: 'SpecProbe', running: false, instancePath: '/instances/SpecProbe' });
  });

  it.each(['../x', 'a/b', 'a\\b', '', '.hidden'])('rejects the name %j before spawning', async (name) => {
    const { client, created } = createClient();
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({ name, deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)' }))
      .rejects.toThrow(/invalid emulator name/);
    expect(created).toHaveLength(0);
  });

  it('rejects a name that already exists before spawning', async () => {
    const { client, created } = createClient([instance('SpecProbe', false)]);
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({ name: 'SpecProbe', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)' }))
      .rejects.toThrow(/already exists/);
    expect(created).toHaveLength(0);
  });

  it('names the exact -install command when the image is missing', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([]), imageList: async () => [] },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    const error = await lifecycle
      .create({ name: 'X', deviceType: 'tablet', osVersion: 'HarmonyOS 6.1.1(24)' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmulatorImageMissingError);
    expect((error as EmulatorImageMissingError).installCommand)
      .toBe('-install -deviceType tablet -osVersion "HarmonyOS 6.1.1(24)"');
  });

  it.each([[1, 4], [6, 1], [4, 2048]])('rejects out-of-range memory/storage %i/%i', async (memoryGb, storageGb) => {
    const { client, created } = createClient();
    const lifecycle = new EmulatorLifecycle({
      client,
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({
      name: 'X', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)', memoryGb, storageGb,
    })).rejects.toThrow(/out of range/);
    expect(created).toHaveLength(0);
  });

  it('fails when the binary accepted the create but no instance appeared', async () => {
    const lifecycle = new EmulatorLifecycle({
      client: { ...fakeClient([]), imageList: async () => images },
      hdc: { listTargets: async () => [], shell: async () => ({ stdout: '', stderr: '', code: 0 }) },
      pollMs: 0,
    });
    await expect(lifecycle.create({ name: 'Ghost', deviceType: 'phone', osVersion: 'HarmonyOS 6.1.1(24)' }))
      .rejects.toThrow(/did not appear/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: FAIL — `stop`/`create` are not functions.

- [ ] **Step 3: Implement**

`EmulatorImageMissingError` in `errors.ts`:

```ts
export class EmulatorImageMissingError extends OhosPerfError {
  readonly installCommand: string;
  constructor(message: string, installCommand: string, opts: { cause?: unknown; code?: string } = {}) {
    super(message, opts);
    this.installCommand = installCommand;
  }
}
```

`stop(name, opts)`:
1. `const instances = await this.client.listDetailed()`; if no instance with that name → throw `OhosPerfError` naming it (same message shape as `start`).
2. If not running → return `{ name, wasRunning: false }` without calling `stopInstance`.
3. `await this.client.stopInstance(name)`.
4. `deadline = this.now() + (opts?.timeoutMs ?? this.stopTimeoutMs)`; `await this.waitUntil(...)` until `listDetailed()` shows `running === false`. The timeout message must contain `still reports isRunning: true` and explain that `-stop` returned success.
5. Return `{ name, wasRunning: true }`.

`create(req)` — validation strictly before `createInstance`:
1. Name: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.name)` **and** `!req.name.includes('..')`; otherwise throw `OhosPerfError` with message starting `invalid emulator name "…": ` plus the rule (`letters, digits, '.', '_' and '-' only, no '..'`).
2. `const existing = await this.client.listDetailed()`; if any `name` matches → throw with `already exists`.
3. `const images = await this.client.imageList()`; find `deviceType` and `osVersion` both equal. Missing → `EmulatorImageMissingError` with message naming the pair and the install command, and `installCommand = `-install -deviceType ${req.deviceType} -osVersion "${req.osVersion}"`` (no `Emulator.exe` prefix — the caller prepends the resolved path, which the message includes).
4. Ranges: `memoryGb` defined and outside `2..32` → throw `out of range: --memory must be 2-32 GB`; `storageGb` defined and outside `2..1023` → `out of range: --storage must be 2-1023 GB`.
5. `await this.client.createInstance(req)`.
6. `const after = await this.client.listDetailed()`; find by name. Absent → throw `OhosPerfError` with `` `the emulator reported success but "${req.name}" did not appear in \`-list -details\`` `` and the original output if available.
7. Return that instance.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit packages/core/test/emulator-lifecycle.test.ts`
Expected: PASS (29 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/device/emulator.ts packages/core/test/emulator-lifecycle.test.ts
git commit -m "feat(core): stop and create emulator instances with pre-spawn validation"
```

---

### Task 7: Publish the surface

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/types.test.ts`
- Test: `packages/core/test/types.test.ts`

**Interfaces:**
- Consumes: all exported symbols from Tasks 1–6.
- Produces: the published API — `EmulatorClient`, `EmulatorLifecycle`, `EmulatorNotFoundError`, `EmulatorCommandError`, `EmulatorImageMissingError`, and the types `EmulatorClientOptions`, `EmulatorLifecycleOptions`, `EmulatorBackend`, `EmulatorInstance`, `EmulatorImage`, `EmulatorStartResult`, `EmulatorStopResult`, `CreateEmulatorRequest`.

- [ ] **Step 1: Write the failing test**

Add to `VALUE_EXPORTS` in `packages/core/test/types.test.ts`, keeping alphabetical placement:

```ts
'EmulatorClient', 'EmulatorCommandError', 'EmulatorImageMissingError',
'EmulatorLifecycle', 'EmulatorNotFoundError',
```

Add to the typecheck snippet's import list in the same file:

```ts
import type {
  EmulatorClientOptions, EmulatorLifecycleOptions, EmulatorBackend, EmulatorInstance,
  EmulatorImage, EmulatorStartResult, EmulatorStopResult, CreateEmulatorRequest,
} from '@ohos-perf/core';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/types.test.ts`
Expected: FAIL — the value-key set differs from `VALUE_EXPORTS`.

- [ ] **Step 3: Implement**

In `packages/core/src/index.ts`, add the three errors to the existing `from './errors'` block and a new section after the device block:

```ts
export { EmulatorClient, EmulatorLifecycle } from './device/emulator';
export type {
  CreateEmulatorRequest,
  EmulatorBackend,
  EmulatorClientOptions,
  EmulatorImage,
  EmulatorInstance,
  EmulatorLifecycleOptions,
  EmulatorStartResult,
  EmulatorStopResult,
} from './device/emulator';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run build -w @ohos-perf/core && npx vitest run --project unit packages/core/test/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole core suite**

Run: `npm run test -w @ohos-perf/core -- --project unit 2>&1 | tail -20`
Expected: all pass; note the new total.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/types.test.ts
git commit -m "feat(core): export the emulator client and lifecycle surface"
```

---

### Task 8: CLI command group

**Files:**
- Modify: `packages/cli/src/commands.ts`
- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/src/deps.ts`
- Modify: `packages/cli/test/commands.test.ts`, `packages/cli/test/compare-cli.test.ts`, `packages/cli/test/program.test.ts`, `packages/cli/test/query-cli.test.ts` (each `deps()` factory gains the new required field)
- Test: `packages/cli/test/emulator-cli.test.ts`

**Interfaces:**
- Consumes: the core surface from Task 7; `parseDurationSeconds` from `./collect`; `safeMessage`, `json`, `CliResult` from `./commands`.
- Produces:
  - `interface EmulatorTargetOptions { emulatorPath?: string; instancePath?: string; imageRoot?: string }`
  - `interface EmulatorDeps { list(opts: EmulatorTargetOptions): Promise<EmulatorInstance[]>; start(name: string, opts: EmulatorTargetOptions & { timeoutMs?: number }): Promise<EmulatorStartResult>; stop(name: string, opts: EmulatorTargetOptions): Promise<EmulatorStopResult>; create(req: CreateEmulatorRequest & EmulatorTargetOptions): Promise<EmulatorInstance> }`
  - `CliDeps.emulator: EmulatorDeps`
  - `runEmulatorList`, `runEmulatorStart`, `runEmulatorStop`, `runEmulatorCreate` — each `(deps: CliDeps, …, opts: { json?: boolean }) => Promise<CliResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/emulator-cli.test.ts
import { describe, it, expect } from 'vitest';
import type { CliDeps } from '../src/commands';
import { buildProgram } from '../src/program';

const instances = [
  { name: 'ProbePhone', running: true, target: '127.0.0.1:5555', apiVersion: '24', osVersion: 'HarmonyOS 6.1.1(24)', instancePath: '/i/ProbePhone' },
  { name: 'SpecProbe', running: false, instancePath: '/i/SpecProbe', apiVersion: '24', osVersion: 'HarmonyOS 6.1.1(24)' },
];

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' }, collectors: [] }),
    query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false }),
    tools: () => [],
    compare: async () => { throw new Error('compare not stubbed'); },
    emulator: {
      list: async () => instances,
      start: async (name: string) => ({ name, target: '127.0.0.1:5555', alreadyRunning: false, waitedMs: 61_840 }),
      stop: async (name: string) => ({ name, wasRunning: true }),
      create: async (req) => ({ name: req.name, running: false, instancePath: `/i/${req.name}` }),
    },
    ...overrides,
  };
}

async function parse(argv: string[], overrides: Partial<CliDeps> = {}) {
  const emitted: { stdout: string; stderr: string; exitCode: number }[] = [];
  const program = buildProgram(deps(overrides), {
    writeOut: () => {},
    writeErr: () => {},
    emit: (r) => emitted.push(r),
  }, { exitOverride: true });
  await program.parseAsync(['node', 'ohos-perf', ...argv]);
  return emitted;
}

describe('emulator list', () => {
  it('renders a table with the target and a dash for a missing one', async () => {
    const [r] = await parse(['emulator', 'list']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('NAME');
    expect(r.stdout).toContain('ProbePhone  yes      127.0.0.1:5555');
    expect(r.stdout).toContain('SpecProbe   no       —');
  });

  it('prints instances as JSON under an `instances` key', async () => {
    const [r] = await parse(['emulator', 'list', '--json']);
    expect(JSON.parse(r.stdout)).toEqual({ instances });
  });

  it('says so when there are no instances', async () => {
    const [r] = await parse(['emulator', 'list'], {
      emulator: { ...deps().emulator, list: async () => [] },
    });
    expect(r.stdout).toBe('no emulator instances\n');
  });
});

describe('emulator start', () => {
  it('reports the target and the boot time in seconds', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone']);
    expect(r.stdout).toBe('ProbePhone started on 127.0.0.1:5555 (booted in 62s)\n');
  });

  it('passes --timeout through as milliseconds', async () => {
    let seen: number | undefined;
    const [r] = await parse(['emulator', 'start', 'ProbePhone', '--timeout', '30'], {
      emulator: {
        ...deps().emulator,
        start: async (name, opts) => { seen = opts.timeoutMs; return { name, target: 't', alreadyRunning: false, waitedMs: 0 }; },
      },
    });
    expect(seen).toBe(30_000);
    expect(r.exitCode).toBe(0);
  });

  it('rejects a non-positive timeout instead of polling with a zero budget', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone', '--timeout', '0']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--timeout must be greater than 0/);
  });

  it('says "was already running" without a boot time', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone'], {
      emulator: {
        ...deps().emulator,
        start: async (name) => ({ name, target: '127.0.0.1:5555', alreadyRunning: true, waitedMs: 120 }),
      },
    });
    expect(r.stdout).toBe('ProbePhone was already running on 127.0.0.1:5555\n');
  });

  it('exits 1 with the message on stderr when the wait times out', async () => {
    const [r] = await parse(['emulator', 'start', 'ProbePhone'], {
      emulator: { ...deps().emulator, start: async () => { throw new Error('no new TCP target appeared after 100ms'); } },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('no new TCP target appeared after 100ms\n');
  });
});

describe('emulator stop', () => {
  it('reports a real stop', async () => {
    const [r] = await parse(['emulator', 'stop', 'ProbePhone']);
    expect(r.stdout).toBe('ProbePhone stopped\n');
  });

  it('reports a no-op honestly', async () => {
    const [r] = await parse(['emulator', 'stop', 'ProbePhone'], {
      emulator: { ...deps().emulator, stop: async (name) => ({ name, wasRunning: false }) },
    });
    expect(r.stdout).toBe('ProbePhone was not running\n');
  });
});

describe('emulator create', () => {
  it('requires --device-type and --os-version', async () => {
    const [r] = await parse(['emulator', 'create', 'X']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--device-type and --os-version are required/);
  });

  it('reports the created instance and its path', async () => {
    const [r] = await parse([
      'emulator', 'create', 'SpecProbe', '--device-type', 'phone', '--os-version', 'HarmonyOS 6.1.1(24)',
    ]);
    expect(r.stdout).toBe('Created SpecProbe (phone, HarmonyOS 6.1.1(24)) at /i/SpecProbe\n');
  });

  it('forwards --memory and --storage as numbers', async () => {
    let seen: { memoryGb?: number; storageGb?: number } = {};
    await parse([
      'emulator', 'create', 'X', '--device-type', 'phone', '--os-version', 'V',
      '--memory', '6', '--storage', '8',
    ], {
      emulator: { ...deps().emulator, create: async (req) => { seen = req; return { name: req.name, running: false, instancePath: '/i/X' }; } },
    });
    expect(seen).toMatchObject({ memoryGb: 6, storageGb: 8 });
  });

  it('passes --instance-path and --emulator to the deps', async () => {
    let seen: { instancePath?: string; emulatorPath?: string } = {};
    await parse([
      'emulator', 'list', '--instance-path', 'C:/Users/me/DevEco Studio/instances', '--emulator', 'C:/x/Emulator.exe',
    ], {
      emulator: { ...deps().emulator, list: async (opts) => { seen = opts; return []; } },
    });
    expect(seen).toEqual({
      instancePath: 'C:/Users/me/DevEco Studio/instances',
      emulatorPath: 'C:/x/Emulator.exe',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/emulator-cli.test.ts`
Expected: FAIL — `emulator` is not a known command; `CliDeps` has no `emulator` field (typecheck error in the test file).

- [ ] **Step 3: Implement the pure layer**

In `commands.ts`, add the two interfaces, the `CliDeps.emulator` field, and four runners. Rendering rules:

- `runEmulatorList`: `--json` → `json({ instances })`; empty → `'no emulator instances\n'`; otherwise a header `NAME  RUNNING  TARGET  API  IMAGE` with columns padded to the max width over the rows (the same approach `formatCapabilities` uses), values `yes`/`no`, `target ?? '—'`, `apiVersion ?? '—'`, `osVersion ?? '—'`.
- `runEmulatorStart`: `--json` → `json(result)`; `alreadyRunning` → `` `${name} was already running on ${target}\n` ``; else `` `${name} started on ${target} (booted in ${Math.round(waitedMs / 1000)}s)\n` ``.
- `runEmulatorStop`: `--json` → `json(result)`; else `` `${name} stopped\n` `` or `` `${name} was not running\n` ``.
- `runEmulatorCreate`: `--json` → `json(instance)`; else `` `Created ${name} (${deviceType}, ${osVersion}) at ${instancePath}\n` ``.

Every runner wraps its `deps.emulator.*` call in `try`/`catch` and returns `{ stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 }` — the same failure contract as `runAnalyze`.

- [ ] **Step 4: Implement the commander wiring**

In `program.ts`, one parent command with four subcommands. Declare `--instance-path <dir>`, `--image-root <dir>`, `--emulator <path>` on **each** subcommand through a local helper `withEmulatorTargets(cmd: Command): Command` that adds all three; this keeps `ohos-perf emulator list --instance-path X` working without depending on commander's parent-option lookup.

- `list`: `.option('--json', …)` → `runEmulatorList(deps, targets(opts), opts)`.
- `start <name>`: adds `--timeout <seconds>` and `--json`. Parse with `parseDurationSeconds`; a result `<= 0` emits `` { stdout: '', stderr: 'invalid --timeout: --timeout must be greater than 0\n', exitCode: 1 } `` and returns **before** calling deps.
- `stop <name>`: `--json` only.
- `create <name>`: requires `--device-type <type>` and `--os-version <version>` (declare with `.requiredOption`); adds `--screen-profile <model>`, `--memory <GB>`, `--storage <GB>`, `--json`. `--memory`/`--storage` parse with `Number.parseInt(v, 10)` and a non-finite result emits an exit-1 usage error rather than `NaN` reaching core.

A local `targets(opts)` helper returns `{ ...(opts.instancePath ? { instancePath: opts.instancePath } : {}), ...(opts.imageRoot ? { imageRoot: opts.imageRoot } : {}), ...(opts.emulator ? { emulatorPath: opts.emulator } : {}) }`.

- [ ] **Step 5: Wire `realDeps` and fix the four test factories**

In `deps.ts`, inside `realDeps`, build the emulator deps lazily per call so `realDeps()` performs no IO:

```ts
const emulator: EmulatorDeps = {
  list: (o) => new EmulatorLifecycle({ client: emulatorClient(o) }).list(),
  start: (name, o) => new EmulatorLifecycle({ client: emulatorClient(o) }).start(name, o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  stop: (name, o) => new EmulatorLifecycle({ client: emulatorClient(o) }).stop(name),
  create: (req) => new EmulatorLifecycle({ client: emulatorClient(req) }).create(req),
};
```

with `const emulatorClient = (o: EmulatorTargetOptions) => new EmulatorClient({ ...(o.emulatorPath ? { emulatorPath: o.emulatorPath } : {}), ...(o.instancePath ? { instancePath: o.instancePath } : {}), ...(o.imageRoot ? { imageRoot: o.imageRoot } : {}) });`

Then add `emulator` to the returned object. The `CliDeps` type makes this a compile error until done.

Add to each of the four test factories (`commands.test.ts:30`, `compare-cli.test.ts:12`, `program.test.ts:12`, `query-cli.test.ts:8`):

```ts
emulator: {
  list: async () => [],
  start: async () => { throw new Error('emulator not stubbed'); },
  stop: async () => { throw new Error('emulator not stubbed'); },
  create: async () => { throw new Error('emulator not stubbed'); },
},
```

- [ ] **Step 6: Run the CLI suite**

Run: `npm run test -w @ohos-perf/cli -- --project unit 2>&1 | tail -20`
Expected: all pass, including the 14 new emulator tests.

- [ ] **Step 7: Typecheck both packages**

Run: `npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(cli): add the emulator list, start, stop and create commands"
```

---

### Task 9: One-time real lifecycle check, then docs

**Files:**
- Modify: `README.md`
- Modify: `site/index.html`, `site/main.js`
- Modify: `skill/ohos-perf/SKILL.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the CLI from Task 8.
- Produces: documentation; no code.

- [ ] **Step 1: Run the real chain once and record it**

Build first (`npm run build`), then run against this machine's `ProbePhone`:

```bash
node packages/cli/dist/index.js emulator list
node packages/cli/dist/index.js emulator start ProbePhone --timeout 300
node packages/cli/dist/index.js emulator list
node packages/cli/dist/index.js emulator stop ProbePhone
node packages/cli/dist/index.js emulator list
```

Expected: `list` shows the instance from `.emu_config`'s redirected root (not `%LOCALAPPDATA%`); `start` prints a `127.0.0.1:5555` target; the second `list` shows `yes` with that target; `stop` prints `stopped`; the last `list` shows `no` with `—`. If any step disagrees with the spec's measured facts, stop and report the divergence rather than editing the docs to match.

Also run `create` against a throwaway name and `stop`/delete it, to confirm the post-create verification path against the real binary. Record the exact commands and output in the task report.

- [ ] **Step 2: Update the README**

Add an `## Emulators` section after `## Quickstart`:

- the four commands with one example each;
- the `--target` handoff: `` `ohos-perf emulator list --json` prints a `target` you can pass to `collect --target` ``;
- that `start` waits for `bootevent.boot.completed` and takes `--timeout`;
- that `create` never downloads an image and prints the `-install` command instead;
- the determinism carve-out from spec §7, stated in one sentence;
- the path discovery order (explicit flag → env var → `.emu_config` → default).

Update the Roadmap table's P7 row to `shipped in <next version>` **only if** the release step is part of this change; otherwise leave it `next` and note the commands exist. Update the implemented-today list to include the four commands, and the architecture line's L1 row to `device model · capability probe · matrix · emulator lifecycle`.

- [ ] **Step 3: Update the site**

`site/index.html`: add the four commands to the CLI list block and a roadmap card for P7 in both locales (the file carries `data-en`/`data-zh` pairs). `site/main.js`: extend the Chinese meta description with 模拟器生命周期. Keep the stat tiles honest — do not bump the test count until the final suite run gives the real number.

- [ ] **Step 4: Update the skill**

`skill/ohos-perf/SKILL.md`: add a step before `collect` — when `doctor` reports no attached device, run `ohos-perf emulator list --json`, then `ohos-perf emulator start <name> --json`, and pass its `target` to `collect --target`.

- [ ] **Step 5: Update the changelog**

`CHANGELOG.md`: an `## Unreleased` section with `### Added` naming the four commands, the core `EmulatorClient`/`EmulatorLifecycle` exports, and the "no image download" rule.

- [ ] **Step 6: Run the full suite**

Run: `npm test 2>&1 | tail -30`
Expected: green, with the total recorded for the README/site numbers.

- [ ] **Step 7: Commit**

```bash
git add README.md site skill CHANGELOG.md
git commit -m "docs: document the emulator lifecycle commands"
```

---

## Self-review notes

**Spec coverage.** §4 architecture → Tasks 1–6. §5 interfaces → Tasks 1–8 (every type named there is produced by a task and exported in Task 7). §6.1 discovery → Task 1 (binary) and Task 2 (`-path`/`-imageRoot` args). §6.2 failure detection → Task 2. §6.3 list/attribution → Task 4. §6.4 start → Task 5. §6.5 stop → Task 6. §6.6 create → Task 6. §7 CLI → Task 8. §8 errors → Tasks 1, 2, 6. §9 platform → Task 1's `defaultCommonPaths`. §10 testing → the three test files. §11 risks → Review Focus and Task 2's warning test. §12 documentation → Task 9.

**One deviation from the spec, recorded here.** Spec §5 writes `EmulatorLifecycleOptions.client?: EmulatorClient`. This plan uses a structural `EmulatorBackend` instead, so lifecycle tests pass a plain object and need no subclass with five overrides. `EmulatorClient` satisfies it structurally, so no caller changes; the interface is exported because `EmulatorLifecycleOptions` is public. Cost if wrong: one extra exported type name.

**Type consistency.** `EmulatorInstance` (Task 2) is used unchanged by Tasks 4–8. `isConnectedTcp` is defined once, in Task 4, and reused by Task 5. `waitUntil` is defined once, in Task 5, and reused by Task 6 — it takes an absolute `deadline`, so the stop path passes `this.now() + budget`. `targets()` is defined once, in Task 8, and used by all four runners.

**Proportion.** The plan specifies signatures, argv shapes and assertions. The two algorithms the tests do not fully determine — the three-phase wait with one shared deadline (Task 5) and the pre-spawn validation order (Task 6) — carry a short ordered description instead of a transcribed body.
