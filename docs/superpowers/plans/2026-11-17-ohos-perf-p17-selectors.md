# P17 Selector-Driven Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a scenario name UI components instead of coordinates, and let a step assert what the screen showed, so a scenario survives a different device and a step's status means something.

**Architecture:** `src/scenario/selector.ts` matches nodes in a flattened `UiNode[]` and resolves a `Selector` to one node deterministically. `src/scenario/schema.ts` gains the selector union, four selector actions and an `expect` block, all validated at load. `src/scenario/actions.ts` gains a resolver that reads a fresh dump through the device's `uitest` path. `src/scenario/runner.ts` evaluates `expect` after the actions and records the outcome in `steps.json`. `src/scenario/cases.ts` discovers scenario files for `run --cases`.

**Tech Stack:** TypeScript ESM, zero runtime dependencies, `node:fs` only. UI trees come from the existing `flattenUiTree`/`readUiTree` in `src/query/ui.ts`.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p17-selectors-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`.
- Determinism (D5): identical inputs produce byte-identical artifacts. No `Date.now()`, no absolute host path inside a document, no locale-dependent sort.
- Every refusal is a typed `OhosPerfError` with a code from the spec's table.
- `packages/core/src/index.ts` is the public surface: every new exported value goes into `packages/core/test/types.test.ts`'s `VALUE_EXPORTS`.
- Core must be rebuilt (`npm run build -w @ohos-perf/core`) before the CLI sees a src change; `types.test.ts` enforces dist freshness.
- Scenario schema `version` stays `1`. Existing coordinate actions keep working.
- The device capability matrix keeps exactly 23 rows; P17 adds no capability id.
- Unit suite: `npm run test:unit`. Typecheck: `npm run typecheck -w @ohos-perf/core` and `-w @ohos-perf/cli`.

## Review Focus

- **A selector that matches a node whose `bounds` did not parse.** Tapping it must be a typed refusal (`SCENARIO_SELECTOR_NO_MATCH` naming the unparsed bounds), never a tap at `(0,0)`.
- **`not` inside `any` inside `all`.** Complement must be scoped to the candidate set the enclosing combinator produced, not the whole tree.
- **A step whose actions succeed but whose `expect` fails.** Status `failed`, `sceneDir` still named, error names the assertion and the actual count.
- **`--cases` over a directory holding one malformed scenario.** The good files still run; the index records which failed to load and why.
- **A scroll that reaches the end of the list.** The runner stops at the scrollable's edge rather than swiping `maxScrolls` times blindly.

---

### Task 1: Selector type, validation, and matching

**Files:**
- Create: `packages/core/src/scenario/selector.ts`
- Test: `packages/core/test/scenario-selector.test.ts` (create)

**Interfaces:**
- Consumes: `UiNode` from `../query/ui`.
- Produces:
  ```ts
  export type Selector =
    | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean }
    | { readonly kind: 'id'; readonly id: string }
    | { readonly kind: 'type'; readonly type: string }
    | { readonly kind: 'clickable' }
    | { readonly kind: 'all'; readonly of: readonly Selector[] }
    | { readonly kind: 'any'; readonly of: readonly Selector[] }
    | { readonly kind: 'not'; readonly of: Selector }
    | { readonly kind: 'index'; readonly of: Selector; readonly index: number }
    | {
        readonly kind: 'bounds';
        readonly of: Selector;
        readonly within: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
      }
    | {
        readonly kind: 'relative';
        readonly of: Selector;
        readonly relation: 'above' | 'below' | 'leftOf' | 'rightOf';
        readonly to: Selector;
      };

  /** Validate one selector from parsed JSON; `path` names it in the error. */
  export function parseSelector(value: unknown, path: string): Selector;

  /** Every node the selector matches, in document order with geometry tie-breaks. */
  export function matchSelector(nodes: readonly UiNode[], selector: Selector): UiNode[];

  /** The one node a selector names; throws when it matches zero or many. */
  export function resolveSelector(nodes: readonly UiNode[], selector: Selector, label: string): UiNode;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/scenario-selector.test.ts
import { describe, it, expect } from 'vitest';
import { matchSelector, parseSelector, resolveSelector } from '../src/scenario/selector';
import { OhosPerfError } from '../src/errors';
import type { UiNode } from '../src/query/ui';

function node(over: Partial<UiNode> & { bounds?: string }): UiNode {
  const bounds = over.bounds ?? '[0,0][100,100]';
  return {
    depth: 0, type: 'Button', bundleName: 'com.demo', abilityName: 'Entry',
    text: '', id: '', bounds, clickable: false, enabled: true, scrollable: false,
    children: 0,
    boundsRect: { left: 0, top: 0, right: 100, bottom: 100 },
    ...over,
  };
}

describe('parseSelector', () => {
  it('accepts every documented kind', () => {
    expect(parseSelector({ kind: 'text', text: 'OK' }, 's').kind).toBe('text');
    expect(parseSelector({ kind: 'id', id: 'btn' }, 's').kind).toBe('id');
    expect(parseSelector({ kind: 'type', type: 'Button' }, 's').kind).toBe('type');
    expect(parseSelector({ kind: 'clickable' }, 's').kind).toBe('clickable');
  });

  it('refuses an empty text, which would match every node', () => {
    expect(() => parseSelector({ kind: 'text', text: '' }, 'steps[0].target'))
      .toThrow(/steps\[0\]\.target/);
  });

  it('refuses an unknown kind and names the path', () => {
    expect(() => parseSelector({ kind: 'xpath', xpath: '//a' }, 'steps[1].target'))
      .toThrow(OhosPerfError);
  });

  it('refuses a negative index', () => {
    expect(() => parseSelector({ kind: 'index', of: { kind: 'type', type: 'X' }, index: -1 }, 's'))
      .toThrow(/index/);
  });
});

describe('matchSelector', () => {
  const nodes = [
    node({ text: 'OK', id: 'ok', bounds: '[0,0][100,100]' }),
    node({ text: 'Cancel', id: 'cancel', bounds: '[0,200][100,300]' }),
    node({ text: 'OK', id: 'ok2', bounds: '[0,400][100,500]' }),
  ];

  it('matches text case-insensitively as a substring by default', () => {
    expect(matchSelector(nodes, { kind: 'text', text: 'ok' })).toHaveLength(2);
  });

  it('matches text exactly when asked', () => {
    expect(matchSelector(nodes, { kind: 'text', text: 'ok', exact: true })).toHaveLength(0);
    expect(matchSelector(nodes, { kind: 'text', text: 'OK', exact: true })).toHaveLength(2);
  });

  it('intersects with all and unions with any', () => {
    const ok = { kind: 'text', text: 'OK' } as const;
    const cancel = { kind: 'text', text: 'Cancel' } as const;
    expect(matchSelector(nodes, { kind: 'all', of: [ok, cancel] })).toHaveLength(0);
    expect(matchSelector(nodes, { kind: 'any', of: [ok, cancel] })).toHaveLength(3);
  });

  it('scopes not to the candidate set, not the whole tree', () => {
    // `all: [text OK, not id ok2]` must drop only ok2, not every non-OK node.
    const matched = matchSelector(nodes, {
      kind: 'all',
      of: [{ kind: 'text', text: 'OK' }, { kind: 'not', of: { kind: 'id', id: 'ok2' } }],
    });
    expect(matched.map((n) => n.id)).toEqual(['ok']);
  });

  it('selects one node by index in document order', () => {
    const matched = matchSelector(nodes, {
      kind: 'index', of: { kind: 'text', text: 'OK' }, index: 1,
    });
    expect(matched.map((n) => n.id)).toEqual(['ok2']);
  });

  it('restricts by bounds', () => {
    const matched = matchSelector(nodes, {
      kind: 'bounds',
      of: { kind: 'type', type: 'Button' },
      within: { left: 0, top: 150, right: 200, bottom: 350 },
    });
    expect(matched.map((n) => n.id)).toEqual(['cancel']);
  });

  it('relates to the first node matching the anchor', () => {
    const matched = matchSelector(nodes, {
      kind: 'relative',
      of: { kind: 'type', type: 'Button' },
      relation: 'below',
      to: { kind: 'id', id: 'ok' },
    });
    // Below the FIRST 'ok' (top 0): cancel (200) and ok2 (400).
    expect(matched.map((n) => n.id)).toEqual(['cancel', 'ok2']);
  });
});

describe('resolveSelector', () => {
  it('throws NO_MATCH naming the label when nothing matches', () => {
    const err = (() => {
      try { resolveSelector([], { kind: 'text', text: 'x' }, 'target'); }
      catch (e) { return e as OhosPerfError; }
    })();
    expect(err?.code).toBe('SCENARIO_SELECTOR_NO_MATCH');
    expect(err?.message).toContain('target');
  });

  it('throws AMBIGUOUS when more than one matches', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const err = (() => {
      try { resolveSelector(nodes, { kind: 'type', type: 'Button' }, 'target'); }
      catch (e) { return e as OhosPerfError; }
    })();
    expect(err?.code).toBe('SCENARIO_SELECTOR_AMBIGUOUS');
    expect(err?.message).toContain('2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/scenario-selector.test.ts`
Expected: FAIL — cannot resolve `../src/scenario/selector`.

- [ ] **Step 3: Implement `selector.ts`**

`parseSelector` is a hand-written recursive validator mirroring `schema.ts`'s style: it takes the JSON value and a path, and every rejection message starts with that path. `matchSelector` computes candidates: `text`/`id`/`type`/`clickable` filter the input; `all` intersects successive results starting from the full input; `any` unions; `not` filters the input (its candidate set) by the complement of `of`; `index` sorts the input by document order then `(left, top, right, bottom)` then `nodeIdentity` and takes one; `bounds` filters by rect containment of the node's centre; `relative` resolves `to` to its first match (in the same deterministic order) and filters `of` by the geometric relation using `boundsRect` — a node with no `boundsRect` never satisfies a relation. `resolveSelector` throws `SCENARIO_SELECTOR_NO_MATCH` for zero and `SCENARIO_SELECTOR_AMBIGUOUS` for many, both naming `label` and the count.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/scenario-selector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/selector.ts packages/core/test/scenario-selector.test.ts
git commit -m "feat(core): match UI nodes by selector, not coordinates"
```

---

### Task 2: Schema — selector actions and `expect`

**Files:**
- Modify: `packages/core/src/scenario/schema.ts`
- Test: `packages/core/test/scenario-schema.test.ts` (update)

**Interfaces:**
- Consumes: `Selector`, `parseSelector` from `./selector`.
- Produces: the four new `ScenarioAction` variants and `StepExpectation`; `ScenarioStep` gains `readonly expect?: StepExpectation`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/scenario-schema.test.ts`:

```ts
it('accepts the four selector actions', () => {
  const scenario = parseScenario({
    version: 1, name: 's', app: 'com.demo', rounds: 1,
    steps: [{
      id: 'tap-ok', name: 'tap OK',
      capture: { durationMs: 1000, collectors: ['hitrace'] },
      setup: [], cleanup: [],
      actions: [
        { kind: 'tap', target: { kind: 'text', text: 'OK' } },
        { kind: 'tapText', text: 'Cancel' },
        { kind: 'swipeArea', area: { kind: 'type', type: 'List' }, direction: 'up' },
        { kind: 'inputInto', target: { kind: 'id', id: 'field' }, text: 'hello' },
      ],
    }],
  }, 'doc');
  const actions = scenario.steps[0]!.actions;
  expect(actions.map((a) => a.kind)).toEqual(['tap', 'tapText', 'swipeArea', 'inputInto']);
});

it('accepts an expect block', () => {
  const scenario = parseScenario({
    version: 1, name: 's', app: 'com.demo', rounds: 1,
    steps: [{
      id: 'a', name: 'a',
      capture: { durationMs: 1000, collectors: ['hitrace'] },
      setup: [], cleanup: [], actions: [{ kind: 'wait', ms: 10 }],
      expect: {
        present: [{ selector: { kind: 'text', text: 'Done' }, min: 1 }],
        absent: [{ kind: 'id', id: 'spinner' }],
        foreground: true,
      },
    }],
  }, 'doc');
  expect(scenario.steps[0]!.expect?.present).toHaveLength(1);
});

it('refuses a selector action with a malformed selector, naming its path', () => {
  expect(() => parseScenario({
    version: 1, name: 's', app: 'com.demo', rounds: 1,
    steps: [{
      id: 'a', name: 'a',
      capture: { durationMs: 1000, collectors: ['hitrace'] },
      setup: [], cleanup: [],
      actions: [{ kind: 'tap', target: { kind: 'text', text: '' } }],
    }],
  }, 'doc')).toThrow(/steps\[0\]\.actions\[0\]\.target/);
});

it('refuses an unknown key inside expect', () => {
  expect(() => parseScenario({
    version: 1, name: 's', app: 'com.demo', rounds: 1,
    steps: [{
      id: 'a', name: 'a',
      capture: { durationMs: 1000, collectors: ['hitrace'] },
      setup: [], cleanup: [], actions: [{ kind: 'wait', ms: 10 }],
      expect: { presentt: [] },
    }],
  }, 'doc')).toThrow(/expect/);
});

it('still accepts a coordinate-only scenario', () => {
  const scenario = parseScenario({
    version: 1, name: 's', app: 'com.demo', rounds: 1,
    steps: [{
      id: 'a', name: 'a',
      capture: { durationMs: 1000, collectors: ['hitrace'] },
      setup: [], cleanup: [],
      actions: [{ kind: 'click', x: 10, y: 20 }],
    }],
  }, 'doc');
  expect(scenario.steps[0]!.actions[0]!.kind).toBe('click');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/scenario-schema.test.ts`
Expected: FAIL — unknown action kind `tap`.

- [ ] **Step 3: Implement the schema additions**

Extend the `ScenarioAction` union with the four variants (each selector parsed through `parseSelector` with the full JSON path). Add `StepExpectation` and parse it from the step's `expect` key, refusing unknown keys there exactly as the step object does. Add `expect` to `ScenarioStep` and to the step's allowed-keys list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/scenario-schema.test.ts`
Expected: PASS, and every pre-existing test in that file still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/schema.ts packages/core/test/scenario-schema.test.ts
git commit -m "feat(core): validate selector actions and step expectations"
```

---

### Task 3: Resolving actions against a live dump

**Files:**
- Modify: `packages/core/src/scenario/actions.ts`
- Test: `packages/core/test/scenario-actions.test.ts` (update)

**Interfaces:**
- Consumes: `Selector`, `resolveSelector` from `./selector`; `flattenUiTree` from `../query/ui`.
- Produces: `ActionDevice` gains `readonly uiTree?: () => Promise<UiNode[]>`; `executeAction` gains an optional `context: { readonly dump: () => Promise<UiNode[]> }` and resolves selector actions through it.

- [ ] **Step 1: Write the failing test**

```ts
it('taps the centre of the selected node', async () => {
  const gestures: Gesture[] = [];
  const device = {
    id: 'd', shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    gesture: async (g: Gesture) => { gestures.push(g); return { output: '' }; },
  };
  const dump = async () => [node({ id: 'ok', bounds: '[100,200][300,400]' })];
  await executeAction(device, 'com.demo', { kind: 'tap', target: { kind: 'id', id: 'ok' } }, { dump });
  expect(gestures[0]).toEqual({ action: 'click', x: 200, y: 300 });
});

it('refuses to tap a node whose bounds did not parse', async () => {
  const device = { id: 'd', shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    gesture: async () => ({ output: '' }) };
  const dump = async () => [{ ...node({ id: 'ok' }), boundsRect: undefined, bounds: 'weird' }];
  const err = await executeAction(device, 'com.demo',
    { kind: 'tap', target: { kind: 'id', id: 'ok' } }, { dump }).catch((e) => e);
  expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
});

it('scrolls a container until the target appears', async () => {
  let scrolls = 0;
  const device = { id: 'd', shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    gesture: async (g: Gesture) => { if (g.action === 'swipe') scrolls += 1; return { output: '' }; } };
  const dumps = [
    [node({ id: 'list', type: 'List', scrollable: true, bounds: '[0,0][100,1000]' })],
    [node({ id: 'list', type: 'List', scrollable: true, bounds: '[0,0][100,1000]' }), node({ id: 'item' })],
  ];
  let i = 0;
  const dump = async () => dumps[Math.min(i++, dumps.length - 1)]!;
  await executeAction(device, 'com.demo', {
    kind: 'tap',
    target: { kind: 'id', id: 'item' },
    scrollTo: { kind: 'id', id: 'list' },
  }, { dump });
  expect(scrolls).toBe(1);
});

it('fails after maxScrolls and names the count', async () => {
  const device = { id: 'd', shell: async () => ({ stdout: '', stderr: '', code: 0 }),
    gesture: async () => ({ output: '' }) };
  const dump = async () => [node({ id: 'list', type: 'List', scrollable: true, bounds: '[0,0][100,1000]' })];
  const err = await executeAction(device, 'com.demo', {
    kind: 'tap', target: { kind: 'id', id: 'nope' },
    scrollTo: { kind: 'id', id: 'list' }, timeoutMs: 10,
  }, { dump }).catch((e) => e);
  expect(err).toMatchObject({ code: 'SCENARIO_SELECTOR_NO_MATCH' });
  expect((err as Error).message).toContain('5');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/scenario-actions.test.ts`
Expected: FAIL — `tap` falls into the unknown-action branch.

- [ ] **Step 3: Implement resolution**

Add `resolveTap(device, context, selector, label)` that reads a dump, resolves the selector, refuses when `boundsRect` is missing (message names the raw `bounds` string), and returns the centre point. `tap` calls it, then `device.gesture({ action: 'click', x, y })`. When `scrollTo` is present and the first dump misses, resolve the container, require `scrollable`, and loop: swipe from 70% to 30% of the container's height (or width, for `left`/`right`) up to `MAX_SCROLLS = 5` times, re-dumping each time, stopping early when the target appears or when the dump is unchanged from the previous one (the list has reached its edge). `swipeArea` resolves the area and swipes inside it. `inputInto` taps the centre, then `device.gesture({ action: 'inputText', … })` — or `text` after a tap, matching what `GestureDriver` supports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/scenario-actions.test.ts`
Expected: PASS, with the existing coordinate-action tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/actions.ts packages/core/test/scenario-actions.test.ts
git commit -m "feat(core): resolve tap and swipe actions from a UI dump"
```

---

### Task 4: Assertions in the runner

**Files:**
- Modify: `packages/core/src/scenario/runner.ts`
- Test: `packages/core/test/scenario-runner.test.ts` (update)

**Interfaces:**
- Consumes: `matchSelector` from `./selector`; `StepExpectation` from `./schema`.
- Produces: `RunStepResult` gains `readonly expectations?: readonly ExpectationOutcome[]`; `ExpectationOutcome` is `{ readonly label: string; readonly ok: boolean; readonly actual: number; readonly detail?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
it('fails a step whose assertion does not hold, and still names its scene', async () => {
  const device = fakeDevice({ dump: async () => [node({ id: 'other' })] });
  const runner = new ScenarioRunner(device, { outDir: dir });
  const result = await runner.run(scenarioWithExpect({
    present: [{ selector: { kind: 'text', text: 'Done' } }],
  }));
  const step = result.steps[0]!;
  expect(step.status).toBe('failed');
  expect(step.sceneDir).toBeDefined();
  expect(step.error).toContain('Done');
  expect(step.expectations?.[0]).toMatchObject({ ok: false, actual: 0 });
});

it('passes a step whose assertions hold', async () => {
  const device = fakeDevice({ dump: async () => [node({ text: 'Done' })] });
  const result = await new ScenarioRunner(device, { outDir: dir }).run(scenarioWithExpect({
    present: [{ selector: { kind: 'text', text: 'Done' } }],
    absent: [{ kind: 'id', id: 'spinner' }],
  }));
  expect(result.steps[0]!.status).toBe('ok');
  expect(result.steps[0]!.expectations?.every((e) => e.ok)).toBe(true);
});

it('enforces min and max on present', async () => {
  const device = fakeDevice({ dump: async () => [node({ text: 'row' }), node({ text: 'row' })] });
  const result = await new ScenarioRunner(device, { outDir: dir }).run(scenarioWithExpect({
    present: [{ selector: { kind: 'text', text: 'row' }, min: 1, max: 1 }],
  }));
  expect(result.steps[0]!.status).toBe('failed');
  expect(result.steps[0]!.error).toContain('2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/scenario-runner.test.ts`
Expected: FAIL — `expectations` is undefined.

- [ ] **Step 3: Implement evaluation**

After the action loop and before cleanup, when `step.expect` is present, read one dump and evaluate: each `present` entry matches at least `min ?? 1` and at most `max ?? Infinity`; each `absent` selector matches zero; `foreground` (default true) checks that the dump contains at least one node whose `bundleName` equals the scenario's app. Record an `ExpectationOutcome` per clause with a label naming the selector, the actual count, and a `detail` sentence for a failure. The first failure sets `failure` only when nothing else has. Add `expectations` to `RunStepResult` and to `steps.json` (it is already serialized whole).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/scenario-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/runner.ts packages/core/test/scenario-runner.test.ts
git commit -m "feat(core): evaluate step expectations against the screen"
```

---

### Task 5: Case discovery and `run --cases`

**Files:**
- Create: `packages/core/src/scenario/cases.ts`
- Modify: `packages/cli/src/program.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/commands.ts`
- Test: `packages/core/test/scenario-cases.test.ts` (create)

**Interfaces:**
- Consumes: `parseScenario`, `Scenario` from `./schema`.
- Produces:
  ```ts
  export interface DiscoveredCase {
    readonly id: string;          // file stem, e.g. `scroll` from `scroll.scenario.json`
    readonly path: string;
  }
  export interface CaseLoad {
    readonly id: string;
    readonly path: string;
    readonly scenario?: Scenario;
    readonly error?: string;
  }
  export function discoverCases(dir: string, filter?: string): DiscoveredCase[];
  export function loadCases(cases: readonly DiscoveredCase[]): CaseLoad[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
it('discovers *.scenario.json in name order', () => {
  write('b.scenario.json', validScenario('b'));
  write('a.scenario.json', validScenario('a'));
  write('notes.txt', 'x');
  expect(discoverCases(dir).map((c) => c.id)).toEqual(['a', 'b']);
});

it('anchors the filter and refuses when nothing matches', () => {
  write('scroll.scenario.json', validScenario('scroll'));
  write('tap.scenario.json', validScenario('tap'));
  expect(discoverCases(dir, '^scroll$').map((c) => c.id)).toEqual(['scroll']);
  expect(() => discoverCases(dir, '^nothing$')).toThrow(/SCENARIO_CASES_EMPTY|matched no case/);
});

it('keeps the good cases when one file is malformed', () => {
  write('good.scenario.json', validScenario('good'));
  write('bad.scenario.json', '{ not json');
  const loads = loadCases(discoverCases(dir));
  expect(loads.find((l) => l.id === 'good')?.scenario).toBeDefined();
  expect(loads.find((l) => l.id === 'bad')?.error).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/scenario-cases.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement discovery, then wire the CLI**

`discoverCases` reads the directory, keeps entries ending in `.scenario.json`, sorts by id, and throws `SCENARIO_CASES_EMPTY` when the result is empty or the filter matched none. `loadCases` parses each file, keeping a `CaseLoad` with either the scenario or the error message — one bad file never hides the rest. In the CLI, `run` accepts `--cases <dir>` and `--filter <regex>` as an alternative to the positional scenario; it runs each case into `<out>/<caseId>/`, writes `<out>/cases.json` with the per-case status and error, and exits 1 when any case failed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/scenario-cases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/cases.ts packages/core/test/scenario-cases.test.ts packages/cli/src
git commit -m "feat: run a directory of scenario cases"
```

---

### Task 6: Exports, docs, and release

**Files:**
- Modify: `packages/core/src/index.ts`, `packages/core/test/types.test.ts`, `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `parseSelector`, `matchSelector`, `resolveSelector`, `discoverCases`, `loadCases` and the `Selector` type on the public surface.

- [ ] **Step 1: Write the failing test**

Add the new names to `VALUE_EXPORTS` in `types.test.ts` and assert they are functions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/types.test.ts`
Expected: FAIL — export missing.

- [ ] **Step 3: Export, document, and bump**

Export the five values and the type from `index.ts`. Document the selector language and `expect` in README (with one worked example) and SKILL.md (so an agent knows to prefer selectors over coordinates). Add the 0.12.0 CHANGELOG entry and move rows 1, 2, 3, 6, 7 in the parity narrative. Update site's roadmap with the P17 card and re-measured test counts.

- [ ] **Step 4: Run the whole suite**

Run: `npm run build -w @ohos-perf/core && npm run build -w @ohos-perf/cli && npm run test:unit`
Expected: PASS, counts re-measured and written into README and site.

- [ ] **Step 5: Commit and release**

Tag `v0.12.0`, push, `gh release create`, publish both packages to npm with the token.
