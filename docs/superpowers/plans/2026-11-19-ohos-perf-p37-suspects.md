# P37 — OhmBench: a source-level performance-bug detector, and the measured comparison

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ohos-perf suspects` — a static detector that reads an ArkTS source tree and ranks the code locations most likely to be a performance root cause, with `file` + `class` + `symbol` + line range — then measure it and HapRay against OhmBench and record both results.

**Architecture:** A lexer-lite ArkTS scanner in `packages/core/src/source/` (no full parser: the patterns are line-local or brace-block-local), a rule engine whose every rule is a named, tested predicate over a file's facts, and a CLI command that prints the benchmark's own `suspects[]` record shape so a run is scorable by the benchmark's published matcher. Detection is ranked by *how much work the code does*, which is the benchmark's oracle: every case is "the unfixed variant retires more instructions than the fixed one".

**Tech Stack:** TypeScript (ESM, no new dependencies), Vitest 2.1.9, commander 12.

**Spec:** `docs/superpowers/specs/2026-11-19-ohos-perf-p37-suspects-design.md`

## Global Constraints

- Node `^22.13.0 || >=23.4.0`; ESM-only; no new runtime dependencies (`package.json` `dependencies` stays empty in both packages).
- `npm run verify` must pass after every task: `npm run build && npm run typecheck && npm run test:unit`. After any `packages/cli/src` edit run `npm run build -w packages/cli` first (a bundle-freshness test compares the built bundle to the sources).
- Output must be byte-stable for identical input (D5): every list is sorted by an explicit total order, never by filesystem order.
- Every reported suspect carries the line range of the *symbol it names*, taken from the source, never from a guess.
- No claim of measurement where none was made: a rule that fires says which pattern it matched, and the confidence is a property of the rule, not of the score.
- The benchmark's `groundtruth.json`, `case.json#source`, `fix.patch` and `hosts/` are evaluator-only. The detector is developed against the unfixed trees only; the scoring harness reads groundtruth, and it lives outside `packages/` (under `bench/`) so no shipped code depends on it.
- Attribution: git commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

The input classes the spec implies but no task's tests exercise, most likely to bite a user first:

1. **A `.ets` file that is not valid TypeScript** — ArkTS allows decorators (`@Component`, `@State`) and builder syntax (`build() { Column() { … } }`) that a TS grammar rejects. The scanner must be line- and brace-oriented, never a parser, or one decorated struct throws and the whole tree yields nothing.
2. **A string literal containing a SQL statement split across concatenation** (`'select … ' + TABLE + ' where …'`) — the benchmark's `jingmo_random_poem_orderby_random` primary is exactly this. A rule that only looks at one literal misses it.
3. **The same symbol defined twice** (an overload pair, or a getter beside a field) — a suspect must name one location, so the scanner must deduplicate by `(file, class, symbol)` and keep the widest line range.
4. **A file with CRLF line endings** — reconstructed benchmark trees are LF, but a real project on Windows is not, and an off-by-one in line numbers makes every suspect miss its `scope_lines` overlap.
5. **A source tree with 2 000 files** — the whole detector must finish in seconds and its memory must not grow with total bytes read.

---

### Task 1: The ArkTS scanner

**Files:**
- Create: `packages/core/src/source/scan.ts`
- Create: `packages/core/test/source-scan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SourceSymbol {
    /** Class or struct name, or undefined at module scope. */
    readonly className?: string;
    readonly symbol: string;
    /** 1-based, inclusive. */
    readonly lineStart: number;
    readonly lineEnd: number;
    /** Every line of the body, verbatim, joined with '\n'. */
    readonly body: string;
    /** The whole declaration text from its decorators to its closing brace. */
    readonly declaration: string;
  }
  export interface SourceFile {
    /** Path relative to the scanned root, with '/' separators. */
    readonly path: string;
    readonly lines: readonly string[];
    readonly symbols: readonly SourceSymbol[];
    /** Module-scope lines: everything no symbol's body covers. */
    readonly moduleLines: readonly string[];
  }
  export function scanSourceFile(path: string, text: string): SourceFile;
  export function scanSourceTree(root: string): SourceFile[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { scanSourceFile } from '../src/source/scan';

describe('scanSourceFile', () => {
  it('finds a struct method and its line range', () => {
    const text = [
      '@Component',
      'export struct HomePage {',
      '  aboutToAppear(): void {',
      '    load()',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('pages/HomePage.ets', text);
    expect(file.symbols).toHaveLength(1);
    const [symbol] = file.symbols;
    expect(symbol?.className).toBe('HomePage');
    expect(symbol?.symbol).toBe('aboutToAppear');
    expect(symbol?.lineStart).toBe(3);
    expect(symbol?.lineEnd).toBe(5);
  });

  it('finds a class field holding a concatenated SQL string', () => {
    const text = [
      'export class DbCRUDConst {',
      '  static readonly READ_RANDOM: string =',
      "    'select * from t' +",
      "      ' where id = 1';",
      '}',
    ].join('\n');
    const file = scanSourceFile('DbConst.ets', text);
    const [symbol] = file.symbols;
    expect(symbol?.className).toBe('DbCRUDConst');
    expect(symbol?.symbol).toBe('READ_RANDOM');
    expect(symbol?.lineStart).toBe(2);
    expect(symbol?.lineEnd).toBe(4);
    expect(symbol?.body).toContain("' where id = 1'");
  });

  it('keeps the widest range when a name is declared twice', () => {
    const text = [
      'export class A {',
      '  get value(): number {',
      '    return 1',
      '  }',
      '  value(): number {',
      '    return 2',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols).toHaveLength(1);
    expect(file.symbols[0]?.lineStart).toBe(2);
    expect(file.symbols[0]?.lineEnd).toBe(7);
  });

  it('reads CRLF line endings without shifting line numbers', () => {
    const text = 'export class A {\r\n  run(): void {\r\n    go()\r\n  }\r\n}\r\n';
    const file = scanSourceFile('a.ets', text);
    expect(file.lines).toHaveLength(5);
    expect(file.symbols[0]?.lineStart).toBe(2);
    expect(file.symbols[0]?.lineEnd).toBe(4);
  });

  it('keeps module-scope lines outside every symbol', () => {
    const text = [
      'PersistentStorage.persistProp<Data[]>("homeList", [])',
      'export class A {',
      '  run(): void {}',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.moduleLines).toEqual(['PersistentStorage.persistProp<Data[]>("homeList", [])']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/source-scan.test.ts --project unit`
Expected: FAIL — `Cannot find module '../src/source/scan'`.

- [ ] **Step 3: Implement the scanner**

Line- and brace-oriented, no parser. A `{`/`}` counter that ignores braces inside string literals, template literals and `//`/`/* */` comments gives every block's extent; a declaration regex on a line at the block's head gives its name. Trailing commas and ArkTS decorator lines are skipped. `scanSourceTree` walks the root with `readdirSync({ withFileTypes: true })`, recurses, keeps `*.ets`/`*.ts`, skips `node_modules`, `.git`, `build`, `oh_modules`, and sorts paths with `localeCompare` — no, with a plain `<` comparison so the order is byte-stable across locales.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/source-scan.test.ts --project unit`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the tree-walk test**

```ts
it('walks a tree in byte order and skips build output', () => {
  const root = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(root, 'b'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'z.ets'), 'export class Z {}');
  writeFileSync(join(root, 'b', 'a.ets'), 'export class A {}');
  writeFileSync(join(root, 'node_modules', 'x.ets'), 'export class X {}');
  expect(scanSourceTree(root).map((file) => file.path)).toEqual(['b/a.ets', 'z.ets']);
});
```

Run: `npx vitest run packages/core/test/source-scan.test.ts --project unit` → PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/source/scan.ts packages/core/test/source-scan.test.ts
git commit -m "feat(source): scan an ArkTS tree into symbols with line ranges"
```

---

### Task 2: The rule engine and its first four rules

**Files:**
- Create: `packages/core/src/source/rules.ts`
- Create: `packages/core/src/source/suspects.ts`
- Create: `packages/core/test/source-rules.test.ts`

**Interfaces:**
- Consumes: `SourceFile`, `SourceSymbol` from Task 1.
- Produces:
  ```ts
  export interface Suspect {
    /** 1-based rank; 1 is the most likely root cause. */
    readonly rank: number;
    readonly file: string;
    readonly className?: string;
    readonly symbol?: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    /** The rule's id, e.g. 'sql-order-by-random'. */
    readonly rule: string;
    /** Why this fired, in the rule's own words, with the matched text. */
    readonly description: string;
    readonly confidence: 'high' | 'medium' | 'low';
  }
  export interface SourceFacts {
    readonly file: SourceFile;
    readonly symbol: SourceSymbol;
  }
  export interface Rule {
    readonly id: string;
    readonly category: 'latency' | 'cpu' | 'memory' | 'network';
    readonly confidence: 'high' | 'medium' | 'low';
    /** Returns a description when the rule fires on this symbol, else undefined. */
    match(facts: SourceFacts): string | undefined;
  }
  export const RULES: readonly Rule[];
  export function findSuspects(files: readonly SourceFile[]): Suspect[];
  ```

- [ ] **Step 1: Write the failing test for the four rules**

```ts
import { describe, it, expect } from 'vitest';
import { findSuspects } from '../src/source/suspects';
import { scanSourceFile } from '../src/source/scan';

const suspectsIn = (path: string, text: string) =>
  findSuspects([scanSourceFile(path, text)]);

describe('rules', () => {
  it('flags order by random() in a SQL string', () => {
    const rows = suspectsIn('DbConst.ets', [
      'export class DbCRUDConst {',
      "  static readonly READ: string = 'select * from p order by random() limit 1'",
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['sql-order-by-random']);
    expect(rows[0]?.className).toBe('DbCRUDConst');
    expect(rows[0]?.symbol).toBe('READ');
  });

  it('flags a SQL string assembled from concatenation', () => {
    const rows = suspectsIn('DbConst.ets', [
      'export class DbCRUDConst {',
      '  static readonly READ: string =',
      "    'select * from ' + TABLE +",
      "      ' where id = (select p.id from p order by random() limit 1)'",
      '}',
    ].join('\n'));
    expect(rows[0]?.rule).toBe('sql-order-by-random');
  });

  it('flags a DELETE inside a row loop', () => {
    const rows = suspectsIn('RdbUtils.ets', [
      'export class RdbUtils {',
      '  async deleteAll(dates: string[]): Promise<void> {',
      '    for (const date of dates) {',
      '      const rs = await this.query(`SELECT id FROM ${date}`)',
      '      while (rs.goToNextRow()) {',
      '        await this.executeSql(`DELETE FROM ${date} WHERE id = 1`)',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('sql-statement-in-loop');
  });

  it('flags ForEach over a collection inside a List or Scroll', () => {
    const rows = suspectsIn('List.ets', [
      'export struct Page {',
      '  build() {',
      '    List() {',
      '      ForEach(this.items, (item: Item) => {',
      '        ListItem() { Text(item.name) }',
      '      })',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['eager-foreach']);
    expect(rows[0]?.symbol).toBe('build');
  });

  it('flags a network call inside onChange', () => {
    const rows = suspectsIn('Search.ets', [
      'export struct Page {',
      '  build() {',
      '    TextInput()',
      '      .onChange((keyword: string) => {',
      "        axios.get('http://x/search', { params: { keyword } })",
      '      })',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['network-in-onchange']);
  });

  it('does not flag a loop that only accumulates', () => {
    const rows = suspectsIn('a.ets', [
      'export class A {',
      '  sum(xs: number[]): number {',
      '    let total = 0',
      '    for (const x of xs) { total += x }',
      '    return total',
      '  }',
      '}',
    ].join('\n'));
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/source-rules.test.ts --project unit`
Expected: FAIL — `Cannot find module '../src/source/suspects'`.

- [ ] **Step 3: Implement the four rules and the ranking**

Each rule is a small regex set over `facts.symbol.body` (or over `declaration` for fields). Ranking: sort by `confidence` (high → low), then by category weight (`latency` 3, `cpu` 2, `memory` 2, `network` 1), then by `file` then `lineStart` with a plain `<` comparison. Rank is assigned after sorting, 1-based. Deduplicate by `(file, className, symbol, rule)` keeping the first.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/source-rules.test.ts --project unit`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/source/rules.ts packages/core/src/source/suspects.ts packages/core/test/source-rules.test.ts
git commit -m "feat(source): four root-cause rules and the ranking"
```

---

### Task 3: The remaining rules, driven by the benchmark's defect shapes

**Files:**
- Modify: `packages/core/src/source/rules.ts`
- Modify: `packages/core/test/source-rules.test.ts`

**Interfaces:**
- Consumes: `Rule`, `findSuspects` from Task 2.
- Produces: the same `RULES` array, extended. No signature change.

The eight remaining shapes, each observed in an OhmBench unfixed tree:

| Rule id | Shape | Benchmark case it must catch |
|---|---|---|
| `ui-state-high-frequency` | `AppStorage.setOrCreate(` / `@State` assignment inside a `timeUpdate`/`on('timeUpdate')` callback | `cloudmusic_play_time_high_frequency_update`, `ytmusic_current_playing_timeupdate` |
| `db-write-in-loop` | `insert(` / `update(` / `executeSql(` awaited inside `for`/`forEach`/`map` | `jingmo_dataset_import_no_transaction`, `sheafreader_insert_duplicate_exception` |
| `sequential-await-loop` | `await` inside a `for` loop whose body awaits a call on `this.` | `sheafreader_refresh_feeds_sequential`, `sheafreader_unread_counts_n_plus_1` |
| `repeated-expensive-conversion` | `toLowerCase()` / `toUpperCase()` / `JSON.parse(` inside a loop or inside a per-item helper | `sheafreader_extract_tag_tolowercase`, `ytmusic_history_json_parse_per_row` |
| `persistent-storage-unbounded` | `PersistentStorage.persistProp` at module scope for a list-shaped key | `wanharmony_persisted_home_list_growth` |
| `unbounded-accumulation` | `putSync(`/`setSync(` appending to a store with no delete and no size cap in the same class | `interviewapp_search_history_unbounded` |
| `font-register-per-instance` | `font.registerFont(` with a `familyName` built from a random/uuid expression | `sepweather_font_register_per_page` |
| `http-session-not-destroyed` | `http.createHttp()` in a symbol with no `destroy()` in the same symbol or file | `weatherassistant_http_session_leak` |

- [ ] **Step 1: Write the failing test, one case per rule**

```ts
it('flags a state write inside a timeUpdate callback', () => {
  const rows = suspectsIn('P.ets', [
    'export class AVPlayerUtils {',
    '  play(): void {',
    "    this.player.on('timeUpdate', (time: number) => {",
    '      AppStorage.setOrCreate(StorageConstants.PLAY_TIME, time)',
    '    })',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('ui-state-high-frequency');
});

it('flags an awaited insert inside forEach', () => {
  const rows = suspectsIn('D.ets', [
    'export class Import {',
    '  async run(items: Item[]): Promise<void> {',
    '    items.forEach(async (item: Item) => {',
    "      await this.dao.insert('t', item)",
    '    })',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('db-write-in-loop');
});

it('flags a sequential await in a for loop', () => {
  const rows = suspectsIn('S.ets', [
    'export class FeedService {',
    '  async refresh(feeds: Feed[]): Promise<void> {',
    '    for (const feed of feeds) {',
    '      await this.refreshOne(feed.id)',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('sequential-await-loop');
});

it('flags toLowerCase inside a per-item helper', () => {
  const rows = suspectsIn('P.ets', [
    'export class FeedParser {',
    '  static extractTag(xml: string): string {',
    '    return xml.toLowerCase()',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('repeated-expensive-conversion');
});

it('flags an unbounded persistProp list', () => {
  const rows = suspectsIn('Home.ets', [
    'PersistentStorage.persistProp<Data[]>("homeList", [])',
    'export struct HomePage {}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('persistent-storage-unbounded');
});

it('flags an unbounded preference store', () => {
  const rows = suspectsIn('history.ets', [
    'export class HistoryStore {',
    '  setItem(keyword: string) {',
    '    this.store.putSync(keyword, keyword)',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('unbounded-accumulation');
});

it('flags a per-instance font family', () => {
  const rows = suspectsIn('F.ets', [
    'export class PageTitleFont {',
    '  static register(): string {',
    "    const family = 'PageTitle-' + util.generateRandomUUID()",
    "    font.registerFont({ familyName: family, familySrc: $rawfile('f.ttf') })",
    '    return family',
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('font-register-per-instance');
});

it('flags an http session that is never destroyed', () => {
  const rows = suspectsIn('W.ets', [
    'export class getWeatherUtil {',
    '  getWeather(code: number) {',
    '    const request = http.createHttp()',
    "    return request.request('http://x')",
    '  }',
    '}',
  ].join('\n'));
  expect(rows.map((row) => row.rule)).toContain('http-session-not-destroyed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/source-rules.test.ts --project unit`
Expected: FAIL — the eight new assertions report an empty array.

- [ ] **Step 3: Implement the eight rules**

`unbounded-accumulation` and `http-session-not-destroyed` are *negative* rules: they fire only when the escape hatch is absent from the whole file, so they take the `SourceFile` as well as the symbol. Extend `Rule.match` to `match(facts: SourceFacts & { file: SourceFile })` — it already receives the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/source-rules.test.ts --project unit`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/source/rules.ts packages/core/test/source-rules.test.ts
git commit -m "feat(source): eight more rules, one per defect shape the benchmark records"
```

---

### Task 4: The `suspects` command

**Files:**
- Create: `packages/cli/src/suspects.ts`
- Create: `packages/core/src/source/report.ts`
- Create: `packages/cli/test/suspects-cli.test.ts`
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/deps.ts`, `packages/cli/src/program.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `scanSourceTree`, `findSuspects`.
- Produces: `runSuspects(deps, { root, outDir?, top? }, { json })` in the CLI, and in core `renderSuspectsJson(root, suspects, meta): string` writing the benchmark's record shape.

The output is the benchmark's own `results/<tool>/<case-id>.json` shape, minus the cost fields a static run does not have:

```json
{
  "tool": "ohos-perf", "tool_version": "0.32.0",
  "inputs": ["source"],
  "suspects": [
    {"rank": 1, "file": "commons/constants/src/main/ets/DbConst.ets",
     "class": "DbCRUDConst", "symbol": "READ_RANDOM_CLASSICPOEM",
     "line_start": 28, "line_end": 32, "description": "...", "confidence": "high"}
  ]
}
```

- [ ] **Step 1: Write the failing CLI test**

```ts
it('prints the benchmark record shape for a source tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suspects-'));
  mkdirSync(join(root, 'commons'), { recursive: true });
  writeFileSync(join(root, 'commons', 'DbConst.ets'), [
    'export class DbCRUDConst {',
    "  static readonly READ: string = 'select * from p order by random() limit 1'",
    '}',
  ].join('\n'));
  const out = join(root, 'out');
  const result = await runSuspects(deps, { root, outDir: out, top: 5 }, { json: true });
  expect(result.suspects).toHaveLength(1);
  expect(result.suspects[0]).toMatchObject({
    rank: 1, file: 'commons/DbConst.ets', class: 'DbCRUDConst', symbol: 'READ',
    line_start: 2, line_end: 2, confidence: 'high',
  });
  expect(JSON.parse(readFileSync(join(out, 'suspects.json'), 'utf8')).suspects).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/cli/test/suspects-cli.test.ts --project unit`
Expected: FAIL — `Cannot find module '../src/suspects'`.

- [ ] **Step 3: Implement the command**

`--root <dir>` required, `--out <dir>` optional, `--top <n>` default 5 (the benchmark scores the top five). Print with the CLI's existing `emit` helper; write `suspects.json` when `--out` is given. Register the command beside `root-cause`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build -w packages/cli && npx vitest run packages/cli/test/suspects-cli.test.ts --project unit`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the whole suite**

Run: `npm run verify`
Expected: PASS. Update `packages/cli/test/doc-counts.test.ts`'s expected counts if the README states them.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/source/report.ts packages/core/src/index.ts packages/cli/src packages/cli/test/suspects-cli.test.ts
git commit -m "feat(cli): suspects — rank a source tree's likely performance root causes"
```

---

### Task 5: The scoring harness, outside the shipped packages

**Files:**
- Create: `bench/ohmbench/score.mjs`
- Create: `bench/ohmbench/README.md`
- Create: `bench/ohmbench/matcher.test.mjs`

**Interfaces:**
- Consumes: the benchmark's `groundtruth.json` and a `suspects.json`.
- Produces: a per-case record with `precision`, `recall`, `f1`, and a macro average, following `docs/evaluation.md` exactly.

The matcher, transcribed from the benchmark's published rule:

1. **File**: the trailing path segments agree (at least two, or the whole of a one-segment path); `.ets`/`.ts`/`.js` extensions are ignored; ABC record names (`&entry/src/…&`) reduce to their path.
2. **Function level** (default): the suspect's `symbol` names the location's `symbol` (last component of `Class.method` counts), *or* the suspect's line range overlaps the location's `scope_lines` (functions) or `changed_lines` (fields, constants, module code).
3. A suspect is correct if it matches any `primary` or `related` location.

- [ ] **Step 1: Write the failing matcher test**

```js
it('matches by file and symbol, ignoring the extension', () => {
  const location = { file: 'a/b/C.ets', class: 'C', symbol: 'run', changed_lines: [4, 6] };
  expect(matches({ file: 'x/y/b/C.ts', symbol: 'run', line_start: 1, line_end: 2 }, location)).toBe(true);
});

it('matches by line overlap when the symbol is a field', () => {
  const location = { file: 'a/b/C.ets', class: 'C', symbol: 'K', changed_lines: [28, 32] };
  expect(matches({ file: 'a/b/C.ets', line_start: 30, line_end: 30 }, location)).toBe(true);
});

it('does not match a single trailing segment', () => {
  const location = { file: 'a/b/C.ets', symbol: 'run' };
  expect(matches({ file: 'C.ets', symbol: 'run', line_start: 1, line_end: 1 }, location)).toBe(false);
});

it('scores precision and recall over the top five', () => {
  const record = score({ suspects: [hit, miss, hit, miss, miss, hit] }, groundtruth);
  expect(record.precision).toBeCloseTo(2 / 5);
  expect(record.recall).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test bench/ohmbench/matcher.test.mjs`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the matcher and the scorer**

Plain Node ESM, `node:test`, no dependencies. Read the benchmark directory as an argument; write `bench/ohmbench/results/<tool>/<case>.json` and a `summary.json` with the macro average.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test bench/ohmbench/matcher.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bench/ohmbench
git commit -m "test(bench): OhmBench's matcher, transcribed and tested"
```

---

### Task 6: The measured comparison, and the record

**Files:**
- Create: `bench/ohmbench/RESULTS.md`
- Modify: `CHANGELOG.md`, `README.md`, `site/index.html`

**Interfaces:** none.

- [ ] **Step 1: Run the detector over all 21 unfixed trees**

For each reconstructed tree under the benchmark work directory:
`node packages/cli/dist/index.js suspects --root <tree> --out <results>/ohos-perf/<case> --top 5 --json`

- [ ] **Step 2: Score it**

`node bench/ohmbench/score.mjs --bench <benchmark> --results <results>/ohos-perf`

- [ ] **Step 3: Run HapRay, blind, the same way**

HapRay's `root-cause` requires a device `report-dir` and its `static` action reports only SO/resource inventory. Record what it produces from the same blind inputs (signed HAP + unfixed source), with the exact commands and their exit codes.

- [ ] **Step 4: Record the numbers**

`bench/ohmbench/RESULTS.md` carries: the per-case table (case, our top-1, hit/miss, HapRay's output), the macro average, the commands, and every case the detector missed with the reason. No claim is rounded up: a case with no answer scores 0 and is listed as such.

- [ ] **Step 5: Iterate until the target holds**

The goal is more detected bugs than HapRay and precision ≥ 80% over the top five. Each miss gets a rule or a rule fix, a test that failed first, and a re-score. The ledger of iterations is a section of `RESULTS.md`.

- [ ] **Step 6: Commit**

```bash
git add bench/ohmbench/RESULTS.md CHANGELOG.md README.md site/index.html
git commit -m "docs(bench): the measured OhmBench comparison"
```
