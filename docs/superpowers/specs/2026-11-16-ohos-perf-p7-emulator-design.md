# P7 — Emulator Lifecycle Commands (`ohos-perf emulator list|start|stop|create`)

**Status:** design, awaiting review
**Date:** 2026-11-16
**Supersedes:** nothing. Extends `design/2026-11-14-ohos-perf-core-design.md` §3.3
(which already reserves `device/emulator.ts`) and §8 (which already lists the
command group).

## 1. Purpose

Let an agent (or a person) bring a HarmonyOS emulator from "exists on this
machine" to "a target id that `ohos-perf collect --target <id>` accepts",
without opening DevEco Studio and without hand-editing emulator config files.

Today the package can only attach to a device that is already running. On a
machine with no real device attached, `doctor` and `caps` fail with
`NO_CONNECTED_TARGETS`, and there is nothing the caller can do about it from
inside the package. P7 closes that loop.

The four commands are exactly the ones the design doc and the README roadmap
name:

```
ohos-perf emulator list   [--json]
ohos-perf emulator start  <name> [--timeout <seconds>] [--json]
ohos-perf emulator stop   <name> [--json]
ohos-perf emulator create <name> --device-type <type> --os-version <version>
                          [--screen-profile <model>] [--memory <GB>] [--storage <GB>] [--json]
```

## 2. Non-goals

- **No image download.** `create` fails with a copy-pasteable
  `Emulator.exe -install …` command when the image is missing. Downloading
  images is a multi-GB network side effect with licence and proxy handling; it
  does not belong in a package whose stated contract is "no hidden work".
- **No `delete`, no `install`, no `imageList` command.** `delete` is
  destructive and no roadmap item asks for it. `-imageList` is used internally
  by `create` validation only.
- **No config-file writing.** The package never authors `config.ini`,
  `hardware-qemu.ini` or `lists.json`; `Emulator.exe` owns that format.
- **No emulator running on non-Windows hosts is claimed.** See §9.

## 3. Measured facts

Measured on 2026-11-16 against DevEco Studio 6.1.1.280 / HarmonyOS Emulator
6.1.1.200 on Windows 11. Every task in the plan depends on these values
verbatim; do not re-derive them by eye.

| Fact | Measured value |
| --- | --- |
| Binary | `D:\Application\DevEco Studio\tools\emulator\Emulator.exe` |
| `-version` output | `HarmonyOS Emulator :6.1.1.200` |
| Exit code on success | `0` |
| Exit code on **failure** | `0` — `Unable to start the emulator`, `Emulator: Unknown option 'bogus'.`, `Emulator: Missing value after '-create'.` all exit 0 |
| `-list` (no `-details`) | one instance name per line; `[Empty]` when there are none |
| `-list -details` | a JSON array, one object per instance; `isRunning` is the **string** `"true"`/`"false"` |
| `-list -details -path <dir>` | honoured; lists only instances under `<dir>` |
| `-start <name>` | returns in well under a second and **does not** wait for boot; the instance keeps running after the process exits |
| `-start` success output | may contain unrelated warnings (`Windows Hypervisor Platform accelerator is operational`, `GLib: g_hash_table_remove_all: assertion … failed`, `[dshow …] Could not enumerate video devices`) |
| `-start` on an unknown name | `Unable to start the emulator`, **no trailing newline** |
| Boot completion on the guest | `hdc -t <target> shell "param get bootevent.boot.completed"` → `true` |
| `-stop <name>` | returns in ~0.14 s, prints `Stop emulator <name> successfully`, but `isRunning` stays `"true"` for a few seconds |
| Instance identity on the guest | `const.product.name` = `emulator`, `const.product.software.version` = `emulator 6.1.0.126(SP1DEVC00E120R4P11)` — the existing `probe.ts` emulator predicate already matches |
| `hdc` target for a booted emulator | `127.0.0.1:5555  TCP  Connected`, id usable as `--target` |
| `-create` with `-instancePath`/`-imageRoot` | works; instance lands at `<instancePath>/<name>/` |
| `-create` with an unknown `-deviceType` or `-osVersion` | **silent no-op, exit 0, nothing created** |
| `-create` for a name that already exists | **silent no-op, exit 0, nothing created** |
| `-imageList -downloaded true` | JSON array with `deviceType`, `osVersion` (e.g. `HarmonyOS 6.1.1(24)`), `downloaded`, `SoftWareVersion`, `releaseType`, `upgradable` |
| `-config` | produced no output on this machine — do not rely on it |
| `.emu_config` | `%LOCALAPPDATA%\Huawei\Emulator6.1\.emu_config`, `key:value` lines, no spaces |
| `.emu_config` contents here | `imagePath:E:/HarmonyRuntime/LocalAppData/Huawei/Sdk`, `emuPath:E:/HarmonyRuntime/LocalAppData/Huawei/Emulator/deployed` |
| Default instance root | `%LOCALAPPDATA%\Huawei\Emulator\deployed` |
| Boot wall-clock | 34 s (`PathProbe`, warm cache) to 62 s (`ProbePhone`, cold) |

Two facts that shape the design more than the rest:

1. **The exit code carries no information.** Success is proven by re-reading
   state, never by `$?`. This is the same "failure is never success" rule the
   package already applies to `hdc` and `trace_streamer`.
2. **`-start` and `-stop` are fire-and-forget.** Both must be followed by
   polling. `-stop` returning "successfully" while `isRunning` is still `"true"`
   is measured behaviour, not a race to paper over.

## 4. Architecture

Two layers in one new core module, `packages/core/src/device/emulator.ts`,
mirroring the `Hdc` / `Device` split:

```
EmulatorClient     spawn + parse      — the only thing that runs Emulator.exe
EmulatorLifecycle  state + waiting    — takes a client and an Hdc
```

The split exists because the hard parts are different: the client must survive
an exit code that lies and three output formats (`text`, `JSON`, `[Empty]`);
the lifecycle must prove state transitions using a second tool (`hdc`). A
single class would put both in one file and make the polling logic untestable
without spawning.

`EmulatorNotFoundError`, `EmulatorCommandError` and `EmulatorImageMissingError`
all extend `OhosPerfError` from `packages/core/src/errors.ts`, which already
exports `HdcNotFoundError` and `StreamerNotFoundError` in the same shape. The
three new classes live beside those two, not in `emulator.ts`, so the error
surface stays in one file.

```
packages/core/src/errors.ts        (three new classes)
packages/core/src/device/emulator.ts
  EmulatorClient          (spawn, resolvePath, version, listDetailed, imageList)
  EmulatorLifecycle       (list, start, stop, create)
  EmulatorInstance        EmulatorImage        EmulatorStartResult    EmulatorStopResult
```

The CLI (`packages/cli/src/program.ts`, `commands.ts`) adds one command group
that parses arguments and renders one of two forms. No lifecycle logic in the
CLI.

## 5. Interfaces

```ts
/** A value the caller may pass as `--target` to `collect`/`caps`/`doctor`. */
export interface EmulatorInstance {
  readonly name: string;
  readonly running: boolean;
  /** `os.apiVersion`, e.g. `"24"`. Absent when the instance does not report it. */
  readonly apiVersion?: string;
  /** `imageSubPath`, e.g. `system-image/HarmonyOS-6.1.1/phone_all_x86/`. */
  readonly imageDir?: string;
  /** Absolute instance directory, as `Emulator.exe` reports it. */
  readonly instancePath: string;
  readonly uuid?: string;
  /** `os.osVersion`, e.g. `HarmonyOS 6.1.1(24)`. */
  readonly osVersion?: string;
  /**
   * The hdc target id, present only when it can be attributed unambiguously:
   * exactly one instance is running and exactly one connected TCP target
   * exists. See §6.3.
   */
  readonly target?: string;
  /** Why `target` is absent, when it is absent for a reason other than "not running". */
  readonly targetReason?: string;
}

export interface EmulatorImage {
  readonly deviceType: string;
  /** `osVersion`, e.g. `"HarmonyOS 6.1.1(24)"`. */
  readonly osVersion: string;
  readonly downloaded: boolean;
  /** `SoftWareVersion`, e.g. `"6.1.0.126"`. */
  readonly softwareVersion: string;
  readonly releaseType?: string;
}

export interface EmulatorStartResult {
  readonly name: string;
  readonly target: string;
  /** True when the instance was already running before this call. */
  readonly alreadyRunning: boolean;
  /** Wall-clock milliseconds this call spent waiting for boot. */
  readonly waitedMs: number;
}

export interface EmulatorStopResult {
  readonly name: string;
  /** False when the instance was not running; nothing was sent to `-stop`. */
  readonly wasRunning: boolean;
}

export interface CreateEmulatorRequest {
  readonly name: string;
  readonly deviceType: string;
  readonly osVersion: string;
  readonly screenProfile?: string;
  readonly memoryGb?: number;
  readonly storageGb?: number;
}
```

```ts
export interface EmulatorClientOptions {
  /** Explicit `Emulator.exe`; checked first. */
  emulatorPath?: string;
  env?: Env;
  /** Override the built-in candidate list. Tests pass `[]`. */
  commonPaths?: string[];
  /** `-instancePath` for every command that accepts it. */
  instancePath?: string;
  /** `-imageRoot` for every command that accepts it. */
  imageRoot?: string;
}

export class EmulatorClient {
  resolvePath(): Promise<string>;
  version(): Promise<string>;
  /** `-list -details`, parsed. `[]` for `[Empty]`. */
  listDetailed(): Promise<EmulatorInstance[]>;
  /** `-imageList -downloaded true`, parsed. */
  imageList(): Promise<EmulatorImage[]>;
  /** Raw `-start` / `-stop` / `-create`; throws on a recognised failure line. */
  startInstance(name: string): Promise<void>;
  stopInstance(name: string): Promise<void>;
  createInstance(req: CreateEmulatorRequest): Promise<void>;
}
```

```ts
export interface EmulatorLifecycleOptions {
  client?: EmulatorClient;
  hdc?: Hdc;
  /** Total budget for `start`, across all three phases. Default 180_000. */
  startTimeoutMs?: number;
  /** Total budget for `stop`. Default 30_000. */
  stopTimeoutMs?: number;
  /** Poll interval for every wait. Default 1_000. */
  pollMs?: number;
  /** Injection point for tests; production leaves it unset. */
  now?: () => number;
}

export class EmulatorLifecycle {
  list(): Promise<EmulatorInstance[]>;
  start(name: string, opts?: { timeoutMs?: number }): Promise<EmulatorStartResult>;
  stop(name: string, opts?: { timeoutMs?: number }): Promise<EmulatorStopResult>;
  create(req: CreateEmulatorRequest): Promise<EmulatorInstance>;
}
```

`EmulatorInstance` is also what `-list -details` produces; the lifecycle adds
`target` / `targetReason` on top. Both layers return the same shape so the CLI
never translates between two models.

## 6. Behaviour

### 6.1 Path discovery

`EmulatorClient.resolvePath()` follows the existing `Hdc`/`Streamer` order:

1. `options.emulatorPath`
2. `OHOS_PERF_EMULATOR`
3. Common installs: `$DEVECO_SDK_HOME/tools/emulator/Emulator.exe`,
   `D:\Application\DevEco Studio\tools\emulator\Emulator.exe`,
   `C:\Program Files\Huawei\DevEco Studio\tools\emulator\Emulator.exe`
4. Each `PATH` entry joined with `Emulator.exe`

All candidates are checked with `existsSync`, first hit wins, and a miss throws
`EmulatorNotFoundError(searchedPaths)` whose message lists every candidate in
order — the same contract `HdcNotFoundError` has, so `doctor`-style debugging
works identically.

**Instance root and image root** resolve independently of the binary:

1. `options.instancePath` / `options.imageRoot`
2. `OHOS_PERF_EMULATOR_INSTANCE` / `OHOS_PERF_EMULATOR_ROOT`
3. `.emu_config`: read `emuPath` for the instance root and `imagePath` for the
   image root
4. `%LOCALAPPDATA%\Huawei\Emulator\deployed` and `%LOCALAPPDATA%\Huawei\Sdk`

`.emu_config` candidates are every
`%LOCALAPPDATA%\Huawei\Emulator*\.emu_config`, sorted by directory name
**descending** (`Emulator6.1` before `Emulator`), first file that parses wins.
Sorting by name keeps the choice deterministic across machines; sorting by
mtime would not. A `.emu_config` that is unreadable, or lacks both keys, is
skipped silently rather than aborting discovery — a broken config must not make
`list` unusable.

When a root is resolved, it is passed as `-instancePath` / `-imageRoot` to
every command that accepts it, and as `-path` to `-list -details`. This is
required on this machine: the real instance root is
`E:\HarmonyRuntime\LocalAppData\Huawei\Emulator\deployed`, so the default
`%LOCALAPPDATA%` path lists nothing.

### 6.2 Failure detection

`Emulator.exe` exits 0 for every failure measured. `EmulatorClient` therefore
classifies the captured stdout+stderr, line by line, after trimming each line:

- a line matching `/^Emulator: /` or `/^Unable to /` is a failure; the command
  throws `EmulatorCommandError` carrying the raw output and the offending line.
- `-list -details` output `[Empty]` is success with zero instances.
- anything else is success — including the warning lines in §3.

This rule is deliberately structural (`^Emulator: `, `^Unable to `) rather than
a list of known sentences, because the binary prints its own name as a prefix
for argument errors and `Unable to …` for operational ones, and a future
message of either shape should fail loudly rather than be parsed as success.

### 6.3 `list`

`list()` returns `-list -details` parsed, sorted by `name` ascending, with
`target` attached by this rule:

- no instance is running → no `target`, no `targetReason`.
- exactly one instance is running **and** `hdc.listTargets()` reports exactly
  one connected TCP target → that target id.
- otherwise → no `target`, and `targetReason` explains which condition failed
  (`"two emulators are running, so a target cannot be attributed"` /
  `"no connected TCP target was found"`).

A running instance whose port is unknown (`hw.hdc.port=notset` in `config.ini`,
which is the default) cannot be mapped to a target by config, and the port has
been observed to differ between sessions for the same instance. Guessing a port
would produce a plausible-looking wrong answer, so the rule is: attribute only
when there is exactly one candidate on each side.

### 6.4 `start`

```
1. listDetailed()  → the named instance must exist, else an error naming it
2. snapshot hdc.listTargets()
3. already running?
     → the target must already be in the snapshot; skip to step 6 with
       alreadyRunning = true. If the snapshot has no connected TCP target,
       fail with the §6.3 attribution reason rather than starting a second
       emulator to manufacture one.
4. otherwise spawn `-start <name>`; ignore its exit code
5. phase "instance": poll listDetailed() until isRunning === true
6. phase "target":   poll hdc.listTargets() for a Connected TCP target that
                     was not in the step-2 snapshot; a running instance that
                     was already up takes its target from the snapshot instead
7. phase "boot":     poll `hdc -t <target> shell "param get bootevent.boot.completed"`
                     until stdout trims to "true"
8. return { name, target, alreadyRunning, waitedMs }
```

- **Idempotent.** A second `start` on a running instance never spawns a second
  emulator; it waits for boot and returns `alreadyRunning: true`. Agents retry,
  and a retry must be safe.
- **One budget for all three phases**, default 180 s (measured worst case 62 s).
  `--timeout <seconds>` overrides it per call.
- **Timeout names the phase that stalled** — `"the instance did not report
  isRunning after 180s"`, `"no new TCP target appeared after 180s"`, `"the
  target was up but bootevent.boot.completed never became true"` — because "it
  timed out" leaves the caller unable to tell a slow boot from a broken start.
- **A timeout does not stop the emulator.** A half-booted instance is evidence
  of what went wrong; stopping it would destroy that. The error message tells
  the caller to run `ohos-perf emulator stop <name>` if they want it gone.
- **A second new TCP target is an error**, not a coin flip: if two new targets
  appear, throw and name both.

### 6.5 `stop`

```
1. listDetailed() → not running? return { wasRunning: false } without spawning
2. spawn `-stop <name>`
3. poll listDetailed() until isRunning === false
4. return { wasRunning: true }
```

Timeout default 30 s. On timeout, the message states that `-stop` reported
success but the instance still reports `isRunning: true` — the measured
fire-and-forget behaviour, not a transport failure.

### 6.6 `create`

Validation happens **before** spawning, because a rejected `-create` is a
silent no-op:

1. **Name** must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` and must not
   contain `..`. The name becomes a directory under the instance root, so a
   name like `../../x` would write outside it. Reject with a message naming the
   rule.
2. **The instance must not already exist.** `Emulator.exe` silently ignores a
   duplicate create; failing fast tells the caller why nothing happened.
3. **The image must be downloaded.** `imageList()` must contain a row with the
   same `deviceType` and `osVersion`. Otherwise throw
   `EmulatorImageMissingError` whose message is the exact command to run:
   `Emulator.exe -install -deviceType <type> -osVersion "<version>"`.
4. **Numeric ranges** from `-help`: `memoryGb` 2–32, `storageGb` 2–1023.
5. Spawn `-create <name> -deviceType … -osVersion … [-screenProfile …]
   [-memory …] [-storage …] [-instancePath …] [-imageRoot …]`.
6. **Verify** with `listDetailed()` that the instance now exists. Exit code 0
   plus empty output is the measured shape of every failed create, so the
   re-read is the only proof. On a miss, throw `EmulatorCommandError` with the
   captured output.

Returns the created `EmulatorInstance` as `list()` reports it.

## 7. CLI surface

```
$ ohos-perf emulator list
NAME        RUNNING  TARGET           API  IMAGE
ProbePhone  yes      127.0.0.1:5555   24   HarmonyOS 6.1.1(24)
SpecProbe   no       —                24   HarmonyOS 6.1.1(24)

$ ohos-perf emulator start ProbePhone
ProbePhone started on 127.0.0.1:5555 (booted in 62s)

$ ohos-perf emulator stop ProbePhone
ProbePhone stopped

$ ohos-perf emulator create SpecProbe --device-type phone --os-version "HarmonyOS 6.1.1(24)"
Created SpecProbe (phone, HarmonyOS 6.1.1(24)) at E:/…/deployed/SpecProbe
```

`--json` shapes, stable key order, `list` sorted by name:

```json
{ "instances": [ { "name": "ProbePhone", "running": true, "target": "127.0.0.1:5555", … } ] }
{ "name": "ProbePhone", "target": "127.0.0.1:5555", "alreadyRunning": false, "waitedMs": 61840 }
{ "name": "ProbePhone", "wasRunning": true }
{ "name": "SpecProbe", "running": false, "instancePath": "E:/…/SpecProbe", … }
```

Global options accepted by every subcommand: `--instance-path <dir>`,
`--image-root <dir>`, `--emulator <path>`. They map to the options in §5.

**Determinism carve-out.** The D5 byte-identical contract governs analysis
output, which is a function of a trace. Lifecycle commands report wall-clock
values (`waitedMs`) and machine state; `--json` keeps key order and array order
stable, and that is the whole promise. This is stated in the README rather than
left implicit.

All failures exit 1 through the existing `safeMessage` path; a missing binary is
`EmulatorNotFoundError` with the candidate list, exactly like a missing `hdc`.

## 8. Errors

| Situation | Behaviour |
| --- | --- |
| `Emulator.exe` not found | `EmulatorNotFoundError`, lists every candidate in order |
| `-start`/`-stop`/`-create` prints `Emulator: …` or `Unable to …` | `EmulatorCommandError`, carries raw output and the offending line |
| `-create` rejected silently | `EmulatorCommandError` after the post-create `listDetailed()` shows no instance |
| Named instance absent | `EmulatorCommandError` naming the instance and the instances that do exist |
| Image not downloaded | `EmulatorImageMissingError` with the exact `-install` command |
| Boot never completes | `EmulatorCommandError` naming the phase, with `stop` advice |
| Two new targets after `start` | `EmulatorCommandError` naming both |
| `.emu_config` unreadable | skipped silently; discovery falls through to the default root |
| No connected TCP target for `list` | not an error — `target` is omitted with `targetReason` |

## 9. Platform

`Emulator.exe` ships with DevEco Studio on Windows; the macOS distribution ships
an equivalent binary at a path this design has **not** measured. So:

- On `win32`, the candidate list in §6.1 applies.
- On other platforms, only `emulatorPath`, `OHOS_PERF_EMULATOR` and `PATH` are
  searched. No macOS/Linux path is invented.
- If nothing is found, `EmulatorNotFoundError` says the platform was not
  searched by default — an honest "not supported here yet" rather than a
  guessed path that fails later.

## 10. Testing

**Unit (default `unit` project, no emulator, no GUI):**

- `packages/core/test/emulator-client.test.ts` — `StubEmulator extends
  EmulatorClient` overriding the protected spawn seam (the pattern
  `test/hdc.test.ts` and `test/streamer.test.ts` already use). Covers: search
  order and the error's candidate list; `.emu_config` redirect (instance root
  and image root); name-sorted `.emu_config` preference; unparseable config
  skipped; `-list -details` JSON with string `isRunning`; `[Empty]`; each
  failure line; warnings that must **not** count as failure; `-version`
  parsing; `-imageList` parsing; `-path`/`-instancePath`/`-imageRoot` argument
  construction.
- `packages/core/test/emulator-lifecycle.test.ts` — stub client + fake `Hdc`
  (the `test/device.test.ts` pattern). Covers: `start` idempotence (no second
  spawn); the three phases in order; a timeout in each phase producing its own
  message; two new targets rejected; `stop` no-op and polling; `create` name
  traversal rejected before spawn; duplicate instance rejected before spawn;
  missing image produces the `-install` command; post-create verification
  failure surfaces as an error; `list` target attribution (0, 1 and 2 running
  instances).
- `packages/cli/test/emulator-cli.test.ts` — `buildProgram` with injected deps:
  human and `--json` output for all four commands, `--timeout` plumbing, exit 1
  on error.

**Fixtures** live in `packages/core/test/fixtures/emulator/`, captured from the
real binary during this design session: `list-details.json`, `list-empty.txt`,
`list-text.txt`, `image-list.json`, `version.txt`, `start-failure.txt`,
`create-failure.txt`, `start-warnings.txt`. A header comment in each records
the exact command that produced it.

**One-time manual verification** (recorded in the plan, not in CI): create →
start → `list` → `collect --target` → stop, against `ProbePhone`. This session
already ran create/start/stop successfully with a custom `-instancePath`
(target up in 34 s); the plan re-runs the full chain once after implementation
and records the output.

No `device`-project test. Booting an emulator takes a GUI, ~1–2 GB of RAM and
a minute per run; that is not a cost the default suite should pay.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| `Emulator.exe` output changes between DevEco releases | Failure detection is structural (`^Emulator: `, `^Unable to `), and every parse is covered by a committed fixture; an unknown shape fails loudly instead of being read as success. |
| Instance root differs per machine (measured: it does) | `.emu_config` discovery plus `--instance-path`, with the default only as a last resort. |
| Port attribution is wrong | Attribute only when exactly one instance is running and exactly one connected TCP target exists; otherwise omit with a reason. |
| A timeout leaves a half-booted instance | Never auto-stop; the error names the phase and tells the caller how to clean up. |
| Windows-only | Non-Windows hosts get `EmulatorNotFoundError` that says the platform was not searched by default. |

## 12. Documentation

- README: a "Emulators" section with the four commands, the `--target` handoff
  to `collect`, the determinism carve-out from §7, and the "no image download"
  rule.
- Roadmap row P7 → `shipped in <version>` when released.
- `THIRD_PARTY_NOTICES.md`: no change — this module is not ported from HapRay.
- Site: the roadmap card and the CLI list, in both locales.
- Skill: `skill/ohos-perf/SKILL.md` gains the emulator step before `collect`
  when no device is attached.
