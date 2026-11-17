# P17 Selector-Driven Scenarios — Design

**Date:** 2026-11-17
**Status:** Draft for review
**Phase:** P17 (HapRay parity, lifts rows 1, 2, 3, 6, 7)
**Predecessor:** P16 symbol intelligence (0.11.0)

## The problem

HapRay's headline workflow is `perf`: discover test cases, run each through a
YAML UI script, capture a hiprofiler session per step, and emit a report. Two
parts of that matter and we have neither.

**We have the orchestration.** `run` already does rounds, per-step capture
windows, setup/action/cleanup phases, `steps.json`, `testInfo.json`, `pids.json`.
It is collect-only by construction and that is honest.

**We do not have the step language.** A scenario action is a raw coordinate:

```json
{ "kind": "click", "x": 540, "y": 1170 }
```

That is three failures at once:

1. **It does not survive a different device.** A 1080×2340 tap is off-screen on
   a 1260×2720 phone. HapRay's DSL selects a component and taps its centre;
   the coordinate is derived, not typed.
2. **It cannot say what should have happened.** A step is "ok" when the device
   accepted the gesture. A tap on the wrong screen, a button that did not
   appear, a list that never scrolled — all report ok. HapRay's DSL has the
   same hole (its `verify` is parsed and never run), so this is where we can be
   better rather than merely equal.
3. **It cannot scroll to find something.** HapRay's `touch` event carries a
   `scroll_target`; ours has no equivalent, so a scenario that needs to reach a
   list item below the fold must guess a swipe count.

## What this phase builds

A selector layer over the UI tree we already capture, a step language built on
it, and assertions that make a step's status mean something.

### 1. A selector language (`packages/core/src/scenario/selector.ts`)

A selector names nodes in a captured `ui.json` tree. It is **data**, validated
at load time like every other scenario field.

```ts
export type Selector =
  | { kind: 'text'; text: string; exact?: boolean }
  | { kind: 'id'; id: string }
  | { kind: 'type'; type: string }
  | { kind: 'clickable' }
  | { kind: 'all'; of: readonly Selector[] }
  | { kind: 'any'; of: readonly Selector[] }
  | { kind: 'not'; of: Selector }
  | { kind: 'index'; of: Selector; index: number }
  | { kind: 'bounds'; of: Selector; within?: Rect }
  | { kind: 'relative'; of: Selector; relation: 'above' | 'below' | 'leftOf' | 'rightOf'; to: Selector };
```

Matching rules, each of which is a test:

- `text` matches `node.text`, case-insensitively, substring by default and
  equal when `exact: true`. An empty `text` never matches — a selector that
  matches everything is a bug the author will not notice until it taps the
  status bar.
- `id` matches `node.id` exactly.
- `type` matches `node.type` exactly (`Button`, `Text`, …).
- `clickable` matches `node.clickable === true && node.enabled === true`.
- `all` is intersection, `any` is union, `not` is complement **within the
  current candidate set**, not the whole tree.
- `index` selects one node from a deterministic order: document order, then
  `(left, top, right, bottom)` as tie-breakers.
- `bounds.within` restricts to a rect.
- `relative` picks nodes satisfying `of` that are also `above`/`below`/etc. the
  **first** node matching `to` — first in document order, so the relation has
  one meaning rather than "some node somewhere".

Resolution returns `{ node, index }` or throws a typed refusal naming the
selector and how many candidates there were. Zero candidates and many
candidates are different errors: the first is a wrong selector, the second is
an ambiguous one, and the fix differs.

### 2. Actions that select instead of coordinate

The existing coordinate actions stay — a scenario that taps a blank canvas has
no other option, and removing them would break every scenario already written.
Four actions are added:

```ts
| { kind: 'tap'; target: Selector; scrollTo?: Selector; timeoutMs?: number }
| { kind: 'tapText'; text: string; scrollTo?: Selector }
| { kind: 'swipeArea'; area: Selector; direction: 'up' | 'down' | 'left' | 'right'; distance?: number }
| { kind: 'inputInto'; target: Selector; text: string }
```

- `tap` resolves `target` against a fresh dump, taps the centre of its bounds.
  `scrollTo` names a scrollable container: when `target` is not found, the
  runner swipes that container up to `maxScrolls` times (default 5), re-dumping
  after each, and fails with the count attempted if the target never appears.
- `tapText` is `tap` with `{ kind: 'text', text }` — the 90% case deserves a
  short form.
- `swipeArea` swipes inside a component's bounds rather than the whole screen,
  which is what a carousel or an inner list needs.
- `inputInto` taps a field then types into it, which is two device calls and
  one action so a step records one intent.

A resolved tap records the node's identity in `steps.json` next to the
coordinates, so a later reader can tell *what* was tapped, not only where.

### 3. Assertions that make a status mean something

A step gains an optional `expect` block, evaluated **after** its actions and
**before** cleanup, against a fresh dump:

```ts
interface StepExpectation {
  /** These must match at least `min` nodes (default 1). */
  readonly present?: readonly { selector: Selector; min?: number; max?: number }[];
  /** These must match zero nodes. */
  readonly absent?: readonly Selector[];
  /** The app must still be foreground; default true. */
  readonly foreground?: boolean;
}
```

Failure names which expectation failed and what the screen actually held — "no
node matched `text: 'Settings'`; 0 of 214 nodes had text containing it" — not
just "assertion failed".

`steps.json` records the evaluated expectations and their outcomes, so a
failed run explains itself without a second capture.

**This is the deliberate difference from HapRay.** Its DSL parses `verify` and
never runs it (the same defect as its `setup`/`cleanup`, which we already
execute). Asserting turns a step from "the device accepted my tap" into "the
screen showed what I expected" — which is what makes a performance number
attributable to an action rather than to a screen.

### 4. Case discovery and rounds over many cases (row 1/2)

`run --cases <dir>` discovers `*.scenario.json` files, runs each, and writes
one run directory per case plus a `cases.json` index. `--filter <regex>` selects
by case name. Rounds, `--only` and `--keep-going` keep their meaning per case.

This is HapRay's `--run_testcases` prefix matching, made honest: our filter is
an anchored regex over the case id, documented, and a filter that matches
nothing is a refusal rather than a silent empty run.

## What is not built, and why

- **`pinch`, `key_code2` combos, `isAfter`/`isBefore` multi-target relations.**
  No measured need; `swipeArea` covers carousel navigation, which is what
  pinch is used for in HapRay's own cases. Adding them later is additive.
- **XPath selectors.** HapRay's schema lists `xpath` and its implementation
  does not run it. Porting a selector language nobody executes would be
  fabrication.
- **Automatic test-case generation (`haptest`).** Row 4; nondeterministic by
  design and unsuitable as a parity target.
- **Retry-on-empty.** HapRay retries a case up to 5 times when its output
  directory is empty. Our runner reports an empty scene as a failed step with
  the reason; retrying silently is how a flaky measurement becomes a number.

## Compatibility

- `version: 1` scenarios keep working unchanged: every existing action kind is
  still accepted, `expect` is optional, and the schema's unknown-key refusal
  keeps its guarantee.
- The scenario schema version stays `1`. A new action kind is additive within
  it, exactly as `hilog` was added to the collector list.
- `steps.json` gains fields; every existing field keeps its meaning.

## Fidelity and determinism

- Selector resolution is deterministic: document order, then geometry, then
  the node's identity string as a final tie-break. Two runs over the same
  `ui.json` select the same node.
- No clock, no host path, and no locale-dependent comparison enters a document.
- A dump that cannot be read is a typed refusal (`SCENARIO_SELECTOR_NO_TREE`),
  never "zero candidates", because the two need different fixes.

## Error codes

| Code | When |
| --- | --- |
| `SCENARIO_BAD_SELECTOR` | A selector is malformed at load time. |
| `SCENARIO_SELECTOR_NO_TREE` | The device returned no parseable UI tree. |
| `SCENARIO_SELECTOR_NO_MATCH` | A selector matched zero nodes after scrolling. |
| `SCENARIO_SELECTOR_AMBIGUOUS` | A selector matched more than one node where one is required. |
| `SCENARIO_EXPECT_FAILED` | An `expect` clause was not satisfied. |
| `SCENARIO_CASES_EMPTY` | `--cases` found no scenario files, or `--filter` matched none. |

## Test plan (the contract)

- Selector matching: every kind, case-insensitivity, empty-text refusal,
  `not` scoped to candidates, `index` tie-break, `relative` first-match.
- Resolution errors: zero vs ambiguous vs no-tree, each with its code.
- Tap: centre of bounds; a node whose bounds did not parse is a refusal.
- Scroll-to: found after N swipes; not found after `maxScrolls` names the
  count; a non-scrollable `scrollTo` is a refusal.
- Assertions: `present` with `min`/`max`, `absent`, `foreground`, and each
  failure message naming the selector and the actual count.
- Schema: every new action validated; an unknown key still refused; a
  version-1 scenario with only coordinate actions still loads.
- Case discovery: ordering, `--filter` anchored, empty result refused.
- Determinism: two runs over the same dumps produce byte-identical
  `steps.json` apart from clock fields.

## Review focus

- **A selector that matches a node with unparsed bounds.** Tapping it must be
  a typed refusal, not a tap at `(0,0)`.
- **`not` inside `any` inside `all`.** Candidate-set scoping must be the one
  documented, or two authors will read the same selector differently.
- **A step whose actions succeed but whose assertion fails.** The status must
  be `failed`, the scene must still be named (it was captured), and the error
  must name the assertion.
- **`--cases` over a directory holding a malformed scenario.** One bad file
  must not hide the rest; the index records which failed to load.
- **A scroll that reaches the end of the list.** The runner must stop at the
  scrollable's edge rather than swiping forever.
