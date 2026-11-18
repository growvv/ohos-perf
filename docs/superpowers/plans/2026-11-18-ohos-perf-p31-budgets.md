# P31 — Performance budgets and a CI regression gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn a measured scene into a machine-checkable pass/fail against a versioned budget document, with an exit code a CI job can gate on — a capability HapRay does not have at any revision.

**Architecture:** a `BudgetDocument` (versioned JSON, validated whole before any scene is opened) lists one bound per metric id. `evaluateGate` reads an `AnalyzeResult` (and optionally a baseline one) and returns one `GateVerdict` per budget: `pass`, `fail`, or `missing` — a metric the run did not measure fails the gate rather than passing it. The CLI command `gate` wires that to files and exit codes: `0` pass, `2` violated, `1` could not run.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9. No new dependencies; the validator is hand-written like `scenario/schema.ts`, so every rejection names the JSON path.

**Spec:** this package's own `compare` (`packages/core/src/report/compare.ts`) and `report/model.ts` define the metric vocabulary and the `AnalyzeResult` shape the gate consumes. HapRay at `bd5c98a` is the negative reference: its regression story ends at `PerfMulti.vue` drawing lines for a human to read, with no threshold, no verdict and no exit code anywhere in `perf_testing/` or `hapray-gui/` (checked with `grep -rn "threshold\|budget"` over the tree's own sources — only vendored `.venv` hits).

## Global Constraints

- ESM only; no new runtime dependencies.
- `npm run verify` (build core, both typechecks, unit suite) must pass before every commit; rebuild the CLI (`npm run build -w packages/cli`) before `verify` after any `packages/cli/src` edit.
- A budget document is data from outside the package: every field is checked, an unknown key is an error, and every rejection names the JSON path that caused it.
- Determinism: verdicts are sorted by metric id, the JSON artifact is two-space indented with a trailing newline (the `analyze --json` convention), and the same inputs produce byte-identical output.
- A metric that was not measured is never a pass. Absent and degraded both yield `missing`, which fails the gate.
- Exit codes: `0` the gate ran and everything passed, `2` the gate ran and at least one budget failed, `1` the gate could not run (bad document, unreadable input, a delta budget without a baseline). `2` is reserved for a verdict, never for an error.
- Every new error is an `OhosPerfError` whose message names the value that failed.
- New core value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.
- The parity ledger does not change: this is a capability beyond the inventory, so counts stay 38 ported / 0 partial / 0 missing / 1 out.
- Version `0.26.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. A budget names a metric the run never emitted → `missing`, the gate fails, and the verdict says the metric was not measured. A gate that passes on absent data is the defect this whole package exists to prevent.
2. The metric is present but degraded (a `*.degraded` proxy with `fallback`) → also `missing`, not a pass on the proxy's zero.
3. A `maxDeltaPct` budget with no baseline supplied → exit 1 naming the budget ids that need one, before either input is opened.
4. A delta budget whose baseline value is 0 → `missing` with a reason (`a percentage of zero is undefined`), not a pass and not `Infinity`.
5. A budget document with an unknown key, a duplicate metric id, or an entry with zero or two bounds → rejected naming the JSON path, before the scene is opened.

---

## File Structure

- Create: `packages/core/src/gate/schema.ts` — the document type, validation, and `BUDGET_SCHEMA_VERSION`.
- Create: `packages/core/src/gate/evaluate.ts` — `evaluateGate`, the verdict types.
- Create: `packages/core/src/gate/index.ts` — the module's public surface (schema + evaluate + JSON rendering).
- Modify: `packages/core/src/index.ts` — re-export the gate surface.
- Modify: `packages/cli/src/commands.ts` — `GateRequest`, `GateOutput`, `runGate`.
- Modify: `packages/cli/src/deps.ts` — the `gate` seam (reads the document and the inputs, calls core).
- Modify: `packages/cli/src/program.ts` — the `gate` command.
- Modify: `packages/cli/test/helpers/deps.ts`, `helpers-deps.test.ts`, `program.test.ts`, `skill.test.ts` — the seam and command lists.
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md` — docs.
- Modify: `packages/core/package.json`, `packages/cli/package.json`, lockfile — version.
- Tests: `packages/core/test/gate-schema.test.ts`, `gate-evaluate.test.ts`, `packages/cli/test/gate-cli.test.ts`, `gate-deps.test.ts`.

---

### Task 1: The budget document

**Files:**
- Create: `packages/core/src/gate/schema.ts`
- Test: `packages/core/test/gate-schema.test.ts`

**Interfaces:**
- Produces:
```ts
export const BUDGET_SCHEMA_VERSION = 1;

/** The bound a budget entry applies. Exactly one per entry. */
export type BudgetBound =
  | { readonly kind: 'max'; readonly limit: number }
  | { readonly kind: 'min'; readonly limit: number }
  | { readonly kind: 'maxDelta'; readonly limit: number }
  | { readonly kind: 'maxDeltaPct'; readonly limit: number };

export interface BudgetEntry {
  readonly id: string;
  readonly bound: BudgetBound;
}

export interface BudgetDocument {
  readonly schemaVersion: typeof BUDGET_SCHEMA_VERSION;
  /** A name for the gate, copied into its output; not a path. */
  readonly name: string;
  /** Sorted by metric id, so two documents with the same budgets compare equal. */
  readonly budgets: readonly BudgetEntry[];
}

/** Parse and validate a budget document; throws `OhosPerfError` naming the JSON path. */
export function parseBudgetDocument(input: unknown): BudgetDocument;

/** The budgets that need a baseline run to be evaluated. */
export function deltaBudgetIds(doc: BudgetDocument): string[];
```

- A budget document is `{schemaVersion: 1, name: string, budgets: [{id, max|min|maxDelta|maxDeltaPct}]}`.
- Error codes: `BUDGET_BAD_DOCUMENT` (document-level: not an object, wrong `schemaVersion`, unknown key, empty `budgets`, empty `name`), `BUDGET_BAD_ENTRY` (inside `budgets[i]`: unknown key, non-string `id`, zero or two bounds, non-finite limit).
- `name` is a label, not a path: a document is committed beside the code and shared, so it must not depend on where it was run from. State this in the doc comment.
- Sorting by id happens in `parseBudgetDocument`, so the document's own order never leaks into output.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/gate-schema.test.ts`:
- a minimal document with one `max` budget parses to the expected object;
- each of the four bound kinds parses, with the limit preserved exactly (no rounding);
- `budgets` are returned sorted by id regardless of document order;
- `deltaBudgetIds` returns the ids of `maxDelta`/`maxDeltaPct` entries only, sorted, and `[]` when there are none;
- rejections, each asserting both the code and that the message names the path:
  - `null`, `[]`, a string → `BUDGET_BAD_DOCUMENT`;
  - `schemaVersion: 2` → names `schemaVersion` and both values;
  - an unknown document key → names it;
  - `budgets: []` → names `budgets`;
  - `budgets[1]` with no bound, and `budgets[0]` with both `max` and `min` → `BUDGET_BAD_ENTRY` naming `budgets[1]` / `budgets[0]`;
  - two entries with the same id → `BUDGET_BAD_ENTRY` naming the repeated id and the path of the second;
  - `max: '5'` and `max: Infinity` → names the value.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/gate-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parseBudgetDocument`**

Hand-written validation in the style of `scenario/schema.ts`: a `bad(path, message)` helper building `OhosPerfError` with `BUDGET_BAD_DOCUMENT`/`BUDGET_BAD_ENTRY`, an allowed-key set per level, and a bound reader that maps `max|min|maxDelta|maxDeltaPct` to the tagged union. Duplicate ids are detected after reading every entry, so the message can name both positions. Return a new object with `budgets` sorted by id.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/gate-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gate/schema.ts packages/core/test/gate-schema.test.ts
git commit -m "feat(gate): versioned budget document and its validator"
```

---

### Task 2: Evaluation

**Files:**
- Create: `packages/core/src/gate/evaluate.ts`
- Test: `packages/core/test/gate-evaluate.test.ts`

**Interfaces:**
- Consumes: `BudgetDocument`, `BudgetEntry`, `BudgetBound` from Task 1; `AnalyzeResult` from `../analyze/types`.
- Produces:
```ts
export type GateStatus = 'pass' | 'fail' | 'missing';

export interface GateVerdict {
  readonly id: string;
  readonly status: GateStatus;
  /** The measured value; absent when the metric was not measured. */
  readonly value?: number;
  /** The baseline value, for a delta bound. */
  readonly baseline?: number;
  /** The bound as the document wrote it. */
  readonly bound: BudgetBound;
  /** How far past the bound the value was, in the bound's own unit; absent unless `fail`. */
  readonly excess?: number;
  /** Why the metric could not be judged; absent unless `missing`. */
  readonly reason?: string;
}

export interface GateResult {
  readonly name: string;
  readonly status: 'pass' | 'fail';
  readonly verdicts: readonly GateVerdict[];
  readonly totals: { readonly pass: number; readonly fail: number; readonly missing: number };
}

export function evaluateGate(
  doc: BudgetDocument,
  current: AnalyzeResult,
  baseline?: AnalyzeResult,
): GateResult;
```

- Judging one entry:
  - find `current.metrics` by id; if absent → `missing`, reason `` `the run emitted no ${id}` ``;
  - if the metric has `degraded` → `missing`, reason `` `${id} is degraded: ${metric.degraded.reason}` ``;
  - if the value is not a number → `missing`, reason `` `${id} is not numeric (${typeof value})` ``;
  - `max` passes when `value <= limit`, `min` when `value >= limit`;
  - `maxDelta` passes when `value - base <= limit`; `maxDeltaPct` when `((value - base) / |base|) * 100 <= limit`;
  - a delta bound with no baseline metric → `missing`, reason `` `the baseline emitted no ${id}` ``;
  - a delta bound whose baseline value is 0 → `missing`, reason `` `a percentage of a zero ${id} baseline is undefined` `` (`maxDelta` is fine with 0 and does not take this branch);
  - a delta bound whose baseline value is not numeric → `missing`.
- `excess` is `value - limit` for `max`, `limit - value` for `min`, and the same shape for the delta kinds; rounded to 3 decimals for byte stability, never negative.
- `status` is `fail` when any verdict is not `pass`.
- `verdicts` are in document order (already sorted by Task 1), never re-sorted.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/gate-evaluate.test.ts`, with small hand-built `AnalyzeResult`s:
- `max` pass at the boundary (`value === limit`) and fail one above, with `excess` correct;
- `min` pass at the boundary and fail one below;
- `maxDelta` and `maxDeltaPct` pass/fail with the baseline supplied, `baseline` echoed in the verdict;
- a metric absent from the run → `missing` naming the id, and the gate fails (review focus 1);
- a degraded metric → `missing` quoting the degradation reason, even though its value is 0 (review focus 2);
- a non-numeric metric value → `missing`;
- `maxDeltaPct` with a zero baseline → `missing` with the zero-baseline reason, not `Infinity` (review focus 4);
- a delta bound with no baseline argument → `missing` naming the baseline (the CLI refuses earlier, but the core function must not guess);
- totals count every verdict exactly once, and `status` is `pass` only when all pass;
- two evaluations of the same inputs are deep-equal.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/gate-evaluate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `evaluateGate`**

Map over `doc.budgets`, judge each with a small `judge(entry, current, baseline)` helper returning a verdict, then fold the totals. No IO, no sorting, no mutation of the inputs.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/gate-evaluate.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the module and commit**

Create `packages/core/src/gate/index.ts` re-exporting `schema.ts` and `evaluate.ts`, add `renderGateJson(result)` (two-space indent plus trailing newline) to `evaluate.ts`, re-export from `packages/core/src/index.ts`, and add the value exports (`BUDGET_SCHEMA_VERSION`, `parseBudgetDocument`, `deltaBudgetIds`, `evaluateGate`, `renderGateJson`) to `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.

```bash
git add packages/core/src/gate packages/core/src/index.ts \
  packages/core/test/gate-evaluate.test.ts packages/core/test/types.test.ts
git commit -m "feat(gate): evaluate a run against its budgets"
```

---

### Task 3: The `gate` command

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/program.ts`
- Test: `packages/cli/test/gate-cli.test.ts`, `packages/cli/test/gate-deps.test.ts`, `program.test.ts`, `helpers-deps.test.ts`

**Interfaces:**
- `GateRequest = { budget: string; input: string; baseline?: string; outDir?: string }`.
- `GateOutput = { result: GateResult; outDir?: string; files: string[] }` where `files` is `['gate.json']` when an output directory was given, `[]` otherwise.
- The `gate` seam: `(req: GateRequest) => Promise<GateOutput>`.
- CLI: `ohos-perf gate <budget> <input> [--baseline <input>] [--out <dir>] [--json]`.
- Exit codes: `0` all pass, `2` at least one `fail`/`missing`, `1` could not run.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/gate-cli.test.ts` (deps stubbed through `cliDeps`):
- a passing result prints one line per budget plus a totals line and exits 0;
- a failing result prints `fail` with the excess and exits **2** (asserting the code, not just the text);
- a `missing` verdict prints its reason and exits 2;
- `--json` prints the `GateResult` alone and still exits 2 when it failed — a machine consumer reads the verdict, not the absence of output;
- a thrown error (bad document) exits 1 with empty stdout.

In `packages/cli/test/gate-deps.test.ts` (real `realDeps`, temp files):
- a document with a `maxDeltaPct` budget and no `--baseline` rejects with `GATE_BASELINE_REQUIRED` naming the id, **before** the input scene is opened (assert by passing a nonexistent scene path: the error must be about the baseline, not the path);
- `--baseline` is read and passed to `evaluateGate`; a scene directory and an `analyze --json` file both work on either side;
- `--out` writes `gate.json` containing exactly `renderGateJson(result)`;
- a malformed document exits 1 through the seam.

In `program.test.ts`: `gate` appears in the `--help` list, and the command forwards `budget`, `input`, `--baseline`, `--out` and `--json`. In `helpers-deps.test.ts`: `gate` is in `UNSTUBBED`.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/cli/test/gate-cli.test.ts packages/cli/test/gate-deps.test.ts packages/cli/test/program.test.ts packages/cli/test/helpers-deps.test.ts`
Expected: FAIL — `runGate` and the `gate` seam do not exist.

- [ ] **Step 3: Implement**

`runGate` in `commands.ts` mirrors `runCompare`: call the seam, render, map the verdict to the exit code. The deps seam reads the document with `parseBudgetDocument(JSON.parse(...))` (wrapping a read/parse failure in `BUDGET_BAD_DOCUMENT` with the path), refuses delta budgets without a baseline with `GATE_BASELINE_REQUIRED` naming `deltaBudgetIds`, then reuses the existing scene/`analyze --json` loaders that `compare` uses.

Text output: one line per verdict, `<id>  <value> <op> <limit>  <status>` with a `  (<excess> past)` suffix on failure and the reason on `missing`, then a totals line and `gate  pass|fail`.

- [ ] **Step 4: Run to verify green**

Run: `npm run build -w packages/cli && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(gate): gate command with CI exit codes"
```

---

### Task 4: Docs, skill, release 0.26.0

**Files:**
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`,
  `packages/core/package.json`, `packages/cli/package.json`, lockfile.

**Interfaces:**
- Consumes: everything above.
- Produces: a "Budgets and the gate" section, a P31 roadmap row, a site card, the 0.26.0 changelog entry, and a skill section telling an agent when to run `gate` and how to read `missing`.

- [ ] **Step 1: Write the docs**

- README: a section after "Root cause" with the document shape, one worked example, the three exit codes, and the sentence that distinguishes this from HapRay: HapRay's regression story is a chart a human reads; a budget is a claim a job can check. Add a P31 roadmap row.
- Site: a P31 card (en + zh), the eyebrow extended to P1–P31, and a `gate` mention in the command list.
- `CHANGELOG.md`: 0.26.0 entry.
- SKILL.md: when to use `gate` (after `analyze`, before proposing a change), that `missing` is a failure and must be reported as "not measured", and that exit 2 means a budget, not an error.

- [ ] **Step 2: Bump and verify**

Both package versions and the CLI's core pin to `0.26.0`; refresh the lockfile; `npm run verify`; `npm run test:device`.

- [ ] **Step 3: Live smoke**

Write a small budget document in a temp directory, `gate` it against a real captured scene and against the recorded fixture scene, and confirm pass and fail both report the measured value and the correct exit code.

- [ ] **Step 4: Review, then release**

Whole-branch review (fresh agent) before tagging; fix Critical/Important red-first. Then commit, tag `v0.26.0`, push, publish both packages with the token userconfig, poll the registry over `registry.npmjs.org` (the local registry is npmmirror and lags), fresh-install smoke, GitHub release, confirm CI/pages.
