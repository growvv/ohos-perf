# P32 — Trend-aware root cause: what moved, and what caused it Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let `root-cause` answer "which change caused this regression" by carrying the deterministic cross-run movement of every metric — and of every evidence kind — into the root-cause document, its Markdown, and the model turn, without ever reading a gap as an improvement.

**Architecture:** a new core module `report/movement.ts` compares two runs in the order the caller names them (`--baseline` first, the input second) and returns a `RootCauseMovement`: ranked metric rows (`regressed` / `improved` / `unchanged` / `incomparable` / `gap`), an evidence-kind count diff, totals, and one deterministic verdict sentence. `RootCauseDocument` gains an optional `movement` field (schema 2); the Markdown renders it before the evidence verdict, the prompt carries it, and a model may cite moved metric ids — checked exactly like evidence ids. The CLI gains `root-cause --baseline <scene|report.json>`.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9. No new dependencies. Direction vocabulary is the existing `METRIC_DIRECTIONS`; gap semantics are the existing `buildTrend` rule (absent or `degraded` is not a measurement).

**Spec:** this package's own `report/compare.ts` (`METRIC_DIRECTIONS`, `DeltaStatus`), `report/trend.ts` (the gap rule and its doc comment), and `report/root-cause.ts` / `root-cause-model.ts` (document shape, citation checking, `ungrounded`) are the binding authority. HapRay at `bd5c98a` is the negative reference: `PerfMulti.vue` draws multi-version lines and `root_cause` reads one run's report JSON — nothing anywhere compares two runs' evidence or asks a model what moved (verified with `grep -rn "baseline\|movement\|delta"` over `perf_testing/` and `hapray-gui/src` at that rev).

## Global Constraints

- ESM only; no new runtime dependencies.
- `npm run verify` (build core, both typechecks, unit suite) must pass before every commit; run `npm run build -w packages/cli` before `verify` after any `packages/cli/src` edit (a test asserts the bundle is not older than its sources).
- **A gap is never a movement.** A metric absent from one side, or present with `degraded` set, is `gap` on that side — never `improved`, never `regressed`, never a delta. This is the same rule `buildTrend` already applies, and it is the defect class this package exists to prevent.
- **Direction is the caller's, not the clock's.** Movement always runs `--baseline` → input. `buildTrend` sorts by `startedAtNs` when both runs have one; movement must not, because a baseline captured later would silently invert every verdict.
- Determinism: rows are in a total order (status group, then magnitude, then id), evidence rows are sorted by kind, JSON is two-space indented with a trailing newline. The same two runs produce byte-identical output.
- A document is data: every new field is copied, never referenced; `buildMovement` mutates neither input.
- App identity: a baseline measuring a different app than the input is refused, naming both. Device is deliberately not refused — the movement states both devices.
- `ROOT_CAUSE_SCHEMA_VERSION` becomes `2`. The field is additive and optional, but the shape changed, so the version says so.
- Every new error is an `OhosPerfError` whose message names the value that failed. CLI codes: `ROOT_CAUSE_BAD_BASELINE`.
- New core value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.
- The parity ledger does not change: this is a capability beyond the inventory, so counts stay 38 ported / 0 partial / 0 missing / 1 out.
- Version `0.27.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. A metric measured in one run and **degraded** in the other (skipped analyzer, `degraded` set, value 0) → `gap` naming the side, and the `*.degraded` proxy metric itself never becomes a row. A jank rate of 12% that disappears must not read as an improvement to 0.
2. `--baseline` naming a run captured **later** than the input → direction is still baseline → input; the delta sign and every verdict follow the caller's order, not `startedAtNs`.
3. Baseline and input measure **different apps** → refused naming both, before a model is consulted and before any artifact is written.
4. A movement whose baseline value is **0** → `deltaPct` absent (no `Infinity`), the row still ranked by `delta`, and the verdict sentence says the change without inventing a percentage.
5. A model cites a **metric id that did not move**, or cites any metric when no movement block exists → recorded in `ungrounded` and printed, never presented as measured.

---

## File Structure

- Create: `packages/core/src/report/movement.ts` — movement types, `buildMovement`, `renderMovementJson` (used for the CLI's `--json` shape via the document, not a separate file).
- Modify: `packages/core/src/report/root-cause.ts` — schema 2, optional `movement`, `RootCauseInput.movement`.
- Modify: `packages/core/src/report/root-cause-markdown.ts` — the "What moved" section.
- Modify: `packages/core/src/report/root-cause-model.ts` — prompt section, `metrics` citations, vocabulary.
- Modify: `packages/core/src/index.ts` — re-export the movement surface.
- Modify: `packages/cli/src/commands.ts` — `RootCauseRequest.baseline`, the movement summary line.
- Modify: `packages/cli/src/deps.ts` — shared input loader, baseline loading, app refusal.
- Modify: `packages/cli/src/program.ts` — `--baseline`.
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`.
- Modify: `packages/core/package.json`, `packages/cli/package.json`, lockfile — version.
- Tests: `packages/core/test/report-movement.test.ts`, plus additions to `report-root-cause.test.ts`, `report-root-cause-markdown.test.ts`, `report-root-cause-model.test.ts`, `packages/cli/test/root-cause-cli.test.ts`, `root-cause-deps.test.ts`, `program.test.ts`.

---

### Task 1: The movement module

**Files:**
- Create: `packages/core/src/report/movement.ts`
- Test: `packages/core/test/report-movement.test.ts`

**Interfaces:**
- Consumes: `AnalyzeResult` (`../analyze/types`), `Metric`/`MetricUnit` (`./metric`), `METRIC_DIRECTIONS` (`./compare`), `EvidenceKind` (`./evidence`).
- Produces:
```ts
export type MovementStatus = 'regressed' | 'improved' | 'unchanged' | 'incomparable' | 'gap';

/** One run's identity and measured result, as the movement sees it. */
export interface MovementInput {
  readonly label: string;
  readonly app: string;
  readonly device: string;
  readonly startedAtNs?: number;
  readonly result: AnalyzeResult;
}

export interface MovementSide {
  readonly label: string;
  readonly app: string;
  readonly device: string;
  readonly startedAtNs?: number;
}

export interface MovementRow {
  readonly id: string;
  readonly unit: MetricUnit;
  /** The value, or `null` when that side did not measure it. */
  readonly from: number | string | null;
  readonly to: number | string | null;
  /** `to - from`; absent unless both sides are numeric. */
  readonly delta?: number;
  /** Percent over `|from|`; absent when `from` is 0 or either side is not numeric. */
  readonly deltaPct?: number;
  readonly status: MovementStatus;
  /** Why a side is a gap; present only when `status === 'gap'`. */
  readonly gap?: { readonly side: 'from' | 'to' | 'both'; readonly reason: string };
}

/** How many findings of one kind each run produced. */
export interface MovementEvidenceRow {
  readonly kind: EvidenceKind;
  readonly from: number;
  readonly to: number;
  readonly delta: number;
}

export interface RootCauseMovement {
  readonly from: MovementSide;
  readonly to: MovementSide;
  /** One sentence naming the worst regression, or stating that nothing regressed. */
  readonly verdict: string;
  /** Total order: regressed, improved, unchanged, incomparable, gap; then magnitude; then id. */
  readonly rows: readonly MovementRow[];
  /** Every kind either run reported, sorted by kind. */
  readonly evidence: readonly MovementEvidenceRow[];
  readonly totals: {
    readonly regressed: number;
    readonly improved: number;
    readonly unchanged: number;
    readonly incomparable: number;
    readonly gaps: number;
    /** `*.degraded` proxy metrics, which are gap markers and never rows. */
    readonly skipped: number;
  };
}

/** Throws `OhosPerfError` (`ROOT_CAUSE_APP_MISMATCH`) when the apps differ. */
export function buildMovement(from: MovementInput, to: MovementInput): RootCauseMovement;
```

- Judging one metric id (union of both sides' ids, `*.degraded` excluded and counted in `totals.skipped`):
  - side value: the metric's `value` when present and `degraded === undefined`, else `null`;
  - one side `null` → `gap`, `gap.side` = which side, reason `` `the ${side} run emitted no ${id}` `` when absent or `` `${id} is degraded in the ${side} run: ${reason}` `` when degraded;
  - both sides non-numeric → `incomparable`, no delta;
  - both numeric and no `METRIC_DIRECTIONS[id]` → `incomparable`, delta and deltaPct recorded;
  - both numeric with a direction → `delta === 0 ? 'unchanged' : direction === 'lower' ? (delta < 0 ? 'improved' : 'regressed') : (delta > 0 ? 'improved' : 'regressed')`.
- `deltaPct` is `round3(((to - from) / Math.abs(from)) * 100)`, absent when `from === 0`.
- Ranking: status group order `regressed, improved, unchanged, incomparable, gap`; inside a group, `|deltaPct|` descending (rows without it last within the group), then `|delta|` descending, then id ascending; `gap` rows by id only.
- Evidence rows count `result.evidence` by `kind` on each side; a kind present on neither side is not a row; `delta = to - from`.
- Verdict: with a regression, `` `${worst.id} regressed from ${worst.from} to ${worst.to}` `` + ` (${deltaPct}%)` when present + `` `, and ${n - 1} other regression${…}` `` when `n > 1`, prefixed `` `${from.label} → ${to.label}: ` ``. With no regression but an improvement: `` `nothing regressed between ${from.label} and ${to.label}; ${n} metric${…} improved` ``. With neither: `` `nothing comparable moved between ${from.label} and ${to.label}` ``.
- App mismatch: throw `OhosPerfError('root-cause: the baseline measures ${from.app} and the input measures ${to.app}; a movement is only comparable within one app', { code: 'ROOT_CAUSE_APP_MISMATCH' })`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/report-movement.test.ts`, with small hand-built `AnalyzeResult`s (a `metric(id, value, unit?, fidelity?)` helper mirroring the trend test's):
- a lower-is-better metric rising is `regressed` with positive delta and deltaPct; falling is `improved`;
- a higher-is-better metric rising is `improved`;
- an equal value is `unchanged`, in the `unchanged` group, not `improved`;
- a metric with no direction and a numeric move is `incomparable` **with** delta recorded;
- a metric measured only in the baseline, and one only in the current run, are `gap` with the side named and the id in the reason (review focus 1);
- a metric whose current side is `degraded` (value 0, `degraded` block) is `gap` with the reason quoting the degradation reason — not `improved` (review focus 1);
- `*.degraded` metrics appear in no row and are counted in `totals.skipped` (review focus 1);
- a baseline value of 0 → `deltaPct` absent and the row still ranked by `|delta|` (review focus 4);
- rows are ordered regressed → improved → unchanged → incomparable → gap, and within `regressed` by `|deltaPct|` descending then id;
- a baseline captured later than the current run still reads `from` = baseline (review focus 2);
- `evidence` counts by kind across both runs, sorted by kind, with `delta`;
- different apps throw with both package names in the message (review focus 3);
- `totals` counts every row exactly once and `regressed + improved + unchanged + incomparable + gaps` equals `rows.length`;
- neither input is mutated, and two builds of the same inputs are `JSON.stringify`-equal.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-movement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildMovement`**

Build a `Map<string, Metric>` per side, take the union of ids sorted, skip ids ending in `.degraded` (count them), judge each with a small `judge(id, fromMetric, toMetric)` helper, then sort with a comparator that encodes the group order. Evidence counts come from a `Map<EvidenceKind, number>` per side. No IO, no mutation.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/report-movement.test.ts`
Expected: PASS.

- [ ] **Step 5: Export and commit**

Re-export `buildMovement` and its types from `packages/core/src/index.ts` (value exports: `buildMovement`; types: `MovementEvidenceRow`, `MovementInput`, `MovementRow`, `MovementSide`, `MovementStatus`, `RootCauseMovement`), and add `buildMovement` to `VALUE_EXPORTS`.

```bash
git add packages/core/src/report/movement.ts packages/core/src/index.ts \
  packages/core/test/report-movement.test.ts packages/core/test/types.test.ts
git commit -m "feat(root-cause): deterministic cross-run movement of metrics and findings"
```

---

### Task 2: The movement in the document and its Markdown

**Files:**
- Modify: `packages/core/src/report/root-cause.ts`, `packages/core/src/report/root-cause-markdown.ts`
- Test: `packages/core/test/report-root-cause.test.ts`, `report-root-cause-markdown.test.ts`

**Interfaces:**
- Consumes: `RootCauseMovement` from Task 1.
- Produces:
```ts
// root-cause.ts
export const ROOT_CAUSE_SCHEMA_VERSION = 2;
export interface RootCauseDocument {
  // …unchanged fields…
  /** Present only when the caller supplied a baseline run. */
  movement?: RootCauseMovement;
}
export interface RootCauseInput {
  // …unchanged fields…
  movement?: RootCauseMovement;
}
export function buildRootCauseDocument(input: RootCauseInput): RootCauseDocument;
```
- The document copies `movement` (and its arrays/objects) rather than referencing the caller's object, in the same way it already copies `scene` and `generator`.

- [ ] **Step 1: Write the failing tests**

In `report-root-cause.test.ts`:
- `schemaVersion` is `ROOT_CAUSE_SCHEMA_VERSION` (2), asserted against the constant, not the literal;
- a document built without movement has `movement === undefined` and its JSON carries no `movement` key;
- a document built with movement carries it, and mutating the input movement after the call does not change the document (copied, not referenced).

In `report-root-cause-markdown.test.ts`:
- the "What moved" section appears **before** "## Verdict" when movement is present, and is absent entirely when it is not;
- the section states the from/to labels, the movement verdict sentence, one table row per metric with status and `—` for a gap value, and the evidence-kind table;
- a gap row prints its reason and never prints a delta (review focus 1);
- an `incomparable` row prints its delta but no status verdict word that implies good or bad;
- the same document renders byte-identically twice.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-root-cause.test.ts packages/core/test/report-root-cause-markdown.test.ts`
Expected: FAIL — `movement` is not a known property / schema is 1.

- [ ] **Step 3: Implement**

Bump `ROOT_CAUSE_SCHEMA_VERSION` to 2 and document why in the constant's doc comment (an additive optional field is still a shape change). Add `movement?` to `RootCauseInput` and `RootCauseDocument`; `buildRootCauseDocument` spreads a deep copy (`rows`, `evidence`, `totals`, `from`, `to`) when present. In `root-cause-markdown.ts`, add `renderMovement(movement): string[]` and call it after the header block, before `## Verdict`. Reuse the existing `cell()` escaping for every string; a `null` value renders `—`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/report-root-cause.test.ts packages/core/test/report-root-cause-markdown.test.ts`
Expected: PASS. Any other test asserting `schemaVersion === 1` for a root-cause document is updated to the constant.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/root-cause.ts packages/core/src/report/root-cause-markdown.ts \
  packages/core/test/report-root-cause.test.ts packages/core/test/report-root-cause-markdown.test.ts
git commit -m "feat(root-cause): movement section in the document and its report"
```

---

### Task 3: The model turn over the movement

**Files:**
- Modify: `packages/core/src/report/root-cause-model.ts`
- Test: `packages/core/test/report-root-cause-model.test.ts`

**Interfaces:**
- Consumes: `RootCauseDocument.movement` from Task 2.
- Produces:
```ts
export interface RootCauseSuspect {
  // …unchanged fields…
  /** Moved metric ids the model attributes the change to; checked against the movement. */
  metrics: string[];
}
export function rootCausePrompt(document: RootCauseDocument): string;
export function parseRootCauseAnswer(
  content: string, document: RootCauseDocument, model: string,
): RootCauseAnalysis;
export function groundingVocabulary(document: RootCauseDocument): Set<string>;
```
- The answer shape gains `"metrics": ["moved metric ids you attribute the change to"]`.
- `parseRootCauseAnswer` filters `metrics` against the movement's row ids; an unknown id goes to `ungrounded`. With no movement, every cited metric is ungrounded.
- `groundingVocabulary` adds every movement row id, every evidence-kind name in the movement table, and both side labels, so a suspect quoting `frame.jank.rate` is not flagged as invented.

- [ ] **Step 1: Write the failing tests**

In `report-root-cause-model.test.ts`:
- the prompt with movement names both labels, the movement verdict, and the top regression's metric id, and asks for `metrics` (review focus 5);
- the prompt without movement contains no `metrics` instruction and no movement heading;
- a suspect citing a moved metric id keeps it in `metrics` and is not `ungrounded`;
- a suspect citing a metric id that is not a movement row lands in `ungrounded` (review focus 5);
- a suspect citing any metric when there is no movement block lands in `ungrounded` (review focus 5);
- the vocabulary contains a moved metric id and the side labels;
- an answer whose `metrics` is not an array is treated as no citations (not a refusal), matching how `evidenceIds` is read;
- the existing no-movement behaviour is unchanged: same observations, same ranking, same `analysis` shape.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/core/test/report-root-cause-model.test.ts`
Expected: FAIL — `metrics` is not read / prompt has no movement section.

- [ ] **Step 3: Implement**

Add a movement block to `rootCausePrompt` after the observations: a heading naming `from → to`, the movement verdict, up to `PROMPT_MOVEMENT_LIMIT = 20` rows rendered as `- [metric id] status from → to (deltaPct%)`, the evidence table, and a rule telling the model to cite moved metric ids in `metrics`. Extend `ANSWER_SHAPE` with the `metrics` key. In `parseRootCauseAnswer`, build `knownMetrics` from `document.movement?.rows` and filter. In `groundingVocabulary`, add movement row ids, kinds and labels.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project unit packages/core/test/report-root-cause-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/report/root-cause-model.ts packages/core/test/report-root-cause-model.test.ts
git commit -m "feat(root-cause): let a model attribute the change to moved metrics"
```

---

### Task 4: `root-cause --baseline`

**Files:**
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/program.ts`
- Test: `packages/cli/test/root-cause-cli.test.ts`, `root-cause-deps.test.ts`, `program.test.ts`

**Interfaces:**
- `RootCauseRequest` gains `baseline?: string` (a scene directory, a `report.json` file, or a report bundle directory — the same three kinds `input` accepts).
- `RootCauseOutput` is unchanged; the movement travels inside `document`.
- CLI: `ohos-perf root-cause <input> --out <dir> [--baseline <input>] [--offline] [--model <name>] [--app <packageName>] [--json]`.
- The seam loads both sides through one `loadRootCauseSource(input, app?)` helper, builds the movement, and refuses an app mismatch with `ROOT_CAUSE_BAD_BASELINE` before any model call. `RootCauseSource` gains `metrics: Metric[]` so the report and scene paths both supply one.

- [ ] **Step 1: Write the failing tests**

In `root-cause-cli.test.ts` (stubbed seam):
- `--baseline` is forwarded as `baseline`;
- the human summary prints a `movement` line naming both labels and the regression count when the document carries movement, and prints no such line when it does not;
- `--json` prints the document with the movement block intact.

In `root-cause-deps.test.ts` (real `realDeps`, temp scenes/reports):
- two scenes with different jank rates produce a movement whose `regressed` row is `frame.jank.rate`, and the written `root-cause.json` carries it;
- a baseline given as a report bundle and as a scene both work;
- two scenes for different apps are refused with `ROOT_CAUSE_BAD_BASELINE` naming both, before the model seam is consulted (assert with an injected `rootCauseModel` that would throw if called);
- a baseline whose `startedAtNs` is later than the input's still reports `from` = baseline (review focus 2);
- `--offline --baseline` writes the movement and never asks a model;
- the baseline's own degraded analyzer yields a `gap` row and not an improvement (review focus 1).

In `program.test.ts`: `--baseline` is forwarded, and omitted when not given.

- [ ] **Step 2: Run to watch them fail**

Run: `npx vitest run --project unit packages/cli/test/root-cause-cli.test.ts packages/cli/test/root-cause-deps.test.ts packages/cli/test/program.test.ts`
Expected: FAIL — `baseline` is not a known request field.

- [ ] **Step 3: Implement**

Extract the existing input-loading branch of the `rootCause` seam into `loadRootCauseSource(input, app?)`, add `metrics` to `RootCauseSource` (scene: `detailed.run.result.metrics`; report: flattened sections' metrics), and call it for the baseline when `req.baseline !== undefined`. Build the movement with the baseline first. On a mismatch, throw `OhosPerfError` with code `ROOT_CAUSE_BAD_BASELINE` naming both apps. Pass `movement` into `buildRootCauseDocument`. In `commands.ts`, add the summary line `movement    <from> → <to>: N regressions, M improvements, K gaps` when present. In `program.ts`, add `--baseline <input>` with help text stating that movement is always baseline → input.

- [ ] **Step 4: Run to verify green**

Run: `npm run build -w packages/cli && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src packages/cli/test
git commit -m "feat(root-cause): --baseline answers what changed between two runs"
```

---

### Task 5: Docs, skill, release 0.27.0

**Files:**
- Modify: `README.md`, `site/index.html`, `CHANGELOG.md`, `skill/ohos-perf/SKILL.md`,
  `packages/core/package.json`, `packages/cli/package.json`, lockfile.

**Interfaces:**
- Consumes: everything above.
- Produces: a "What moved" subsection under Root cause (en and zh), a P32 roadmap row, a site card and eyebrow P1–P32, the 0.27.0 changelog entry, and skill guidance telling an agent to run `root-cause --baseline` when a metric regressed and to report a `gap` as "not measured", never as an improvement.

- [ ] **Step 1: Write the docs**

- README: under Root cause, add `--baseline`, the movement table shape, the sentence that a gap is never a movement, and the HapRay contrast: HapRay's multi-version page leaves the comparison to a human reading dropdowns, and its root cause sees one run. Add the P32 roadmap row and update the quoted test counts.
- Site: P32 card (en + zh), eyebrow P1–P32, stat tiles, a `root-cause --baseline` quickstart line.
- `CHANGELOG.md`: 0.27.0.
- SKILL.md: when to use `--baseline`, how to read `regressed` vs `gap`, and that `metrics` citations are checked like `evidenceIds`.

- [ ] **Step 2: Bump and verify**

Both package versions and the CLI's core pin to `0.27.0`; refresh the lockfile; delete a stale `packages/cli/node_modules/@ohos-perf` copy if npm materialized one; `npm run build -w packages/cli`; `npm run verify`; `npm run test:device`.

- [ ] **Step 3: Measure the quoted counts**

Run the clean-checkout procedure (rename `spike/out/*.db` → `*.hidden` with a `trap` restore, `npm run test:unit`) and the full run with fixtures present; update README, site eyebrow and stat tiles to the measured numbers.

- [ ] **Step 4: Live smoke**

Capture or reuse two real scenes with a measurable difference (or two report bundles), run `root-cause --baseline` offline, and confirm the movement names the metric that actually moved, with the right direction and a `gap` where one side lacked it.

- [ ] **Step 5: Review, then release**

Whole-branch review (fresh agent, most capable model) before tagging; fix Critical/Important red-first, one pass. Then commit, tag `v0.27.0`, push, publish both packages with the token userconfig, poll `registry.npmjs.org` (the local registry is npmmirror and lags), fresh-install smoke, `gh release create`, confirm CI and Pages, verify the live site.
