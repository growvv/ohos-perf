# P13 scenario runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a declarative JSON scenario — ordered steps, each with setup, in-capture actions and cleanup — capturing one scene per step and writing `steps.json`, `testInfo.json` and `pids.json`.

**Architecture:** `parseScenario` validates the whole document into typed `Scenario`/`ScenarioStep` values before any device call. `ScenarioRunner` drives `Device.collect` per step, runs actions against the same device while the capture is in flight, and records each step's outcome; `runScenario` writes the three run files. The CLI exposes it as `ohos-perf run`.

**Tech Stack:** TypeScript (ESM), Vitest (`--project unit` / `--project device`), zero runtime dependencies in core. No new database work — a step scene is produced by the existing `Device.collect`.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p13-scenario-design.md`

## Global Constraints

- **Validation before any device call.** An invalid scenario throws `SCENARIO_BAD_INPUT` / `SCENARIO_BAD_STEP` naming the JSON path; nothing is captured.
- **Unknown keys are errors**, not ignored (`"duratonMs"` must not silently take a default).
- Step `id` matches `^[a-z][a-z0-9_-]*$`, is unique, and is the directory name under `--out`.
- Phase order is fixed: `setup` → capture start → `actions` (in flight) → capture await → `cleanup`. `cleanup` runs even when an action failed.
- A failed action fails the step **but keeps its scene**; the scene is a real measurement of what the device did.
- No `Date.now()` in `steps.json` structure decisions: the only host-clock fields are `startedAtMs` and `durationMs`, and they exist so a reader can tell two runs apart.
- `steps.json` and `testInfo.json` are written on the failure path too.
- Exit 1 when any step failed; `--keep-going` changes whether later steps run, never the exit code.
- The runner never analyzes. A step directory is a scene for `analyze` / `report` / `query`.
- No retries, no device pool, no YAML, no assertions on metrics.

## Review Focus

- An action that fails must not cancel the in-flight capture, and the capture's rejection must still be observed (no unhandled rejection, no collector writing after the step is declared failed).
- `cleanup` must run after a failed action and its failure must not mask the action's error.
- A step whose capture failed must not report a `sceneDir` it does not have.
- `--only` must run steps in scenario order regardless of the order the ids were typed.
- Two runs with identical outcomes must produce `steps.json` identical after removing `startedAtMs`/`durationMs`.
- A `collectors` entry the device lacks must fail that step with the matrix's reason naming the step, and with `--keep-going` the remaining steps still run.
- A scenario `version: 2` must be rejected, not read as version 1.

---

### Task 1: Scenario document parsing and validation

**Files:**
- Create: `packages/core/src/scenario/schema.ts`
- Test: `packages/core/test/scenario-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  type ScenarioAction =
    | { kind: 'launch'; ability: string }
    | { kind: 'forceStop' }
    | { kind: 'click'; x: number; y: number }
    | { kind: 'swipe'; fromX: number; fromY: number; toX: number; toY: number; velocity?: number }
    | { kind: 'key'; key: string | number }
    | { kind: 'text'; text: string }
    | { kind: 'inputText'; x: number; y: number; text: string }
    | { kind: 'wait'; ms: number }
    | { kind: 'marker'; name: string };

  type CollectorName = 'hitrace' | 'hiprofiler' | 'procfs' | 'hiperf' | 'hidumper' | 'uitest' | 'hilog';

  interface StepCapture {
    durationMs: number;
    collectors: readonly CollectorName[];
    hiprofiler?: { plugins: readonly HiprofilerPluginName[] };
    hiperf?: { frequency?: number };
  }

  interface ScenarioStep {
    id: string; name: string;
    setup: readonly ScenarioAction[];
    actions: readonly ScenarioAction[];
    cleanup: readonly ScenarioAction[];
    capture: StepCapture;
  }

  interface Scenario {
    version: 1; name: string; description?: string; app: string;
    rounds: number; steps: readonly ScenarioStep[];
  }

  function parseScenario(text: string): Scenario
  ```
  Every rejection is `OhosPerfError` with code `SCENARIO_BAD_INPUT` (document-level) or `SCENARIO_BAD_STEP` (inside a step), and the message starts with the JSON path (`steps[1].capture.durationMs`).

- [ ] **Step 1: Write the failing test**

```ts
const MINIMAL = {
  version: 1, name: 'x', app: 'com.example.app',
  steps: [{ id: 'a', actions: [], capture: { durationMs: 1000, collectors: ['hitrace'] } }],
};

it('fills the documented defaults', () => {
  const s = parseScenario(JSON.stringify(MINIMAL));
  expect(s.rounds).toBe(1);
  expect(s.steps[0].setup).toEqual([]);
  expect(s.steps[0].cleanup).toEqual([]);
  expect(s.steps[0].name).toBe('a');
  expect(s.steps[0].capture.collectors).toEqual(['hitrace']);
});

it('rejects an unknown key, naming its path', () => {
  const doc = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], capture: { duratonMs: 1000, collectors: ['hitrace'] } }] };
  expect(() => parseScenario(JSON.stringify(doc)))
    .toThrow(/steps\[0\]\.capture.*duratonMs/);
});

it('rejects a wrong version, an empty steps array and a duplicate id', () => {
  expect(() => parseScenario(JSON.stringify({ ...MINIMAL, version: 2 })))
    .toThrow(/version/);
  expect(() => parseScenario(JSON.stringify({ ...MINIMAL, steps: [] })))
    .toThrow(/steps/);
  const twice = { ...MINIMAL, steps: [MINIMAL.steps[0], MINIMAL.steps[0]] };
  expect(() => parseScenario(JSON.stringify(twice))).toThrow(/steps\[1\]\.id/);
});

it('rejects a step id that is not a directory-safe slug', () => {
  const doc = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], id: 'Open Viewer' }] };
  expect(() => parseScenario(JSON.stringify(doc))).toThrow(/steps\[0\]\.id/);
});

it('rejects a collector name outside the known set', () => {
  const doc = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], capture: { durationMs: 1000, collectors: ['hitrace', 'ftrace'] } }] };
  expect(() => parseScenario(JSON.stringify(doc))).toThrow(/collectors\[1\]/);
});

it('rejects plugins without hiprofiler and an empty plugins list', () => {
  const noHipro = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], capture: { durationMs: 1000, collectors: ['hitrace'], hiprofiler: { plugins: ['gpu'] } } }] };
  expect(() => parseScenario(JSON.stringify(noHipro))).toThrow(/hiprofiler/);
  const empty = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], capture: { durationMs: 1000, collectors: ['hiprofiler'], hiprofiler: { plugins: [] } } }] };
  expect(() => parseScenario(JSON.stringify(empty))).toThrow(/plugins/);
});

it('rejects a duration outside (0, 2^31-1]', () => {
  for (const durationMs of [0, -1, 1.5, 2 ** 31]) {
    const doc = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], capture: { durationMs, collectors: ['hitrace'] } }] };
    expect(() => parseScenario(JSON.stringify(doc)), String(durationMs))
      .toThrow(/durationMs/);
  }
});

it('rejects an unknown action kind and a negative coordinate', () => {
  const bad = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], actions: [{ kind: 'tap', x: 1, y: 2 }] }] };
  expect(() => parseScenario(JSON.stringify(bad))).toThrow(/actions\[0\]\.kind/);
  const neg = { ...MINIMAL, steps: [{ ...MINIMAL.steps[0], actions: [{ kind: 'click', x: -1, y: 2 }] }] };
  expect(() => parseScenario(JSON.stringify(neg))).toThrow(/actions\[0\]\.x/);
});

it('rejects invalid JSON with a message that says so', () => {
  expect(() => parseScenario('{ nope')).toThrow(/scenario/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit scenario-schema`
Expected: FAIL — cannot resolve `../src/scenario/schema`.

- [ ] **Step 3: Implement `packages/core/src/scenario/schema.ts`**

A hand-written validator, not a schema library (zero runtime dependencies). Shape:

- `parseScenario(text)` → `JSON.parse` in a `try`, rethrowing as `SCENARIO_BAD_INPUT` with the parser's message; then `validateDocument`.
- A small `Cursor` helper: `object(value, path, allowedKeys)` throws on a non-object and on any key not in `allowedKeys`, listing them; `string`, `int`, `positiveInt` similarly. Every error message begins with the path.
- `ACTION_KEYS` maps each `kind` to its allowed keys, so one `switch` validates and builds. Coordinates and `wait.ms` are non-negative safe integers; `velocity` (when present) is an integer in `[200, 40000]`; `text` is non-empty and free of control characters; `ability`, `marker.name` and the app match `^[A-Za-z0-9_.]+$`; step `id` matches `^[a-z][a-z0-9_-]*$`.
- `collectors` defaults to `['hitrace']` only when the key is **absent**; an explicit `[]` is an error ("capture needs at least one collector"). `hitrace` and `hiprofiler` are mutually exclusive — a step naming both is rejected at the second one's path, because `Device.collect` has no way to honour both and would silently pick one.
- `plugins` requires `hiprofiler` in `collectors`; an explicit `[]` is an error. `hiperf` is only valid when `hiperf` is in `collectors`.
- Duplicate step ids are rejected at the second occurrence's path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit scenario-schema`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/schema.ts packages/core/test/scenario-schema.test.ts
git commit -m "feat(core): validate declarative scenario documents"
```

---

### Task 2: `step` block in scene metadata

**Files:**
- Modify: `packages/core/src/ingest/metadata.ts` (`SceneMetadata`, `isCapture`'s neighbours, `readSceneMetadata`)
- Modify: `packages/core/src/device/device.ts` (`CollectOptions.step`, the `writeSceneMetadata` call)
- Test: `packages/core/test/scene-step-metadata.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface SceneStepRef { readonly round: number; readonly index: number; readonly id: string }
  // SceneMetadata gains: step?: SceneStepRef
  // CollectOptions gains: step?: SceneStepRef
  ```
  The version stays `1`. A document without `step` reads exactly as before; a `step` that is present but malformed makes the whole descriptor untrustworthy (`readSceneMetadata` → `undefined`), like every other malformed field.

- [ ] **Step 1: Write the failing test**

```ts
const layout = createSceneLayout(join(mkdtempSync(join(tmpdir(), 'step-meta-')), 's'));
const base = {
  version: 1 as const,
  app: { packageName: 'com.example.app', processNames: ['com.example.app'] },
  pids: [], deviceId: 'd',
};

it('round-trips the step block', () => {
  writeSceneMetadata(layout, { ...base, step: { round: 1, index: 0, id: 'open' } });
  expect(readSceneMetadata(layout)?.step).toEqual({ round: 1, index: 0, id: 'open' });
});

it('reads a document with no step block exactly as before', () => {
  writeSceneMetadata(layout, base);
  const read = readSceneMetadata(layout);
  expect(read).toBeDefined();
  expect(read).not.toHaveProperty('step');
});

it('treats a malformed step block as an untrustworthy descriptor', () => {
  for (const step of [{ round: 0, index: 0, id: 'a' }, { round: 1, index: -1, id: 'a' }, { round: 1, index: 0 }]) {
    writeSceneMetadata(layout, { ...base, step } as never);
    expect(readSceneMetadata(layout), JSON.stringify(step)).toBeUndefined();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit scene-step-metadata`
Expected: FAIL — `step` is not a property of `SceneMetadata` (type error) and the round-trip assertion fails.

- [ ] **Step 3: Implement**

`metadata.ts`: add `SceneStepRef`, add `step?: SceneStepRef` to `SceneMetadata`, add `isStepRef` (`round >= 1`, `index >= 0`, `id` non-empty, all safe integers/strings), gate `readSceneMetadata` on it when present, and copy it into the returned object when present (spread, so an absent field stays absent). `device.ts`: add `step?: SceneStepRef` to `CollectOptions` and spread `...(opts.step === undefined ? {} : { step: opts.step })` into the `writeSceneMetadata` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit scene-step-metadata`
Expected: PASS. Then `npx vitest run --project unit` — the existing metadata tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ingest/metadata.ts packages/core/src/device/device.ts packages/core/test/scene-step-metadata.test.ts
git commit -m "feat(core): record a step reference in scene metadata"
```

---

### Task 3: Action execution

**Files:**
- Create: `packages/core/src/scenario/actions.ts`
- Test: `packages/core/test/scenario-actions.test.ts`

**Interfaces:**
- Consumes: `ScenarioAction` (Task 1); `Device.gesture` / `Device.shell` / `Device.id`.
- Produces:
  ```ts
  interface ActionOutcome {
    readonly action: ScenarioAction;
    /** Device uptime ns, read immediately before the action; absent when the read failed. */
    readonly atNs?: number;
    readonly atMs: number;
    readonly ok: boolean;
    readonly output?: string;
    readonly error?: string;
  }
  /** Executes one action; throws on failure (the runner records and rethrows). */
  async function executeAction(device: ActionDevice, action: ScenarioAction): Promise<{ output?: string }>;

  interface ActionDevice {
    readonly id: string;
    shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
    gesture(g: Gesture): Promise<GestureResult>;
  }
  ```
  `wait` resolves after `ms` without touching the device. `launch` is `aa start -a <ability> -b <app>`; `forceStop` is `aa force-stop <app>`; both take the app from a `app` parameter.

  Revised signature so the app is explicit:
  ```ts
  executeAction(device: ActionDevice, app: string, action: ScenarioAction): Promise<{ output?: string }>
  ```

- [ ] **Step 1: Write the failing test**

```ts
function fakeDevice(overrides: Partial<ActionDevice> = {}): ActionDevice & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    id: 't1',
    async shell(cmd) { calls.push(cmd); return { stdout: '', stderr: '', code: 0 }; },
    async gesture(g) { calls.push(`gesture:${g.action}`); return { gesture: g, output: 'No Error' }; },
    ...overrides,
  };
}

it('maps every action to its device command', async () => {
  const d = fakeDevice();
  await executeAction(d, 'com.a', { kind: 'launch', ability: 'EntryAbility' });
  await executeAction(d, 'com.a', { kind: 'forceStop' });
  await executeAction(d, 'com.a', { kind: 'click', x: 5, y: 6 });
  await executeAction(d, 'com.a', { kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4, velocity: 600 });
  await executeAction(d, 'com.a', { kind: 'key', key: 'Home' });
  await executeAction(d, 'com.a', { kind: 'text', text: 'hi' });
  await executeAction(d, 'com.a', { kind: 'inputText', x: 7, y: 8, text: 'hi' });
  expect(d.calls).toEqual([
    'aa start -a EntryAbility -b com.a',
    'aa force-stop com.a',
    'gesture:click', 'gesture:swipe', 'gesture:key', 'gesture:text', 'gesture:inputText',
  ]);
});

it('quotes text so a space or quote reaches the device intact', async () => {
  const d = fakeDevice();
  await executeAction(d, 'com.a', { kind: 'text', text: "it's here" });
  // The gesture driver does its own quoting; the scenario layer must not
  // double-quote, so the text arrives verbatim in the Gesture value.
  expect(d.calls).toEqual(['gesture:text']);
});

it('fails on a non-zero aa exit, naming the command', async () => {
  const d = fakeDevice({ async shell(cmd) { return { stdout: '', stderr: 'bad', code: 2 }; } });
  await expect(executeAction(d, 'com.a', { kind: 'launch', ability: 'X' }))
    .rejects.toThrow(/aa start.*exit 2/);
});

it('propagates a gesture failure', async () => {
  const d = fakeDevice({ async gesture() { throw new Error('uitest refused'); } });
  await expect(executeAction(d, 'com.a', { kind: 'click', x: 1, y: 1 }))
    .rejects.toThrow(/uitest refused/);
});

it('waits without touching the device', async () => {
  const d = fakeDevice();
  const started = Date.now();
  await executeAction(d, 'com.a', { kind: 'wait', ms: 20 });
  expect(d.calls).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(15);
});

it('returns the device output for a marker-free action', async () => {
  const d = fakeDevice({ async shell() { return { stdout: 'StartAbility successfully', stderr: '', code: 0 }; } });
  expect(await executeAction(d, 'com.a', { kind: 'launch', ability: 'X' }))
    .toEqual({ output: 'StartAbility successfully' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit scenario-actions`
Expected: FAIL — cannot resolve `../src/scenario/actions`.

- [ ] **Step 3: Implement `packages/core/src/scenario/actions.ts`**

A `switch` over `action.kind`. `launch`/`forceStop` build the command and throw `OhosPerfError` with code `SCENARIO_ACTION_FAILED` on a non-zero exit, including the trimmed `stderr` (or `stdout`) — hdc can mask device exit codes for `uitest`, but `aa` reports its own and a failure must not be read as a launch. Gesture kinds delegate to `device.gesture(...)` unchanged (the driver owns quoting and the `No Error` check). `wait` is `setTimeout`. `marker` is handled by the runner, not here — `executeAction` throws `SCENARIO_BAD_ACTION` if it receives one, so the two layers cannot disagree about who records it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit scenario-actions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/actions.ts packages/core/test/scenario-actions.test.ts
git commit -m "feat(core): execute scenario actions against a device"
```

---

### Task 4: The runner

**Files:**
- Create: `packages/core/src/scenario/runner.ts`
- Test: `packages/core/test/scenario-runner.test.ts`

**Interfaces:**
- Consumes: `Scenario`/`ScenarioStep` (Task 1), `SceneStepRef` (Task 2), `executeAction` (Task 3).
- Produces:
  ```ts
  interface RunStepResult {
    readonly round: number;
    readonly index: number;
    readonly id: string;
    readonly name: string;
    readonly status: 'ok' | 'failed';
    /** Present only when a scene exists on disk. */
    readonly sceneDir?: string;
    readonly startedAtMs: number;
    readonly durationMs: number;
    readonly actions: readonly ActionOutcome[];
    readonly error?: string;
  }

  interface RunResult {
    readonly scenario: string;
    readonly app: string;
    readonly device: { id: string; kind: string };
    readonly rounds: number;
    readonly status: 'completed' | 'failed';
    readonly steps: readonly RunStepResult[];
    readonly startedAtMs: number;
    readonly durationMs: number;
    readonly pids: { pids: readonly number[]; processNames: readonly string[] };
    readonly appVersion?: string;
  }

  interface RunnerDevice {
    readonly id: string;
    readonly kind: string;
    shell(cmd: string): Promise<{ stdout: string; stderr: string; code: number }>;
    gesture(g: Gesture): Promise<GestureResult>;
    collect(opts: {
      app: string; durationMs: number; sceneRoot: string; step: SceneStepRef;
      procfs?: boolean; hiprofiler?: { plugins: readonly HiprofilerPluginName[] };
      hiperf?: { frequency?: number }; hidumper?: boolean; uitest?: boolean; hilog?: boolean;
    }): Promise<{ ingest(): Promise<{ close(): void }> }>;
  }

  interface RunOptions {
    readonly outDir: string;
    readonly rounds?: number;
    readonly only?: readonly string[];
    readonly keepGoing?: boolean;
    /** Injected clock, for tests; production leaves it unset. */
    readonly now?: () => number;
  }

  class ScenarioRunner {
    constructor(device: RunnerDevice, opts: RunOptions);
    run(scenario: Scenario): Promise<RunResult>;
  }

  /** Write `testInfo.json`, `steps.json`, `pids.json` for a result. */
  function writeRunFiles(outDir: string, result: RunResult): void;
  ```
  `collect` maps the step's `collectors` onto the collector flags: `hiprofiler` present selects `hiprofiler: { plugins }`, otherwise `hitrace`; `procfs`/`hiperf`/`hidumper`/`uitest`/`hilog` become their boolean flags. Task 1 already rejects a step naming both `hitrace` and `hiprofiler`.

- [ ] **Step 1: Write the failing test**

```ts
function fakeRunnerDevice(behaviour: { collect?: (o: any) => Promise<any>; shell?: (c: string) => any } = {}) {
  const calls: string[] = [];
  return {
    calls,
    id: '127.0.0.1:5555',
    kind: 'emulator',
    async shell(cmd: string) {
      calls.push(cmd);
      if (behaviour.shell) return behaviour.shell(cmd);
      if (cmd === 'cat /proc/uptime') return { stdout: '1000.00 200.00\n', stderr: '', code: 0 };
      if (cmd.startsWith('pidof ')) return { stdout: '4999 5012\n', stderr: '', code: 0 };
      if (cmd.startsWith('bm dump ')) return { stdout: '{"versionName":"1.0.0"}', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async gesture(g: any) { calls.push(`gesture:${g.action}`); return { gesture: g, output: 'No Error' }; },
    async collect(o: any) {
      calls.push(`collect:${o.sceneRoot}`);
      return { async ingest() {
        mkdirSync(o.sceneRoot, { recursive: true });
        writeFileSync(join(o.sceneRoot, 'trace.db'), '');
        return behaviour.collect ? behaviour.collect(o) : { close() {} };
      } };
    },
  };
}

const TWO_STEPS = parseScenario(JSON.stringify({
  version: 1, name: 'two', app: 'com.example.app', rounds: 2,
  steps: [
    { id: 'open', setup: [{ kind: 'launch', ability: 'EntryAbility' }],
      actions: [{ kind: 'click', x: 5, y: 6 }, { kind: 'marker', name: 'tapped' }],
      cleanup: [{ kind: 'forceStop' }],
      capture: { durationMs: 1000, collectors: ['hitrace'] } },
    { id: 'scroll', actions: [{ kind: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4 }],
      capture: { durationMs: 1000, collectors: ['hitrace'] } },
  ],
}));

it('runs every (round, step) pair in scenario order and writes a scene each', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice();
  const result = await new ScenarioRunner(device, { outDir: out }).run(TWO_STEPS);
  expect(result.steps.map((s) => `${s.round}:${s.id}`)).toEqual(['1:open', '1:scroll', '2:open', '2:scroll']);
  expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
  for (const step of result.steps) {
    expect(existsSync(join(step.sceneDir!, 'trace.db'))).toBe(true);
    expect(step.sceneDir).toBe(join(out, step.id, `round-${step.round}`));
  }
  expect(result.status).toBe('completed');
});

it('runs setup before the capture starts and cleanup after it', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const order: string[] = [];
  const device = fakeRunnerDevice();
  const collect = device.collect.bind(device);
  device.collect = async (o) => { order.push('capture-start'); return collect(o); };
  const shell = device.shell.bind(device);
  device.shell = async (cmd) => { order.push(cmd); return shell(cmd); };
  const gesture = device.gesture.bind(device);
  device.gesture = async (g) => { order.push(`gesture:${g.action}`); return gesture(g); };
  await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
  const aaStart = order.findIndex((e) => e.startsWith('aa start'));
  const start = order.indexOf('capture-start');
  const click = order.findIndex((e) => e === 'gesture:click');
  const forceStop = order.findIndex((e) => e.startsWith('aa force-stop'));
  expect(aaStart).toBeLessThan(start);
  expect(start).toBeLessThan(click);
  expect(click).toBeLessThan(forceStop);
});

it('records the marker with its device-uptime instant and no device call', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice();
  const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
  const open = result.steps[0];
  const marker = open.actions.find((a) => a.action.kind === 'marker')!;
  expect(marker.ok).toBe(true);
  expect(marker.atNs).toBe(1_000_000_000_000);
  expect(device.calls.filter((c) => c.includes('marker'))).toEqual([]);
});

it('keeps the scene when an action fails, and fails the step', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice();
  device.gesture = async () => { throw new Error('uitest refused'); };
  const result = await new ScenarioRunner(device, { outDir: out, rounds: 1, keepGoing: true }).run(TWO_STEPS);
  expect(result.steps[0].status).toBe('failed');
  expect(result.steps[0].error).toMatch(/uitest refused/);
  expect(existsSync(join(result.steps[0].sceneDir!, 'trace.db'))).toBe(true);
  expect(result.status).toBe('failed');
});

it('runs cleanup after a failed action and does not mask its error', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice();
  device.gesture = async () => { throw new Error('first failure'); };
  const shell = device.shell.bind(device);
  device.shell = async (cmd) => {
    if (cmd.startsWith('aa force-stop')) return { stdout: '', stderr: 'cleanup broke', code: 3 };
    return shell(cmd);
  };
  const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
  expect(result.steps[0].error).toMatch(/first failure/);
  expect(device.calls.some((c) => c.startsWith('aa force-stop'))).toBe(true);
});

it('stops at the first failure unless keepGoing', async () => {
  const failing = () => {
    const device = fakeRunnerDevice();
    device.gesture = async () => { throw new Error('boom'); };
    return device;
  };
  const strict = await new ScenarioRunner(failing(), { outDir: mkdtempSync(join(tmpdir(), 'run-')), rounds: 1 })
    .run(TWO_STEPS);
  // `open` fails on its click, so `scroll` never starts.
  expect(strict.steps.map((s) => s.id)).toEqual(['open']);

  const loose = await new ScenarioRunner(failing(), { outDir: mkdtempSync(join(tmpdir(), 'run-')), rounds: 1, keepGoing: true })
    .run(TWO_STEPS);
  // Both steps fail, both are recorded, and the run reports failure.
  expect(loose.steps.map((s) => s.id)).toEqual(['open', 'scroll']);
  expect(loose.steps.every((s) => s.status === 'failed')).toBe(true);
  expect(loose.status).toBe('failed');
});

it('reports no sceneDir when the capture itself failed', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice();
  device.collect = async () => ({ async ingest() { throw new Error('trace capture failed'); } });
  const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
  expect(result.steps[0].status).toBe('failed');
  expect(result.steps[0]).not.toHaveProperty('sceneDir');
});

it('resolves pids once and omits an app version the device will not give', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const device = fakeRunnerDevice({ shell: (cmd) => cmd.startsWith('bm dump ')
    ? { stdout: 'error: bundle not found', stderr: '', code: 1 }
    : { stdout: '', stderr: '', code: 0 } });
  // The pids still resolve through the default table.
  const result = await new ScenarioRunner(device, { outDir: out, rounds: 1 }).run(TWO_STEPS);
  expect(result.appVersion).toBeUndefined();
  expect(result.pids).toEqual({ pids: [], processNames: ['com.example.app'] });
});

it('runs only the requested steps, in scenario order', async () => {
  const out = mkdtempSync(join(tmpdir(), 'run-'));
  const result = await new ScenarioRunner(fakeRunnerDevice(), { outDir: out, rounds: 1, only: ['scroll', 'open'] })
    .run(TWO_STEPS);
  expect(result.steps.map((s) => s.id)).toEqual(['open', 'scroll']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit scenario-runner`
Expected: FAIL — cannot resolve `../src/scenario/runner`.

- [ ] **Step 3: Implement `packages/core/src/scenario/runner.ts`**

Per (round, step):

1. `mkdirSync(sceneDir, { recursive: true })`.
2. Run `setup` in order. The first failure ends the step with `status: 'failed'`, `error`, and **no** `sceneDir` — no capture ran.
3. `device.collect({...})`; capture the session. Then start `session.ingest()` and hold the promise — do **not** await it yet.
4. Run `actions` in order. `marker` records `atNs`/`atMs` and succeeds without a device call. Any other action goes through `executeAction`. The first failure is remembered and stops the remaining actions.
5. `await` the ingest promise, guarding it with a `catch` that records the error so it is never unhandled. On success set `sceneDir` and `close()` the scene handle.
6. Run `cleanup` in order, always, swallowing (but recording into the step's action list as `ok: false`) a cleanup failure. A cleanup failure marks the step failed only when nothing else already did.
7. `status` is `failed` if setup, an action, the capture or cleanup failed; `error` is the first failure's message.

Before the loops: `pidof <app>` once (`pids`, `[]` on no output — never an error), `bm dump -n <app>` once (`appVersion` from `versionName` when the JSON parses and the field is a string; absent otherwise), and `Date.now()` once for `startedAtMs`.

The `only` filter is applied by walking `scenario.steps` and keeping the ones whose id is in the set, so order is scenario order; an id in `only` that matches no step throws `SCENARIO_BAD_INPUT` naming the available ids — but that validation belongs in Task 5's CLI path too; put it in `ScenarioRunner.run` so both callers get it.

`writeRunFiles(outDir, result)` writes `testInfo.json` (the run-level fields), `steps.json` (`{ version: 1, steps: [...] }`) and `pids.json`, each `JSON.stringify(x, null, 2) + '\n'`. `run()` calls it before returning, on both the success and failure paths.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit scenario-runner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/runner.ts packages/core/test/scenario-runner.test.ts
git commit -m "feat(core): run scenario steps with per-step capture windows"
```

---

### Task 5: CLI command and exports

**Files:**
- Create: `packages/cli/src/run.ts`
- Modify: `packages/cli/src/commands.ts` (add `RunRequest`/`RunOutput`, `runScenarioCommand`, `CliDeps.run`)
- Modify: `packages/cli/src/deps.ts` (wire `run`)
- Modify: `packages/cli/src/program.ts` (`run` command)
- Modify: `packages/core/src/index.ts` (exports)
- Test: `packages/cli/test/run.test.ts`

**Interfaces:**
- Consumes: `parseScenario`, `ScenarioRunner`, `RunResult` (Tasks 1, 4).
- Produces:
  ```ts
  interface RunRequest {
    /** The parsed document; reading and parsing happen in the pure CLI layer. */
    scenario: Scenario;
    /** Only for `testInfo.json`'s `scenario` field and error wording. */
    scenarioPath: string;
    outDir: string; target?: string;
    rounds?: number; only?: string[]; keepGoing?: boolean;
  }
  // CliDeps gains: run(req: RunRequest): Promise<RunResult>
  // runScenarioCommand(deps, { scenarioPath, outDir, ... }, { json }) reads,
  // parses, then calls deps.run — so an invalid document never reaches a device.
  ```
  Core `index.ts` exports `parseScenario`, `ScenarioRunner`, `executeAction`, `writeRunFiles`, and the types `Scenario`, `ScenarioStep`, `ScenarioAction`, `StepCapture`, `CollectorName`, `SceneStepRef`, `RunResult`, `RunStepResult`, `ActionOutcome`.

- [ ] **Step 1: Write the failing test**

```ts
it('rejects an unreadable scenario before connecting to a device', async () => {
  let connected = false;
  const deps = { ...fakeDeps(), run: async () => { connected = true; throw new Error('unreachable'); } };
  const result = await runScenarioCommand(deps, { scenarioPath: '/nope.json', outDir: '/tmp/x' }, {});
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/scenario/i);
  expect(connected).toBe(false);
});

it('prints one line per step and a summary', async () => {
  const result = await runScenarioCommand(fakeDeps(), req, {});
  expect(result.stdout).toMatch(/ok\s+open\s+round 1\s+/);
  expect(result.stdout).toMatch(/steps 2\/2 ok/);
});

it('exits 1 when a step failed but still prints the summary', async () => {
  const result = await runScenarioCommand(failingDeps(), req, {});
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toMatch(/failed\s+open/);
  expect(result.stderr).toBe('');
});

it('--json is the RunResult', async () => {
  const result = await runScenarioCommand(fakeDeps(), req, { json: true });
  expect(JSON.parse(result.stdout).steps).toHaveLength(2);
});
```

Plus a `program.test.ts` case: `run <scenario> --out <dir>` parses `--rounds`, `--only` (comma-split, trimmed, empty element rejected), `--keep-going`, `--target`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit run.test`
Expected: FAIL — `runScenarioCommand` is not exported.

- [ ] **Step 3: Implement**

`run.ts` holds `parseOnly(raw)` (comma-split, trim, reject an empty element with a message naming it). `commands.ts` gets `runScenarioCommand`: it reads the scenario file, parses it (a parse failure is exit 1 with empty stdout), calls `deps.run`, and renders either JSON or the per-step lines plus `steps <ok>/<total> ok` / `steps <ok>/<total> ok, <n> failed`. Exit 1 when `result.status === 'failed'`; stderr stays empty because the failure is in the report, not in the invocation.

`runScenarioCommand` reads the file and calls `parseScenario` itself — it is a pure function over a path, which is what makes the "no device is touched" guarantee testable — and then hands the parsed `Scenario` to `deps.run({ scenario, scenarioPath, ... })`. `deps.ts` `run` only connects and runs: `connect(target)` → `new ScenarioRunner(device, {...}).run(req.scenario)`. A `readFileSync` failure is an `OhosPerfError` with code `SCENARIO_UNREADABLE` naming the path, so a typo and a malformed document read differently.

`program.ts`: `.command('run')`, `.argument('<scenario>')`, `.requiredOption('--out <dir>')`, `--target`, `--rounds <n>` (positive integer, parsed in the action), `--only <ids>`, `--keep-going`, `--json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit run.test` then `npx vitest run --project unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/run.ts packages/cli/src/commands.ts packages/cli/src/deps.ts packages/cli/src/program.ts packages/core/src/index.ts packages/cli/test/run.test.ts
git commit -m "feat(cli): run declarative scenarios with per-step captures"
```

---

### Task 6: Device acceptance, docs, site, skill, release 0.8.0

**Files:**
- Create: `packages/core/test/scenario-run.device.test.ts`
- Modify: `README.md`, `site/index.html`, `site/styles.css`, `skill/ohos-perf/SKILL.md`, `CHANGELOG.md`
- Modify: `package.json` (root), `packages/core/package.json`, `packages/cli/package.json`, `package-lock.json`

- [ ] **Step 1: Write the device test** (skipped without a device)

A two-step scenario against the emulator (`127.0.0.1:5555` when attached): step 1 waits 1000 ms, step 2 waits 1000 ms with `hilog`; assert two scene directories, each with `trace.db`, and each `scene.json` carrying `step: { round: 1, index: N, id }`. Mark it `describe.skipIf` on no attached target, following `collect-capture.device.test.ts`.

- [ ] **Step 2: Run it**

Run: `npx vitest run --project device scenario-run`
Expected: PASS with the emulator attached; skipped otherwise. Record which in the ledger.

- [ ] **Step 3: Update docs**

`README.md`: a `## Scenarios` section (document shape, three phases, rounds, `--only`, `--keep-going`, the run directory, and that a step is a scene); roadmap P13 → `shipped in 0.8.0`; the test count and capability claims unchanged (no new capability).

`site/index.html`: a P13 card, roadmap row, and a short scenarios paragraph in both languages.

`skill/ohos-perf/SKILL.md`: a `## Scenarios` section — when to use `run` instead of `collect`, the action list, that actions run inside the capture window, that a failed action keeps the scene, and that each step directory is analyzable with the existing commands.

`CHANGELOG.md`: `## 0.8.0 — 2026-11-17` with Features and Semantics.

- [ ] **Step 4: Bump and verify**

Bump the three manifests and the cli→core pin, run `npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli`, `npm run test:unit`, `npm run typecheck -w @ohos-perf/core`, `npm run typecheck -w @ohos-perf/cli`.

- [ ] **Step 5: Commit and release**

```bash
git add -A
git commit -m "feat(cli): run scenarios and release 0.8.0"
git tag v0.8.0 && git push origin master --tags
```
Then create the GitHub release.
