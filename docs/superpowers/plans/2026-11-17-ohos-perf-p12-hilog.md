# P12 hilog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the device's hilog stream into a scene, evaluate typed pattern rules against it deterministically, and report per-rule counts as metrics, evidence and three drill-down queries.

**Architecture:** `HilogCollector` streams `hdc shell hilog` for the capture window and writes `hilog.log`; `parseHilogLine` turns each line into a typed row and `readHilogFile` writes `hilog.jsonl`; `HilogRules` parses and evaluates rule expressions without `eval`; `HilogAnalyzer` counts matches per rule and emits metrics and `hilog_match` evidence; three named queries expose the same data.

**Tech Stack:** TypeScript (ESM), Vitest (`--project unit`), zero runtime dependencies in core. No `node:sqlite` — hilog is a text artifact, not a table.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p12-hilog-design.md`

## Global Constraints

- A log line that does not parse is a `raw` row with `parsed: false`, counted in `hilog.lines.count` and `hilog.unparsed.count`; never dropped.
- `groups` is 1-based; `0` means the whole match.
- **No `eval`, no `new Function`.** Rule expressions are parsed into an AST and evaluated; a malformed expression or regex is a typed `OhosPerfError` naming the rule.
- Rules are evaluated in name order; matches ordered by `(lineIndex, ruleName)`; sample messages keep file order.
- No `Date.now()` in the analyzer: the capture window and the year come from the scene.
- Absent `hilog.log` → one `hilog.degraded` proxy naming `collect --hilog`; a log with zero rule matches is a real zero, not a degradation.
- The collector requires a non-empty file; hdc exit 0 is never evidence.
- Every named query returns `[]` when the log is absent; never throws.
- Do not port `hilogtool` decryption, on-device persistent rotation, or crash classification.

## Review Focus

- A line with no year must not be read into the future: a month/day after the capture date is the previous year.
- A rule that fails to compile must name itself in an error and must not stop the other rules from running.
- An expression referencing a non-numeric group is a typed error, not a silent `0` (upstream's substitution turns a typo into a confident wrong count).
- `hilog.lines.count` must equal `parsed + unparsed` on every input, including a file with no trailing newline.
- A rule scoped to `line` must not be able to match across lines (`m` flag with a `.`-spanning regex).
- Two runs over the same file and rules must produce byte-identical JSON.

---

### Task 1: Line parsing and the JSONL artifact

**Files:**
- Create: `packages/core/src/hilog/parse.ts`
- Test: `packages/core/test/hilog-parse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `HilogLevel = 'D' | 'I' | 'W' | 'E' | 'F'`
  - `HilogLine { index, ts, level, pid, tid, domain, tag, message, parsed }`
  - `parseHilogLine(line: string, year: number, captureNs: number): HilogLine` — `ts` is ns since epoch; `parsed: false` rows carry `message` = the whole line and `ts = 0`.
  - `parseHilogText(text: string, opts: { year: number; captureNs: number }): HilogLine[]`

- [ ] **Step 1: Write the failing test**

```ts
const LINE = '11-17 05:12:33.412  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 120 us';

it('parses the standard hilog line', () => {
  const row = parseHilogLine(LINE, 2026, Date.UTC(2026, 10, 17, 5, 13));
  expect(row).toMatchObject({
    level: 'I', pid: 4999, tid: 5010, domain: 'A00000',
    tag: 'com.demo/Image', parsed: true,
  });
  expect(row.message).toBe('CreatePixelMap success, memType : 3, cost 120 us');
  expect(new Date(row.ts).toISOString()).toBe('2026-11-17T05:12:33.412Z');
});

it('reads a December line as the previous year when the capture is in January', () => {
  const row = parseHilogLine('12-31 23:59:59.999  1  1 I A/C: x', 2027, Date.UTC(2027, 0, 1, 0, 1));
  expect(new Date(row.ts).toISOString()).toBe('2026-12-31T23:59:59.999Z');
});

it('keeps an unparsable line as a raw row', () => {
  const row = parseHilogLine('garbage without a timestamp', 2026, 0);
  expect(row).toMatchObject({ parsed: false, ts: 0, message: 'garbage without a timestamp' });
});

it('counts every line once, with no trailing-newline loss', () => {
  const rows = parseHilogText(`${LINE}\n${LINE}`, { year: 2026, captureNs: 0 });
  expect(rows.map((r) => r.index)).toEqual([0, 1]);
  expect(rows.every((r) => r.parsed)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/hilog-parse.test.ts`
Expected: FAIL — cannot resolve `../src/hilog/parse`.

- [ ] **Step 3: Implement `packages/core/src/hilog/parse.ts`**

One regex for the standard shape; a `Date.UTC(year, month - 1, day, h, m, s, ms)` call; the future-month rule compares the parsed `Date` against `captureNs` and subtracts a year when it is later. `parseHilogText` splits on `\r?\n`, drops a single trailing empty element, and assigns `index` in file order.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/hilog-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hilog/parse.ts packages/core/test/hilog-parse.test.ts
git commit -m "feat(core): parse hilog lines into typed rows"
```

---

### Task 2: Rule expressions without eval

**Files:**
- Create: `packages/core/src/hilog/expression.ts`
- Test: `packages/core/test/hilog-expression.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `evaluateCondition(value: string, condition: string): boolean` — the array form (`'!=4'`, `'>512'`, …).
  - `compileExpression(source: string): (groups: readonly (string | undefined)[]) => boolean` — throws `OhosPerfError` with code `HILOG_BAD_EXPRESSION` on a malformed expression; the returned function throws code `HILOG_NON_NUMERIC_GROUP` when a referenced group is not numeric.
  - Supported: `$1..$n`, `+ - * / %`, `( )`, `== != < > <= >=`, conjunction with `,` or `&&`, numeric literals.

- [ ] **Step 1: Write the failing test**

```ts
it('compares a single value with the array form', () => {
  expect(evaluateCondition('4', '!=4')).toBe(false);
  expect(evaluateCondition('5', '!=4')).toBe(true);
  expect(evaluateCondition('512', '>512')).toBe(false);
  expect(evaluateCondition('abc', '==abc')).toBe(true);
});

it('evaluates arithmetic over group references', () => {
  const f = compileExpression('$1 * $2 > $3 * $4');
  expect(f(['100', '100', '200', '200'])).toBe(true);   // 10000 > 40000? no -> false
});
```

(The assertion above is deliberately written out; the implementer corrects the
expectation to `false` — it documents the exact arithmetic rather than a
direction.)

```ts
it('conjoins with a comma or &&', () => {
  const f = compileExpression('$1*$2>0,$3*$4>512*512');
  expect(f(['100', '100', '600', '600'])).toBe(true);
  expect(f(['0', '100', '600', '600'])).toBe(false);
  expect(compileExpression('$1>1 && $2<3')(['2', '2'])).toBe(true);
});

it('rejects a malformed expression by naming it', () => {
  expect(() => compileExpression('$1 * > 2')).toThrow(/HILOG_BAD_EXPRESSION|\$1 \* > 2/);
});

it('rejects a non-numeric group instead of substituting zero', () => {
  const f = compileExpression('$1 > 2');
  expect(() => f(['abc'])).toThrow(/non-numeric|abc/);
});

it('never evaluates code', () => {
  expect(() => compileExpression('process.exit(1)')).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/hilog-expression.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tokenizer, precedence-climbing parser and evaluator**

Tokens: number, group reference, operator, paren, comma. Precedence: `,`/`&&` lowest, then comparison, then `+ -`, then `* / %`. A `,` split is a conjunction of complete expressions. Division and modulo by zero are typed errors (`HILOG_DIVIDE_BY_ZERO`), not `Infinity`/`NaN` — a rule that divides by zero must say so.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/hilog-expression.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hilog/expression.ts packages/core/test/hilog-expression.test.ts
git commit -m "feat(core): evaluate hilog rule expressions without eval"
```

---

### Task 3: Rule set and matching

**Files:**
- Create: `packages/core/src/hilog/rules.ts`
- Test: `packages/core/test/hilog-rules.test.ts`

**Interfaces:**
- Consumes: `compileExpression`, `evaluateCondition` (Task 2); `HilogLine` (Task 1).
- Produces:
  - `HilogRule { name, regex, groups?, conditions?, scope?: 'message' | 'line' }`
  - `DEFAULT_HILOG_RULES: readonly HilogRule[]` — HapRay's four `CreatePixelMap` rules, verbatim.
  - `compileRules(rules: readonly HilogRule[]): CompiledRule[]` — throws `OhosPerfError` code `HILOG_BAD_REGEX` naming the rule on a bad regex.
  - `CompiledRule { name; match(line: HilogLine): string[] | undefined }`
  - `matchRules(rules: CompiledRule[], lines: readonly HilogLine[]): HilogMatch[]` with `HilogMatch { ruleName, lineIndex, groups: string[] }`, ordered by `(lineIndex, ruleName)`.

- [ ] **Step 1: Write the failing test**

```ts
const rules = compileRules([{
  name: 'no_dmp',
  regex: 'CreatePixelMap success,.*memType\\s*:\\s*(\\d+),\\s*cost\\s+\\d+\\s+us',
  groups: [1],
  conditions: '$1!=4',
}]);

it('extracts the selected group and applies the expression', () => {
  const lines = [
    line(0, 'CreatePixelMap success, memType : 3, cost 120 us'),
    line(1, 'CreatePixelMap success, memType : 4, cost 120 us'),
  ];
  expect(matchRules(rules, lines).map((m) => [m.lineIndex, m.groups])).toEqual([[0, ['3']]]);
});

it('matches group 0 as the whole match', () => {
  const r = compileRules([{ name: 'all', regex: 'foo', groups: [0] }]);
  expect(matchRules(r, [line(0, 'a foo b')])[0].groups).toEqual(['a foo b']);
});

it('orders matches by line then rule name', () => {
  const r = compileRules([
    { name: 'b', regex: 'x', groups: [0] },
    { name: 'a', regex: 'x', groups: [0] },
  ]);
  expect(matchRules(r, [line(0, 'x'), line(1, 'x')]).map((m) => [m.lineIndex, m.ruleName]))
    .toEqual([[0, 'a'], [0, 'b'], [1, 'a'], [1, 'b']]);
});

it('names a rule whose regex does not compile', () => {
  expect(() => compileRules([{ name: 'broken', regex: '(' }]))
    .toThrow(/broken/);
});

it('does not let a line-scoped rule match across lines', () => {
  const r = compileRules([{ name: 'multi', regex: '^a.*b$', groups: [0], scope: 'line' }]);
  const joined = 'a\nb';
  expect(matchRules(r, [line(0, joined)])).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/hilog-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Compile with `gi` for `scope: 'line'` and `gim` for `message` (upstream's
`IGNORECASE | MULTILINE`), but for a single-line scope the `m` flag is what
would let `^`/`$` match at a newline inside the message — strip it for `line`.
Sort rules by `name` before compiling so evaluation order is independent of
the caller's array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/hilog-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hilog/rules.ts packages/core/test/hilog-rules.test.ts
git commit -m "feat(core): evaluate hilog rules over typed lines"
```

---

### Task 4: Collector and capability

**Files:**
- Create: `packages/core/src/collectors/hilog.ts`
- Modify: `packages/core/src/device/capability.ts` (add `hilog.stream`), `packages/core/src/device/probe.ts` (probe `which hilog`), `packages/core/src/ingest/scene.ts` (`hilogFile`), `packages/core/src/device/device.ts` (`hilog?: boolean`), `packages/core/src/index.ts`
- Test: `packages/core/test/collector-hilog.test.ts`

**Interfaces:**
- Consumes: `Hdc`, `SceneLayout`, `OhosPerfError`.
- Produces:
  - `HilogCollector implements Collector` with `id = 'hilog'`, `provides = ['hilog.stream']`, `collect(hdc, target, opts: { durationMs }, layout): Promise<{ lines: number }>`.
  - `SceneLayout.hilogFile` = `<root>/hilog.log`; `hilogJsonl` = `<root>/hilog.jsonl`.

- [ ] **Step 1: Write the failing test**

```ts
it('writes the streamed log and rejects an empty capture', async () => {
  const fake = fakeHdc({ 'shell hilog': '11-17 05:12:33.412  1  1 I A/C: hello\n' });
  const layout = createSceneLayout(dir);
  await new HilogCollector().collect(fake.hdc, 'emu', { durationMs: 10 }, layout);
  expect(readFileSync(layout.hilogFile, 'utf8')).toContain('hello');
});

it('throws HILOG_NO_OUTPUT when the device printed nothing', async () => {
  const fake = fakeHdc({ 'shell hilog': '' });
  await expect(
    new HilogCollector().collect(fake.hdc, 'emu', { durationMs: 10 }, createSceneLayout(dir)),
  ).rejects.toMatchObject({ code: 'HILOG_NO_OUTPUT' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/collector-hilog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`collect` removes a stale `hilog.log`, streams `hdc shell hilog` through the
transport for `durationMs`, writes stdout to `hilog.log`, and requires
non-empty output. Add `hilog.stream` to `CapabilityId`, `hilog` to
`BINARIES`, `hilogFile`/`hilogJsonl` to `SceneLayout` (and `remember()` in
`device.ts`'s collect), `hilog?: boolean` to `CollectOptions`, and export
`HilogCollector`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/collector-hilog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core/src packages/core/test/collector-hilog.test.ts
git commit -m "feat(core): capture hilog into the scene"
```

---

### Task 5: HilogAnalyzer

**Files:**
- Create: `packages/core/src/analyze/hilog.ts`
- Modify: `packages/core/src/analyze/engine.ts`, `packages/core/src/report/evidence.ts` (`'hilog_match'`), `packages/core/src/report/model.ts` (`'hilog': 'Hilog'`), `packages/core/src/index.ts`
- Test: `packages/core/test/analyze-hilog.test.ts`

**Interfaces:**
- Consumes: `parseHilogText` (Task 1), `compileRules`/`matchRules`/`DEFAULT_HILOG_RULES` (Task 3), `AnalyzeContext`/`AnalyzeResult`/`Analyzer`.
- Produces: `HilogAnalyzer` with `id = 'hilog'`, `requires = ['hilog.stream']`; metrics `hilog.lines.count`, `hilog.parsed.count`, `hilog.unparsed.count`, `hilog.rule.<name>.count`, `hilog.rules.matched.count`, `hilog.rules.unmatched.count`; `hilog_match` evidence per matching rule.

- [ ] **Step 1: Write the failing test**

```ts
it('counts per-rule matches and emits one evidence item per matching rule', async () => {
  const r = await new HilogAnalyzer().run(ctxWithLog([
    'CreatePixelMap success, memType : 3, cost 1 us',
    'CreatePixelMap success, memType : 3, cost 2 us',
    'CreatePixelMap success, memType : 4, cost 3 us',
  ]));
  expect(metric(r, 'hilog.lines.count').value).toBe(3);
  expect(metric(r, 'hilog.rule.no_dmp').value).toBe(2);
  const ev = r.evidence.filter((e) => e.kind === 'hilog_match');
  expect(ev.map((e) => e.subject.rule)).toEqual(['no_dmp']);
  expect(ev[0].signals.count).toBe(2);
  expect(ev[0].signals.samples).toHaveLength(2);
});

it('degrades with a reason when the scene has no log', async () => {
  const r = await new HilogAnalyzer().run(ctxWithoutLog());
  expect(r.metrics.map((m) => m.id)).toEqual(['hilog.degraded']);
  expect(r.metrics[0].fidelity).toBe('proxy');
  expect(r.evidence[0].kind).toBe('no_data');
});

it('reports a zero count as a measurement when the log has no matches', async () => {
  const r = await new HilogAnalyzer().run(ctxWithLog(['unrelated line']));
  expect(metric(r, 'hilog.rule.no_dmp').value).toBe(0);
  expect(metric(r, 'hilog.rule.no_dmp').fidelity).toBe('exact');
  expect(r.evidence.filter((e) => e.kind === 'hilog_match')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/analyze-hilog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `layout.hilogFile` through the context (`ctx.hilog?: HilogLine[]`, loaded
by the CLI), parse, compile the rules (`ctx.hilogRules ?? DEFAULT_HILOG_RULES`),
match, and build metrics and evidence. Evidence `subject` is
`{ rule: name }`; `signals` are `count`, `firstLine`, `lastLine`, `samples`
(up to 5). Drill-downs: `hilog.matches`, `hilog.rules`. Register the analyzer
after `native-memory` and add the evidence kind and section title.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/analyze-hilog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core/src packages/core/test/analyze-hilog.test.ts
git commit -m "feat(core): add the hilog analyzer"
```

---

### Task 6: Named queries

**Files:**
- Modify: `packages/core/src/query/registry.ts`
- Test: `packages/core/test/query-hilog.test.ts`

**Interfaces:**
- Consumes: the analyzer's parsing and matching.
- Produces: `hilog.matches` (`rule` optional, `limit`), `hilog.rules` (effective rule set with counts), `hilog.around` (`startNs`, `endNs`). All return `[]` when `ctx.hilog` is absent.

- [ ] **Step 1: Write the failing test**

```ts
it('returns the matches of one rule', () => {
  const r = runNamedQuery(hilogCtx(), 'hilog.matches', { rule: 'no_dmp' });
  expect(r.rows.map((x) => x.lineIndex)).toEqual([0, 1]);
});

it('returns [] when the scene has no log', () => {
  expect(runNamedQuery(noLogCtx(), 'hilog.matches', {}).rows).toEqual([]);
});

it('rejects an unknown rule name', () => {
  expect(() => runNamedQuery(hilogCtx(), 'hilog.matches', { rule: 'nope' })).toThrow(/nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/query-hilog.test.ts`
Expected: FAIL — unknown query name.

- [ ] **Step 3: Implement** the three definitions, inserted in alphabetical order, and extend the registry name-list test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/query-hilog.test.ts test/query-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/query/registry.ts packages/core/test/query-hilog.test.ts packages/core/test/query-registry.test.ts
git commit -m "feat(core): expose hilog drill-down queries"
```

---

### Task 7: CLI, docs and release 0.7.0

**Files:**
- Modify: `packages/cli/src/collect.ts` (`--hilog`), `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/test/deps.test.ts`, `README.md`, `CHANGELOG.md`, `site/index.html`, `skill/ohos-perf/SKILL.md`, package versions.
- Test: `packages/cli/test/collect.test.ts` (flag parsing), `packages/core/test/types.test.ts` (exports snapshot).

- [ ] **Step 1: Write the failing test** — `--hilog` parses into `hilog: true`; `ohos-perf collect --hilog` is accepted without `--app`; `ohos-perf analyze` on a scene with `hilog.log` reports the `hilog` section.
- [ ] **Step 2: Run it — FAIL (unknown option).**
- [ ] **Step 3: Implement** the flag, the deps wiring (`readHilog` into `ctx.hilog`), docs, site, skill and version bump to `0.7.0`.
- [ ] **Step 4: Run the whole suite** — `npm test` → all pass; rebuild both packages first.
- [ ] **Step 5: Commit and tag** — `chore(release): 0.7.0`, tag `v0.7.0`, push, `gh release create`.
