# P13 — Deterministic scenario runner (HapRay parity W5)

**Status:** approved for implementation (design delegated by the user)
**Release:** `0.8.0`
**Builds on:** P12 hilog (`0.7.0`); HapRay `9386e4e`
**Gap-analysis rows:** 1 (`perf` scripted execution), 2 (`prepare`), 6 (per-step capture), 10 (report metadata)

## Why this phase

Every measurement this package can take is one window: `collect` captures a
trace, and `analyze` reads it. That is the right primitive, but it cannot
answer "what happens when the user taps this button, five times in a row" —
because driving the app and capturing it are two commands a person has to
sequence by hand, and nothing records which capture belongs to which step.

HapRay solves this with a Python testcase runner (Hypium/xdevice) that runs
bundled `.py` cases, one hiprofiler session per step, and writes
`steps.json` / `testInfo.json` / `pids.json`. The runner is the one part of
HapRay this package deliberately does not port: it executes device-driving
Python, swallows action failures, has no pass/fail semantics, and adds a fixed
25-second wait per case.

P13 builds the same orchestration out of what already exists — declarative
JSON, the existing collectors, the existing gesture injection — and fixes the
properties the Python runner gets wrong.

## Scope

**In scope**

- A versioned JSON scenario document (`scenario.json`):

  ```json
  {
    "version": 1,
    "name": "image-open",
    "description": "open the viewer and measure the first frame",
    "app": "com.example.image",
    "rounds": 2,
    "steps": [
      {
        "id": "open",
        "name": "Open the viewer",
        "setup": [
          { "kind": "launch", "ability": "EntryAbility" },
          { "kind": "wait", "ms": 1500 }
        ],
        "actions": [
          { "kind": "click", "x": 500, "y": 800 },
          { "kind": "marker", "name": "image-requested" }
        ],
        "cleanup": [{ "kind": "forceStop" }],
        "capture": { "durationMs": 5000, "collectors": ["hitrace", "procfs", "hilog"] }
      }
    ]
  }
  ```

- Three phases per step, all actually executed:
  - `setup` runs **before** the capture window — get the app to the state you
    want to measure without paying for it in the trace. A setup failure fails
    the step before any capture starts.
  - `actions` run **inside** the capture window, concurrently with the
    collectors, so the gesture that causes the work is in the trace.
  - `cleanup` runs **after** the capture, always — including when an action
    failed. Its failure marks the step failed but never masks the first error.
  (HapRay's DSL parses `setup`/`cleanup` and never executes them; executing
  all three phases is the point of doing this natively.)

- Actions: `launch`, `forceStop`, `click`, `swipe`, `key`, `text`,
  `inputText`, `wait`, `marker`. The gesture actions delegate to the existing
  `ui.gesture` path (`uitest uiInput`), so their validation and success
  marker are the ones already measured on device. `launch` and `forceStop`
  are `aa start` / `aa force-stop`, and a non-zero exit fails the action.
  `marker` performs **no device call**: it records a named device-uptime
  instant in `steps.json`, which is what makes "the tap that opened the
  image" a timestamp a trace row can be compared against. There is no
  trace-marker injection on the device, so a marker is an annotation, not an
  event, and the docs say so.

- Per-step capture through the existing `Device.collect`, with the collector
  set chosen per step: `hitrace` (default), `hiprofiler` (with `plugins`),
  `procfs`, `hiperf`, `hidumper`, `uitest`, `hilog`.

- A run directory:

  ```
  <out>/testInfo.json
  <out>/steps.json
  <out>/pids.json
  <out>/<stepId>/round-<n>/   ← a complete scene: analyze/report/query it directly
  ```

- Rounds: `rounds` in the scenario, `--rounds` on the CLI. Each round re-runs
  every step in file order; every (round, step) pair gets its own scene.

- `--only <ids>` runs a subset, comma-separated, in scenario order. An id that
  matches no step is an error naming the available ids.

- Fail-fast by default: the first failed step stops the run with exit 1 and a
  `steps.json` that still describes everything that happened. `--keep-going`
  continues after a failure.

- Action timestamps in **device uptime nanoseconds** (`/proc/uptime`), the
  same clock base as trace `ts`. This is what makes an action correlatable
  with a frame — HapRay has no action-to-frame correlation anywhere.

- `scene.json` gains an optional `step` block (`{ round, index, id }`), so a
  scene copied out of a run is still self-describing. The version stays `1`
  and every existing reader keeps working.

**Out of scope, deliberately**

- **Hypium / xdevice and Python testcase execution.** Executable test code is
  what makes HapRay's runner unauditable and its failures silent. JSON is
  reviewable by a human and authorable by an agent.
- **Assertions and pass/fail on measurements.** The runner decides success on
  *actions*, never on metrics. "Did the app get slower" is `compare`'s
  question, and a threshold baked into a scenario would be a claim the capture
  cannot support.
- **A device pool / parallel devices.** One target per run; `--target` picks
  it. Multi-device orchestration is a CI concern, not a measurement one.
- **Retries.** HapRay retries a case up to five times when its output is
  empty. A capture that produced nothing is reported as nothing; silently
  re-running until something appears is how an empty capture becomes a
  plausible number.
- **YAML.** JSON only, for now. A YAML front end would need a parser
  dependency in a package with zero runtime dependencies.
- **Persistent on-device log rotation and multi-capture steps.** One capture
  window per step; a second window is a second step.
- **Autonomous exploration and the LLM GUI agent** (gap-analysis rows 4–5):
  both are nondeterministic and neither is a parity target. The agent skill
  drives gestures and queries with its own state model instead.

## Semantics

### Validation happens before any device call

The whole document is parsed and validated first: unknown keys, a wrong
`version`, a missing `app`, an empty `steps` array, a duplicate step `id`, an
unknown action `kind`, a negative coordinate, a `durationMs` outside
`(0, 2^31-1]`, a `collectors` name outside the known set, `plugins` without
`hiprofiler`, an empty `plugins` array — each is a typed `OhosPerfError` with
code `SCENARIO_BAD_INPUT` (document) or `SCENARIO_BAD_STEP` (step), naming the
JSON path (`steps[1].capture.collectors[2]`). A scenario that would fail on
step 3 must not fail after two captures have already run.

Unknown keys are errors, not ignored: a typo like `"duratonMs"` would
otherwise silently capture the default duration.

### Step ids and paths

`id` is required and must match `^[a-z][a-z0-9_-]*$` — it becomes a directory
name, so it is restricted to what is unambiguous on every platform and cannot
escape the run directory. Duplicate ids are rejected. The scene directory is
`<out>/<id>/round-<n>/`, which makes a step's scene addressable without
reading `steps.json`.

### Capture and actions overlap

`Device.collect` returns a session; `ingest()` starts the collectors. The
runner starts the capture, runs `actions` against the same device while it is
in flight, then awaits the capture. Two consequences are deliberate:

- A gesture that fails does **not** cancel the capture. The trace is a real
  measurement of what the device did while the action was attempted; the step
  is marked `failed` with the action's error and the scene is kept.
- The capture's own failure is reported after the actions have settled, so a
  rejection is never left unhandled and no collector writes into the scene
  after the step is declared failed.

### Timestamps

Every action records `atNs` (device uptime, ns) and `atMs` (host clock, ms).
`atNs` is read with one `cat /proc/uptime` immediately before the action; a
failed read omits `atNs` rather than writing a fabricated zero, because
uptime `0` addresses the trace origin.

`steps.json` is **structurally** deterministic: same scenario, same device,
same outcomes → identical keys in identical order, identical ids, identical
paths. The fields that legitimately vary are `startedAtMs` and `durationMs`;
they are listed in one place (each step entry) so a comparison can ignore
exactly those.

### Failure

A failed step writes its entry with `"status": "failed"` and an `error`
string. `sceneDir` is present only when a scene exists — a capture that failed
before producing a database has no directory to name, and naming one would
point a reader at an empty folder.

The run's exit code is 1 when any step failed. `steps.json` and
`testInfo.json` are written on the failure path too: a run that stopped on
step 2 must still say what step 1 produced.

### `testInfo.json`

```json
{
  "version": 1,
  "scenario": "image-open",
  "app": { "packageName": "com.example.image", "version": "1.0.0" },
  "device": { "id": "127.0.0.1:5555", "kind": "emulator" },
  "startedAtMs": 1763350000000,
  "durationMs": 41200,
  "rounds": 2,
  "steps": 4,
  "status": "completed"
}
```

`app.version` comes from `bm dump -n <bundle>` and is **absent** when the
device will not answer — a missing version is not a version of `0`.

### `pids.json`

```json
{ "pids": [4999, 5012], "processNames": ["com.example.image"] }
```

Resolved once at run start with `pidof`. An app that is not running yields
`{ "pids": [], "processNames": [...] }` — the name is what was asked for, the
empty list is what the device said. Per-step pids stay in each scene's
`scene.json`, where they describe that capture.

### The runner is collect-only

`run` never analyzes. Each step directory is a scene, so reporting is
`ohos-perf report <out>/<id>/round-<n>` — the same command as any other scene,
applied per step. That is HapRay's `prepare` mode by construction (collect
without report), and it keeps one code path for every report this package
produces.

## CLI

```
ohos-perf run <scenario.json> --out <dir>
  [--target <id>] [--rounds <n>] [--only <ids>] [--keep-going] [--json]
```

Human output is one line per step (`ok|failed  <id>  round <n>  <sceneDir>`)
then a run summary. `--json` prints the `RunResult` the core returns.

## Capability handling

The runner adds no capability row: it orchestrates collectors that already
have one. Each step's `collectors` list is gated by `Device.collect` exactly
as `ohos-perf collect` is, so an unavailable collector fails that step with
the matrix's reason (`uitest not present on device`) and the message names the
step. A scenario whose steps need different capabilities can still run on a
device that satisfies some of them, with `--keep-going` — the failures are
labelled, never silently skipped.

## Testing

- Schema: every rejection path, each naming its JSON path; unknown-key
  rejection; duplicate ids; `--only` with an unknown id.
- Runner with an injected fake device: phase order (setup → capture start →
  actions → capture await → cleanup), the scene path, `steps.json` shape,
  fail-fast vs `--keep-going`, a failed action keeping its scene, cleanup
  running after a failed action, rounds producing `(round, step)` pairs, and
  `--only` ordering.
- Determinism: two runs with the same fake outcomes produce `steps.json`
  identical after removing `startedAtMs`/`durationMs`.
- Metadata: `scene.json`'s `step` block round-trips through
  `readSceneMetadata`, and an old `scene.json` without it still reads.
- CLI: argument validation before any device call; exit code 1 on a failed
  step; `--json` shape.
- Device (skipped without a device): a two-step scenario on the emulator
  produces two scene directories, each with `trace.db` and a `scene.json`
  carrying its `step` block.

## Exit criteria

1. A two-step scenario produces two scene directories with distinct capture
   windows, `steps.json`, `testInfo.json` and `pids.json`.
2. Each step's scene analyzes with `ohos-perf analyze` and its `scene.json`
   names the step.
3. A failing action fails the step, keeps the scene, and exits 1.
4. Two runs with the same outcomes produce structurally identical
   `steps.json`.
5. An invalid scenario fails before any device call, naming the JSON path.
