# P29 — Model-guided exploration and a measured state comparator

HapRay parity row 38 (`haptest/llm_strategy.py`, `haptest/llm_state_comparator.py`)
at the pinned revision `bd5c98a` (2026-11-18).

**Goal:** let a model choose the next exploration step from the elements the
walk actually found, verify that choice against the screen it was given, and
replace HapRay's LLM state comparison with a deterministic page-shape digest.

**Architecture:** the existing `explore` loop keeps ownership of the screen,
the visited set, and every outcome. A model is an optional `ExplorationChooser`
that may only name an element from the offer list the loop built; a name that
was not offered is recorded as a refusal and the deterministic strategy decides
instead. "Is this the same page?" becomes `hashPageShape`: a digest of the
tree's structure with text, ids and bounds removed — exactly the semantic
comparison HapRay asks a model for, measured instead of guessed. The loop also
learns to scroll and go back so the offer set is not artificially limited to
the first screen's elements.

**Tech Stack:** TypeScript (ESM), Node 20+, Vitest 2.1.9, the existing
OpenAI-compatible HTTP client. No new dependencies.

**Spec:** this plan executes parity row 38 in `packages/core/src/parity.ts`
against HapRay
`perf_testing/hapray/haptest/llm_strategy.py` and
`perf_testing/hapray/haptest/llm_state_comparator.py` at `bd5c98a`.
The design constraint recorded in the ledger is binding: *the model's answer is
verified against the screen it was given before the step counts.*

## Global Constraints

- ESM only; no new runtime dependencies.
- `npm run verify` (build core, both typechecks, unit suite) must pass before
  every commit. Never run bare `npm test` as a pre-commit gate.
- A model answer is data from outside the package: every field is checked, and
  nothing it says changes the walk's state without validation.
- Determinism: no clock, no unseeded randomness. With no chooser, a walk over
  the same screens produces the same steps byte-for-byte.
- Every new error is an `OhosPerfError` whose message names the value that
  failed. No silent defaults (HapRay's "out-of-range index → click element 0"
  is the defect this release removes).
- New core exports must be added to `VALUE_EXPORTS` in
  `packages/core/test/types.test.ts`.
- Version `0.24.0` in both packages; `packages/cli/package.json`'s
  `@ohos-perf/core` pin moves with it.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. A model answer names element 9 when 3 were offered → a recorded refusal and
   the deterministic pick; never a tap at a guessed node.
2. A scroll or back that changes nothing → bounded (3 scrolls and 1 back per
   screen) and the walk stops with a named reason instead of looping.
3. The walk leaves the target app → no node of another bundle is tapped; the
   walk backs out or stops with `left_app`.
4. A node's bounds stop parsing between the dump and the gesture → the host
   refuses rather than tapping the corner of the screen.
5. Reproducibility: an unseeded `random` walk repeats, and a scripted model
   over the same screens yields the same steps.

---

## File Structure

- Modify `packages/core/src/scenario/explore.ts` — page shapes, outcomes,
  scroll/back navigation, the trail, the bundle guard, the chooser seam.
- Create `packages/core/src/scenario/guard.ts` — the irreversible-action list,
  moved out of `agent.ts` so `explore.ts` can use it without a cycle.
- Modify `packages/core/src/scenario/agent.ts` — import the guard from its new
  home; behaviour unchanged.
- Modify `packages/core/src/scenario/agent-client.ts` — add `ChatModel` and
  `httpChatModel`; `httpAgentModel` becomes one consumer of it.
- Create `packages/core/src/scenario/llm-strategy.ts` — the exploration prompt,
  the answer parser, and `llmChooser`.
- Modify `packages/core/src/index.ts` — export the new surface.
- Modify `packages/cli/src/commands.ts`, `deps.ts`, `program.ts` — `--model`,
  the output, the seams.
- Tests: `packages/core/test/scenario-explore.test.ts`,
  `packages/core/test/scenario-llm-strategy.test.ts` (new),
  `packages/core/test/scenario-agent-client.test.ts`,
  `packages/core/test/types.test.ts`,
  `packages/cli/test/explore-cli.test.ts`,
  `packages/cli/test/explore-deps.test.ts` (new),
  `packages/cli/test/helpers/deps.ts`, `helpers-deps.test.ts`.
- Release: `packages/core/src/parity.ts`, `README.md`, `site/index.html`,
  `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`, package versions,
  `packages/core/test/parity.test.ts`, `packages/cli/test/skill.test.ts`.

---

### Task 1: A page is a shape, not a screen

**Files:**
- Modify: `packages/core/src/scenario/explore.ts`
- Test: `packages/core/test/scenario-explore.test.ts`

**Interfaces:**
- Consumes: `canonical` and `hashTree` in `explore.ts`.
- Produces:
  - `export function hashPageShape(tree: readonly UiNode[]): string` — a
    16-char digest of `bundleName, abilityName, depth, type, clickable, enabled,
    scrollable` per node, in order. Text, `id` and bounds are excluded.
  - `export type ExplorationOutcome = 'navigated' | 'updated' | 'no_change'`.
  - `ExplorationResult.pagesReached: number`, `ExplorationResult.pages:
    readonly string[]` (first-reach order).

- [ ] **Step 1: Write the failing tests**

Add to `scenario-explore.test.ts`:

```ts
describe('hashPageShape', () => {
  it('ignores text, ids and bounds: the same template is the same page', () => {
    const one = root([node({ id: 'a', text: 'Alpha', bounds: '[0,0][1,1]', type: 'Button', clickable: true })]);
    const two = root([node({ id: 'b', text: 'Beta', bounds: '[4,4][9,9]', type: 'Button', clickable: true })]);
    expect(hashPageShape(one)).toBe(hashPageShape(two));
    expect(hashTree(one)).not.toBe(hashTree(two));
  });

  it('changes when the structure changes', () => {
    const button = root([node({ type: 'Button', clickable: true })]);
    const text = root([node({ type: 'Text', clickable: true })]);
    expect(hashPageShape(button)).not.toBe(hashPageShape(text));
  });

  it('changes when a node is added, removed or moves depth', () => {
    const shallow = root([node({ type: 'Button' })]);
    const deeper = root([node({ type: 'Button', depth: 2 })]);
    const both = root([node({ type: 'Button' }), node({ type: 'Text' })]);
    expect(new Set([hashPageShape(shallow), hashPageShape(deeper), hashPageShape(both)]).size).toBe(3);
  });
});
```

In `describe('explore')`, add:

```ts
it('calls a text-only change an updated page, not a new page', async () => {
  const start = root([node({ id: 'a', clickable: true, type: 'Button', text: 'One', bounds: '[0,0][1,1]' })]);
  const next = root([node({ id: 'a', clickable: true, type: 'Button', text: 'Two', bounds: '[0,0][1,1]' })]);
  const result = await explore(device({ start, '[0,0][1,1]': next }), { maxSteps: 1, strategy: 'depth_first' });
  expect(result.steps[0].outcome).toBe('updated');
  expect(result.pagesReached).toBe(1);
  expect(result.statesReached).toBe(2);
  expect(result.pages).toHaveLength(1);
});
```

Update the `chain` fixture so each screen is structurally distinct (its type
carries the level) — otherwise every chain screen is the same page template and
the existing `navigated` expectations become wrong:

```ts
type: `Button${index}`
```

Then update the existing expectations that now reflect pages:
- `'stops at maxSteps…'` keeps `navigated` × 3, adds
  `expect(result.pagesReached).toBe(4)`.
- `'counts a tap that reached a new screen…'` uses different node types on the
  two screens, keeps `['navigated', 'no_change']` and adds
  `expect(result.pagesReached).toBe(2)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/scenario-explore.test.ts`
Expected: FAIL — `hashPageShape` is not exported; `pagesReached` is undefined.

- [ ] **Step 3: Implement**

Add to `explore.ts`:

```ts
/** A page template: structure only, blind to text, ids, bounds and ordering within a depth. */
function pageCanonical(tree: readonly UiNode[]): string { /* same length-prefix scheme, fields as above */ }
export function hashPageShape(tree: readonly UiNode[]): string { /* sha256 -> 16 hex chars */ }
```

In `explore()`: compute `beforePage`/`afterPage`, set
`outcome = after === before ? 'no_change' : afterPage === beforePage ? 'updated' : 'navigated'`,
track a first-reach `pages` array and `pagesReached = pages.length`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/explore.ts packages/core/test/scenario-explore.test.ts
git commit -m "feat(explore): tell a page from a screen with a structural digest"
```

---

### Task 2: Scroll and go back instead of stopping at a dead end

**Files:**
- Modify: `packages/core/src/scenario/explore.ts`
- Test: `packages/core/test/scenario-explore.test.ts`

**Interfaces:**
- Consumes: Task 1's `hashPageShape`.
- Produces:
  - `export type ScrollDirection = 'up' | 'down'`.
  - `ExplorationDevice` gains optional `swipe?(bounds: string, direction: ScrollDirection): Promise<void>`
    and `back?(): Promise<void>`.
  - `ExplorationHost` gains the same two optional methods.
  - `ExplorationStep` gains `kind: 'tap' | 'scroll' | 'back'`; `nodeId` and
    `bounds` become optional (present only for a tap).
  - `ExplorationResult` gains `stoppedBy: 'budget' | 'exhausted' | 'model' | 'left_app'`
    and `scrolls: number`, `backs: number`; `exhausted` stays and equals
    `stoppedBy === 'exhausted'`.
  - `ExplorationOptions` gains `app?: string`.

- [ ] **Step 1: Write the failing tests**

Add a device fixture that can scroll and go back:

```ts
function navDevice(screens: Record<string, UiNode[]>, opts: {
  scrolls?: Record<string, UiNode[]>;
  backs?: Record<string, UiNode[]>;
}): ExplorationDevice {
  let current = screens.start ?? [];
  let hash = '';       // set by dump
  return {
    dump: async () => { hash = hashTree(current); return current; },
    tap: async (bounds) => { const next = screens[bounds]; if (next) current = next; },
    swipe: async (_bounds, _direction) => { const next = opts.scrolls?.[hash]; if (next) current = next; },
    back: async () => { const next = opts.backs?.[hash]; if (next) current = next; },
  };
}
```

Tests:

```ts
it('scrolls a screen whose unvisited elements are gone, and taps what it reveals', ...)
// start: one scrollable Container + one Button a; scroll reveals Button b.
// expect step kinds ['tap', 'scroll', 'tap']; the scroll step is outcome 'updated'
// (same template); statesReached 3, pagesReached 1.

it('goes back when nothing is left to tap, scroll or return from', ...)
// A has b1 and b2; b1 -> B (empty). Expect ['tap', 'back', 'tap', ...]:
// after back, A's second element is tapped.

it('stops with exhausted when the only screen has nothing left', ...)
// unchanged from today: stoppedBy 'exhausted', steps length 1.

it('bounds scroll attempts on a screen that does not move', ...)
// a scrollable screen whose swipe leaves the tree identical: at most 3 scroll
// steps, then stoppedBy 'exhausted'.

it('tries back once per screen that does not move and then stops', ...)
// back returns the same tree: exactly 1 back step, then stoppedBy 'exhausted'.

it('rewinds the trail when a tap lands on an earlier page', ...)
// A -> B, then b -> A (same shape): after the rewind, no back is attempted.

it('never taps a node from outside the requested app', ...)
// tree has our app's Button and another bundle's Button; app: 'com.ours';
// only ours is tapped.

it('stops with left_app when the walk cannot return to the app', ...)
// tap -> tree of another bundle only; no back method: stoppedBy 'left_app'.
```

In `describe('explorationDevice')` add:

```ts
it('settles a swipe and a back the same way it settles a tap', ...)
it('does not expose swipe or back when the host cannot perform them', ...)
```

In `describe('deviceExplorationHost')` add:

```ts
it('swipes inside the scrollable node, from its lower edge to its upper edge', ...)
// assert gesture.action === 'swipe' with fromY > toY for direction 'up',
// x centred, all points inside the node's rect.
it('refuses to swipe bounds the screen no longer carries', ...)
it('sends the Back key for a back step and checks the acceptance marker', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/scenario-explore.test.ts`
Expected: FAIL — `swipe`/`back` are not part of the device; `stoppedBy` is
undefined.

- [ ] **Step 3: Implement**

In `explore()` keep a `trail: Array<{ hash: string; page: string }>` and update
it after every action with this one rule (no action-specific bookkeeping):

```
find the last trail index i with trail[i].page === afterPage
  found:      trail = trail.slice(0, i + 1); trail[i] = { hash: after, page: afterPage }
  not found, afterPage !== beforePage: trail.push({ hash: after, page: afterPage })
  not found, same page:                trail[last] = { hash: after, page: afterPage }
```

Decision order per step:
1. candidates = enabled, parseable, clickable nodes with
   `bundleName === '' || app === undefined || bundleName === app`, not tapped on
   this exact screen;
2. if candidates exist → deterministic pick (unchanged `planNextAction`);
3. else if a scrollable node exists, `device.swipe` exists and this exact
   screen has had fewer than 3 scrolls → scroll `up`);
4. else if `device.back` exists, the trail has a parent, and this exact screen
   has had fewer than 1 back → back;
5. else `stoppedBy = 'exhausted'` (or `'left_app'` when `app` was named and the
   tree carries nodes only from other bundles).

Count scrolls/backs per exact hash before the action. Mark `exhausted` as
`stoppedBy === 'exhausted'`.

`explorationDevice`: factor the existing tap body into `act(perform)` and use it
for `tap`, `swipe` and `back`; attach `swipe`/`back` only when the host has
them.

`deviceExplorationHost`: implement `swipe(bounds, direction)` by re-dumping,
requiring a node with those bounds **and `scrollable`**, then sending a swipe
between 80% and 20% of the rect's height (or the reverse for `down`), with the
same `No Error` marker check; implement `back()` as
`{ action: 'key', key: 'Back' }` with the same marker check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/explore.ts packages/core/test/scenario-explore.test.ts
git commit -m "feat(explore): scroll and go back instead of stopping at a dead end"
```

---

### Task 3: Let a model choose, and check what it chose

**Files:**
- Create: `packages/core/src/scenario/guard.ts`
- Modify: `packages/core/src/scenario/agent.ts`, `packages/core/src/scenario/explore.ts`
- Test: `packages/core/test/scenario-explore.test.ts`,
  `packages/core/test/scenario-agent.test.ts` (imports only)

**Interfaces:**
- Consumes: Task 2's `ExplorationStep`, `ScrollDirection`.
- Produces:
  - `guard.ts`: `IrreversiblePattern`, `IRREVERSIBLE_PATTERNS`,
    `irreversibleReason(node: UiNode): string | undefined` (moved verbatim from
    `agent.ts`; `agent.ts` imports it; `index.ts` exports it from `guard.ts`).
  - `export interface ExplorationCandidate { identity; type; text; bounds; depth }`.
  - `export interface ExplorationChoiceContext { app?: string; step: number; maxSteps: number;
    screen: readonly UiNode[]; candidates: readonly ExplorationCandidate[];
    history: readonly ExplorationStep[]; canScroll: boolean; canBack: boolean }`.
  - `export type ExplorationProposal = { kind:'tap'; identity; reason } |
    { kind:'scroll'; direction: ScrollDirection; reason } |
    { kind:'back'; reason } | { kind:'stop'; reason } |
    { kind:'refusal'; detail }`.
  - `export type ExplorationChooser = (context: ExplorationChoiceContext) =>
    Promise<ExplorationProposal>`.
  - `ExplorationOptions.choose?: ExplorationChooser`.
  - `ExplorationStep.decidedBy: 'strategy' | 'model'` and `reason?: string`
    (the model's one-line reason).
  - `ExplorationResult.proposals?: { used: number; refused: number;
    refusals: readonly { step: number; detail: string }[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('records a model-chosen tap as decided by the model, with its reason', ...)
// chooser returns {kind:'tap', identity: <id of b>, reason:'opens detail'}; the
// step has decidedBy 'model', reason, and the same node id as the offer.

it('refuses a choice that names an element it was not offered', ...)
// chooser returns {kind:'tap', identity:'not-here'}; the deterministic pick is
// taken (decidedBy 'strategy'); proposals.refused === 1 and the detail names
// 'not-here' and the number offered.

it('refuses scroll and back when the screen cannot do them', ...)
// chooser returns scroll on a tree with no scrollable node; same for back at
// the root; each is a recorded refusal and the walk continues.

it('ends the walk with stoppedBy model when the model says stop', ...)

it('never offers an irreversible target to a model', ...)
// tree has a Button text 'Delete account'; a chooser capturing contexts
// asserts none of its candidates has text/id matching the guard; a model-less
// walk still taps it (existing behaviour).

it('gives the chooser the step, the history, and what the screen allows', ...)
// capture the context: step 0, maxSteps, history[], canScroll, canBack, app.
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/scenario-explore.test.ts`
Expected: FAIL — `choose` is not an option.

- [ ] **Step 3: Implement**

Move the guard out of `agent.ts` into `guard.ts` unchanged. In the loop:

- build `candidates` and the context;
- when `choose` is set, filter out nodes for which `irreversibleReason(node)`
  is defined **before** offering them;
- `await choose(context)`; validate: tap identity must be in the offer, scroll
  requires `canScroll`, back requires `canBack`, stop sets
  `stoppedBy='model'`; anything invalid is a refusal recorded in
  `proposals.refusals` with the step index, and the deterministic pick runs;
- an accepted proposal sets `decidedBy: 'model'` and carries `reason`.

A chooser that throws is a transport failure and aborts the walk (it is not a
content problem).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/guard.ts packages/core/src/scenario/agent.ts \
  packages/core/src/scenario/explore.ts packages/core/src/index.ts \
  packages/core/test/scenario-explore.test.ts packages/core/test/scenario-agent.test.ts
git commit -m "feat(explore): let a model choose, and check what it chose"
```

---

### Task 4: The exploration prompt, the answer parser, and the chat client

**Files:**
- Create: `packages/core/src/scenario/llm-strategy.ts`
- Modify: `packages/core/src/scenario/agent-client.ts`
- Test: `packages/core/test/scenario-llm-strategy.test.ts` (new),
  `packages/core/test/scenario-agent-client.test.ts`

**Interfaces:**
- Consumes: Task 3's `ExplorationChooser` and `ExplorationChoiceContext`;
  `renderTree` from `agent.ts`; `readAgentConfig` and the HTTP transport in
  `agent-client.ts`.
- Produces:
  - `agent-client.ts`: `export interface ChatModel { complete(prompt: string): Promise<string> }`,
    `export function httpChatModel(options: HttpModelOptions): ChatModel`, where
    `HttpModelOptions = { baseUrl; apiKey; model; fetch; timeoutMs? }` and
    `HttpAgentModelOptions extends HttpModelOptions { shape?: AgentTurnShape }`.
    `httpAgentModel` delegates to `httpChatModel` and applies its shape.
  - `llm-strategy.ts`:
    - `export interface StrategyElement { index; type; text; bounds; depth }`
    - `export interface StrategyTurn { app; step; maxSteps; screen; elements;
      history: readonly string[]; canScroll; canBack }`
    - `export type StrategyAnswer = { action:'tap'; element; reason } |
      { action:'scroll'; direction: ScrollDirection; reason } |
      { action:'back'; reason } | { action:'stop'; reason }`
    - `export function explorationPrompt(turn: StrategyTurn): string`
    - `export function parseStrategyAnswer(content: string): StrategyAnswer |
      { action: 'refused'; detail: string }`
    - `export function llmChooser(model: ChatModel): ExplorationChooser`

- [ ] **Step 1: Write the failing tests**

`scenario-llm-strategy.test.ts`:

```ts
describe('explorationPrompt', () => {
  it('names the app, the step budget, the screen, every offered element and its index', ...)
  it('lists only the actions the screen allows', ...)
  // canScroll false / canBack false -> no scroll/back JSON format lines
  it('shows the recent history oldest first and is deterministic', ...)
  // same turn -> identical string; history lines carry kind, nodeId and outcome
});

describe('parseStrategyAnswer', () => {
  it('reads each action from bare or fenced JSON', ...)
  it('refuses non-JSON, naming an excerpt', ...)
  it('refuses an unknown action, naming the allowed set', ...)
  it('refuses a non-integer or negative element', ...)
  it('refuses a scroll direction other than up/down', ...)
  it('treats a missing reason as empty rather than failing the step', ...)
});

describe('llmChooser', () => {
  it('maps the chosen index to the offered element identity', ...)
  it('refuses an index past the end of the offer, naming both numbers', ...)
  it('refuses scroll/back answers the walk cannot perform', ...)
  it('sends one prompt that renders the screen and the candidates', ...)
  it('passes stop through with its reason', ...)
});
```

`scenario-agent-client.test.ts`: keep the existing `httpAgentModel` tests
green against the refactor; add

```ts
it('httpChatModel posts the prompt and returns the content', ...)
it('httpChatModel refuses an HTTP error, a non-JSON body and an empty answer', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/scenario-llm-strategy.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

`httpChatModel` owns the request/response code currently inside
`httpAgentModel.decide`; its error messages say "the model endpoint…".
`httpAgentModel` becomes:

```ts
export function httpAgentModel(options: HttpAgentModelOptions): AgentModel {
  const shape = options.shape ?? GUI_TURN;
  const chat = httpChatModel(options);
  return { decide: async (turn) => shape.parse(await chat.complete(shape.prompt(turn))) };
}
```

The exploration prompt is a deterministic string: the app line, `Step n of m`,
`renderTree(context.screen)`, one line per candidate `index. type "text" bounds
(depth d)`, the last 8 history lines, the allowed actions, and the literal JSON
formats. The parser unfences, parses, and checks every field, returning a
refusal that names what was wrong. `llmChooser` maps `element` to
`context.candidates[element].identity`, refuses an out-of-range index with
`the model chose element N, but M element(s) were offered`, and refuses
scroll/back when `canScroll`/`canBack` is false.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scenario/llm-strategy.ts packages/core/src/scenario/agent-client.ts \
  packages/core/src/index.ts packages/core/test/scenario-llm-strategy.test.ts \
  packages/core/test/scenario-agent-client.test.ts packages/core/test/types.test.ts
git commit -m "feat(scenario): the exploration prompt and a text completion client"
```

---

### Task 5: `explore --model`, and a report of what the model proposed

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/program.ts`
- Test: `packages/cli/test/explore-cli.test.ts`,
  `packages/cli/test/explore-deps.test.ts` (new),
  `packages/cli/test/helpers/deps.ts`, `helpers-deps.test.ts`

**Interfaces:**
- Consumes: Task 3's `ExplorationChooser`; Task 4's `llmChooser` and
  `ChatModel`; `readAgentConfig`.
- Produces:
  - `ExploreRequest.model?: string`.
  - `ExploreOutput`: `updated`, `scrolls`, `backs`, `pagesReached`, `pages`,
    `stoppedBy`, `model?: { name; used; refused; refusals: [{ step; detail }] }`.
  - `RealDepsOverrides.exploreModel?: ChatModel` (a separate seam; never reuse
    `agentModel`).

- [ ] **Step 1: Write the failing tests**

CLI formatting (`explore-cli.test.ts`):

```ts
it('prints screens and pages as separate counts', ...)
it('prints updated taps between navigated and no change', ...)
it('says why the walk stopped: budget, exhausted, model or left_app', ...)
it('names the model and every refusal when a model chose steps', ...)
it('prints the walk as JSON with the new fields', ...)
```

Wiring:

```ts
it('forwards --model and builds a chooser from the configured endpoint', ...)
// stub explore; run `explore com.demo --model m1`; assert req.model === 'm1'
it('refuses --model when no endpoint is configured, before touching a device', ...)
// env cleared; exit 1; the message names OHOS_PERF_AGENT_BASE_URL
```

Real seam (`explore-deps.test.ts`), with `saveEnv`/`restoreEnv` as in
`root-cause-deps.test.ts`:

```ts
it('drives the walk with a stubbed ChatModel and records its proposals', ...)
// cliDeps({ exploreDevice, exploreClock, exploreModel: { complete } });
// the answer taps an offered element; output.model.used === 1
it('falls back deterministically and reports the refusal when the answer is unusable', ...)
// complete returns '{"action":"tap","element":99}'; refusal recorded
it('never calls the model without --model', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/cli/test/explore-cli.test.ts`
Expected: FAIL — `--model` is not an option; `updated` is undefined.

- [ ] **Step 3: Implement**

`deps.explore`: when `req.model` is set, read the config (refusing with a named
error when absent), build `overrides.exploreModel ?? httpChatModel(...)`, and
pass `choose: llmChooser(model)` plus `app: req.app` into `explore`.
`model.name` is the string actually sent (the flag or the configured default).
`commands.ts` prints the new lines; `program.ts` adds
`--model <name>` and a help note that the model only chooses among dumped
elements and is never offered irreversible targets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(explore): --model, and report what the model proposed"
```

---

### Task 6: Ledger, docs, site, and release 0.24.0

**Files:**
- Modify: `packages/core/src/parity.ts`, `packages/core/test/parity.test.ts`,
  `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`,
  `packages/core/package.json`, `packages/cli/package.json`, lockfile,
  `packages/cli/test/skill.test.ts`.

**Interfaces:**
- Consumes: everything above.
- Produces: row 38 `ported` with an empty reason; parity counts 37 ported / 0
  partial / 1 missing / 1 out; release notes.

- [ ] **Step 1: Move the ledger row**

Row 38 becomes `status: 'ported', reason: ''`. Keep the `missing` row 39
(thermal) and update the README's "row 38 is P29" sentence.

- [ ] **Step 2: Update the tests and run them**

`parity.test.ts`: the counts assertion moves to 39 total; add an assertion that
row 38 is ported. `skill.test.ts`: no command was added, so unchanged.

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 3: Write the release prose**

- README: a "Model-guided exploration" subsection stating the offer/refuse
  contract, the page-shape comparison, and the scroll/back walk; update the
  parity counts and the row-38/39 sentences.
- `site/index.html`: P1–P29 eyebrow, test count, a P29 card (en + zh).
- `CHANGELOG.md`: 0.24.0 entry — model choice with verification, page shapes,
  navigation, the CLI output, and the added tests.
- `skill/ohos-perf/SKILL.md`: tell an agent to read `proposals.refusals` and
  never treat `updated` as a new page.

- [ ] **Step 4: Bump versions and verify**

Set both `package.json` versions and the CLI's core pin to `0.24.0`; refresh
the lockfile. Run `npm run verify` and `npm run test:device` (serial).

- [ ] **Step 5: Live smoke, then release**

Against the Magpie gateway (`OHOS_PERF_AGENT_BASE_URL=http://127.0.0.1:3425/v1`,
`OHOS_PERF_AGENT_MODEL=auto/deepseek-v4.1-flash`, any non-empty key) run
`explore <installed-debug-bundle> --model auto/deepseek-v4.1-flash --max-steps 5`
on the device and inspect the refusal line and the pages count.

Then commit, tag `v0.24.0`, push, publish `core` and `cli` with the token
userconfig, poll the registry for both, run a fresh-install smoke test, and
create the GitHub release.

```bash
git add -A
git commit -m "release: 0.24.0 — model-guided exploration"
git tag v0.24.0
git push origin master --tags
```
