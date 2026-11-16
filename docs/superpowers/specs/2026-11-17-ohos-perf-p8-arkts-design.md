# P8 — ArkTS-Side Capabilities: `ui.gesture`, honest `coverage` and `js.heap`

**Status:** design, approved by delegation ("这些你就自行帮我设计吧，就不要问我了")
**Date:** 2026-11-17
**Supersedes:** the roadmap's last "exploring" row. Extends
`design/2026-11-14-ohos-perf-core-design.md` §7 (capability matrix).

## 1. Purpose

Close the three capabilities the matrix still treats as exploration:

| Capability | Before P8 | After P8 |
| --- | --- | --- |
| `ui.gesture` | reported available wherever `uitest` exists, but nothing in the package could inject a gesture | **drivable**: a `GestureDriver` in core and an `ohos-perf gesture` CLI group |
| `coverage` | reported available wherever `hiprofiler_cmd` exists — a claim nothing in the package can honour | **unavailable**, with a measured reason naming `bjc_cov` and the missing collector |
| `js.heap` | unavailable with the analyzer reason | **unavailable**, reason unchanged in verdict, extended with the measured `hidumper` permission gate |

The governing rule is the one P5 established: **a capability is reported
available only when the package can actually drive it.** P8 adds the code that
makes `ui.gesture` true and removes the code-free claim that made `coverage`
false.

## 2. Non-goals

- **No gesture schedule inside a capture.** `collect` does not accept a
  gesture script. Driving the UI to a state and then capturing it composes as
  two CLI calls; injecting gestures at trace-relative offsets needs capture
  orchestration and an abort contract of its own. A later plan owns it.
- **No `dircFling`, `doubleClick`, `longClick`, `drag` or `fling`.** Only the
  commands measured end-to-end on 2026-11-17 are exposed: `click`, `swipe`,
  `keyEvent`, `inputText` and `text`.
- **No coverage implementation.** `bjc_cov` is absent from the Mate 60, `aa`
  prints nothing over plain shell, and the package ships no coverage analyzer.
  The capability reports that instead of a fabricated zero.
- **No ArkTS heap parser.** `hidumper --mem-jsheap` is permission-gated on the
  measured device (release apps and `com.ohos.sceneboard` are both refused),
  and no analyzer consumes its snapshot format.

## 3. Measured facts

Measured on 2026-11-17 against a HUAWEI Mate 60 (BRA-AL00), OpenHarmony
7.0.0.111, arm64-v8a, over plain `hdc shell`.

| Fact | Measured value |
| --- | --- |
| `uitest` location | `/system/bin/uitest` |
| `uitest uiInput` over plain shell | **works**; no AAMS daemon is involved. The old reason ("needs AAMS") came from `uitest uiRecord`, which is a different command. |
| Success output | stdout `No Error\r\n`, empty stderr |
| Injection proof | `uitest dumpLayout` saved 69,529 bytes; `uitest uiInput keyEvent Home`; a second dump saved 158,734 bytes — the screen changed |
| **Exit code over hdc** | **always 0**, even when the device-side tool exits 1. `uitest uiInput click abc def` exits 1 inside the device shell and prints `Please confirm that the coordinate values are correct.`; `hdc shell` still returns 0. **The exit code is not the authority; `No Error` is.** (Same shape as `dumpLayout`'s `DumpLayout saved`.) |
| Invalid key | device-side exit 1, `Invalid parameters.` |
| `click <x> <y>` | accepted `500 500`; also accepted `99999 99999` with `No Error` — the tool does not bounds-check against the screen |
| `swipe <x1> <y1> <x2> <y2> [velocity]` | accepted; velocity range is **200–40000** |
| Velocity out of range | prints `The swipe velocity out of range, the default value will be used.` and still `No Error` — **silent fallback**, so the client must reject out-of-range values rather than let the device substitute its default |
| `keyEvent <key>` | accepts `Back`, `Home`, `Power` and numeric key codes (`2` accepted) |
| `inputText <x> <y> <text>` | accepted, including quoted text with spaces |
| `text <text>` | accepted; types at the focused field |
| `bjc_cov` | `which bjc_cov` empty; `ls /system/bin/*cov* /bin/*cov*` → `No such file or directory` |
| `aa` over plain shell | prints nothing at all (bare `aa`, `aa help test`, `aa test -b …`), so no coverage route through the test runner |
| `hidumper --mem-jsheap <pid>` | `[Permission Check Failed] The --mem-jsheap option needs a debug-signed application.` for a release third-party app (pid 40266) and for `com.ohos.sceneboard` (pid 6500); `developer mode: satisfied` is not sufficient |
| `hiprofiler_cmd --list` | `Service not started` (the probe deliberately does not start a daemon) |

## 4. Design

### 4.1 Core: `GestureDriver`

New file `packages/core/src/device/gesture.ts`:

```ts
export type Gesture =
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | { readonly action: 'swipe'; readonly fromX: number; readonly fromY: number;
      readonly toX: number; readonly toY: number; readonly velocity?: number }
  | { readonly action: 'key'; readonly key: string | number }
  | { readonly action: 'inputText'; readonly x: number; readonly y: number;
      readonly text: string }
  | { readonly action: 'text'; readonly text: string };

export interface GestureResult {
  /** The gesture as performed, echoed for logs and JSON consumers. */
  readonly gesture: Gesture;
  /** The device tool's stdout, trimmed (`No Error`, or a warning plus `No Error`). */
  readonly output: string;
}

export class GestureDriver {
  perform(hdc: Hdc, target: string, gesture: Gesture): Promise<GestureResult>;
}
```

`perform` follows the collectors' signature shape (`hdc, target, …`) so
`Device` can share one instance from `DeviceDeps`.

**Validation happens before the shell call** (`UITEST_BAD_GESTURE`):

- every coordinate: a safe integer `>= 0` (out-of-screen values are allowed —
  the device accepts them, and the driver cannot know the screen size);
- `velocity`, when present: an integer in `200..40000`, because the device
  otherwise substitutes its default silently;
- `key`: `Back`, `Home`, `Power`, or a safe integer `> 0`;
- text: non-empty and free of control characters (`\u0000-\u001f`, `\u007f`),
  because those are not typable and would smuggle separators into the shell
  command.

**Command construction** (text is single-quoted, `'` becomes `'\''`):

```
uitest uiInput click <x> <y>
uitest uiInput swipe <fx> <fy> <tx> <ty> [<velocity>]
uitest uiInput keyEvent <key>
uitest uiInput inputText <x> <y> '<text>'
uitest uiInput text '<text>'
```

**Success is the marker, never the exit code.** `No Error` must appear in
stdout or stderr. Otherwise `perform` throws `UITEST_INPUT_FAILED` with the
tool's first output lines (the measured refusal text and the exit code hdc
reported). An `HDC_SHELL_FAILED` from the transport is wrapped in
`UITEST_INPUT_FAILED` with its cause, mirroring `UitestCollector`'s dump
error.

### 4.2 Core: `Device.gesture`

`DeviceDeps` gains `gesture?: GestureDriver`; `Device` gains
`gesture(gesture: Gesture): Promise<GestureResult>`.

The method gates on the `ui.gesture` capability exactly as `collect` gates on
`trace.frames`: an unavailable capability throws `MISSING_CAPABILITY` naming
the matrix's reason (`uitest not present on device`). On success it delegates
to `this.deps.gesture ?? new GestureDriver()` with the device's own target.

Because `ui.gesture` is `binary: 'uitest'`, the matrix claim and the driver
now agree: wherever the matrix says yes, `perform` has a binary to call.

### 4.3 Core: capability honesty

`coverage` stops borrowing `hiprofiler_cmd`:

```ts
{
  id: 'coverage',
  collector: 'bjc_cov',
  binary: 'bjc_cov',
  missingReason: () => 'bjc_cov not present on device',
  available: () => false,
  unavailableReason: 'no coverage collector in this package consumes bjc_cov output',
}
```

The probe gains `bjc_cov` to its fixed `which` list (one extra read-only
command; six binaries total). Absent → `bjc_cov not present on device`;
present → the package-side reason. Both are true; neither claims coverage.

`js.heap` keeps its always-false verdict and gains the second measured gate:

```ts
unavailableReason:
  'no analyzer in this package consumes js_heap_* tables;' +
  ' hidumper --mem-jsheap needs a debug-signed or profilerable app'
```

`ui.gesture` keeps `binary: 'uitest'`; a comment records that `uiInput` is
driven by `GestureDriver` and that the AAMS constraint belonged to `uiRecord`.

### 4.4 CLI: `ohos-perf gesture`

```
ohos-perf gesture click <x> <y>                        [--target <id>] [--json]
ohos-perf gesture swipe <from-x> <from-y> <to-x> <to-y> [--velocity <n>] [--target <id>] [--json]
ohos-perf gesture key <key>                            [--target <id>] [--json]
ohos-perf gesture input <x> <y> <text>                 [--target <id>] [--json]
ohos-perf gesture text <text>                          [--target <id>] [--json]
```

- Each subcommand declares `--target`/`--json` itself, following the
  emulator group's pattern.
- Parsing lives in `packages/cli/src/gesture.ts` (`parseCoordinate`,
  `parseVelocity`, `parseKey`) and produces the CLI-wide failure contract:
  empty stdout, one message on stderr, exit 1.
- The action builds the `Gesture` union, calls
  `deps.gesture({ gesture, target })`, and `runGesture` renders it.
- Human output is one line, e.g. `click 500 500 accepted`,
  `swipe 500,800 -> 500,200 accepted`, `key Home accepted`,
  `input 500 500 "hello" accepted`. `--json` emits `{ gesture, output }`.
- The IO layer connects through a new overridable `gestureDevice` connector
  (production: `connect()`), so tests never spawn hdc.

## 5. Error handling and degradation

| Condition | Behaviour |
| --- | --- |
| `uitest` missing | `Device.gesture` throws `MISSING_CAPABILITY`, message names `uitest not present on device` |
| Invalid argument (CLI or API) | exit 1 / `UITEST_BAD_GESTURE`; **no device call is made** |
| Device refuses the gesture | `UITEST_INPUT_FAILED` naming the tool's output (`hdc` exit 0 is not success) |
| hdc transport failure | `UITEST_INPUT_FAILED` wrapping `HDC_SHELL_FAILED` |
| `coverage`/`js.heap` requested | still reported unavailable, now with a reason the caller can act on |

## 6. Testing

- **Unit, fake hdc**: command strings per action; quoting of `'` and spaces;
  every validation branch (coordinates, velocity range, key names/codes, empty
  and control-character text) asserts the shell call never happened; marker
  check with the measured `Please confirm…` output at exit 0; transport
  wrapping.
- **Unit, Device**: the capability gate (`uitest: false` → `MISSING_CAPABILITY`
  with the matrix reason) and delegation (injected driver receives the device
  id and the gesture).
- **CLI unit**: every subcommand maps to the right `Gesture`; `--target` reaches
  the connector; `--json` round-trips; parse errors exit 1 with empty stdout.
- **Device acceptance** (`*.device.test.ts`, skipped when no device):
  `gesture key Home` is accepted on the attached device — the only proof that
  the marker and quoting match the shipped binary.

## 7. Compatibility

- New value export `GestureDriver`; new type exports `Gesture`,
  `GestureResult`. `VALUE_EXPORTS` in `types.test.ts` grows by one.
- `CliDeps` gains a required `gesture` member; every test fake gains a stub.
- The probe's fixed command list grows by `which bjc_cov`; `coverage` leaves
  the "fixed hiprofiler reason" expectation.
- The Mate 60 matrix drops from 20/21 to **19/21** (js.heap and coverage
  unavailable) — an honest decrease, and the number the docs must print.

## 8. Docs and skill

- README: remove `ui.gesture` from "Not implemented yet"; describe the
  `gesture` commands; restate `coverage`/`js.heap`; update the matrix count and
  the roadmap (P8 row replaces "exploring").
- `skill/ohos-perf/SKILL.md`: add the gesture workflow (drive to a state, then
  collect) and add `gesture` to the commands that accept `--target`.
- CHANGELOG and `site/index.html`: same facts, both locales where present.
