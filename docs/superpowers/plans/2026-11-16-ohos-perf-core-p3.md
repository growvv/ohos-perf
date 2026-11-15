# ohos-perf P3 AI Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a working drill-down loop — named queries over a scene database, a resolver for `Evidence.drillDown`, `ohos-perf query` / `ohos-perf tools`, and a shipped skill adapter — with every analyzer-emitted handle resolving on a recorded real trace.

**Architecture:** A pure registry in core maps stable tool names to deterministic row producers backed by the existing typed queries and analysis helpers. The CLI opens a scene exactly like `analyze`, runs one named query, and emits the same structure the library returns. A static scan of analyzer sources and a fixture end-to-end test keep the emitted handles and the registry from drifting apart.

**Tech Stack:** TypeScript (ESM), Vitest, `node:sqlite`, commander, npm workspaces.

**Spec:** `design/2026-11-14-ohos-perf-core-design.md` — §D4 (evidence graph + `DrillDownHandle`), §8 (CLI and skill), §11 (P3 acceptance: agent 可端到端下钻).

## Global Constraints

- ESM only; **zero runtime dependencies** in core; Node `^22.13.0 || >=23.4.0`.
- Determinism contract: identical inputs produce byte-identical JSON; every output array has an explicit, documented order.
- CLI contract: human-readable by default; `--json` equals the API structure; any failure produces **empty stdout, one stderr line, exit 1**.
- The registry performs no device IO and no writes: every query is read-only over an open `QueryHandle`.
- The skill adapter only translates CLI `--json` and `Evidence.drillDown`; it contains no analysis logic.
- The public value surface of core is pinned by `packages/core/test/types.test.ts`; every new value export must be added to `VALUE_EXPORTS`, and every declared type must be exported.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **Every emitted handle resolves.** Any `tool` literal emitted by an analyzer must be a registered query, and the emitted `args` must pass that query's validation. A dead handle ends an agent's drill-down. Owned by Task 2 (static scan) and Task 5 (fixture resolution).
2. **Limits do not break determinism.** Rows are ordered *before* truncation, `total` counts before the limit, and `limit`/`total` boundaries (`limit == total`, `limit < total`, no limit) report `truncated` correctly. Owned by Task 1 and Task 5.
3. **Malformed input fails before any scene is opened.** Unknown query name, non-object `--args`, wrong argument types, bad `--limit` → one stderr line, empty stdout, exit 1, and no database opened. Owned by Task 3.
4. **A drill-down never dumps a table.** Default limit 100, hard max 1000, and `callstack.matching` keeps its own internal cap; a large scene must not turn one query into an unbounded JSON document. Owned by Task 1.
5. **Query resolves the app exactly like `analyze`.** A collected scene's `scene.json` supplies the app (and pids fallback); an explicit `--app` wins; a scene with no app must not fabricate pids. Owned by Task 3.

---

### Task 1: Named query registry

**Files:**
- Create: `packages/core/src/query/registry.ts`
- Modify: `packages/core/src/query/frames.ts` (add `FrameQuery.get`)
- Modify: `packages/core/src/analyze/frames.ts:87-95` (replace the dangling `callstack.under` handle)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)
- Test: `packages/core/test/query-registry.test.ts`

**Interfaces:**
- Consumes: `QueryHandle` (`src/db/driver.ts`), `AppIdentity` (`src/types.ts`), `CapabilityId` / `CapabilityState` / `CapabilityMatrix` (`src/device/capability.ts`), `FrameQuery` / `CallstackQuery`, `computeBinderAnalysis` (`src/analyze/binder.ts`), `analyzeThreadWakeup` (`src/analyze/threads-wakeup.ts`), `computeThreadAnalysis` / `RedundantThreadPattern` (`src/analyze/threads-score.ts`), `OhosPerfError` (`src/errors.ts`).
- Produces (imported by Tasks 2, 3, 5):

```ts
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

export interface QueryContext {
  readonly db: QueryHandle;
  readonly app: AppIdentity;
  readonly caps: CapabilityMatrix;
}

export interface QueryArgument {
  readonly name: string;
  readonly type: 'number' | 'string' | 'string[]' | 'object';
  readonly required: boolean;
  readonly description: string;
}

export interface NamedQueryDefinition {
  readonly name: string;
  readonly description: string;
  readonly args: readonly QueryArgument[];
  readonly returns: string;
  /** Throws QUERY_BAD_ARGS for missing, unknown, or wrongly typed arguments. */
  parseArgs(args: Record<string, unknown>): void;
  /** Rows in the query's documented order; deterministic for fixed args. */
  run(ctx: QueryContext, args: Record<string, unknown>): unknown[];
}

export interface NamedQueryInfo {
  readonly name: string;
  readonly description: string;
  readonly args: readonly QueryArgument[];
  readonly returns: string;
}

export interface NamedQueryResult {
  readonly query: string;
  readonly rows: unknown[];
  readonly total: number;
  readonly truncated: boolean;
}

export function resolveQueryLimit(limit?: number): number; // throws QUERY_BAD_LIMIT
export function unknownQueryError(name: string): OhosPerfError; // code QUERY_UNKNOWN, lists names
export function queryDefinitions(): NamedQueryDefinition[]; // sorted by name
export function lookupQuery(name: string): NamedQueryDefinition | undefined;
export function runNamedQuery(
  ctx: QueryContext,
  name: string,
  args?: Record<string, unknown>,
  opts?: { limit?: number },
): NamedQueryResult;
```

Registered names (exact, `queryDefinitions()` returns them in this order): `binder.processStats`, `callstack.matching`, `callstack.range`, `caps.get`, `frames.all`, `frames.get`, `threads.pattern`.

- [ ] **Step 1: Write the failing registry test**

Create `packages/core/test/query-registry.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix, type CapabilityState } from '../src/device/capability';
import { OhosPerfError } from '../src/errors';
import {
  DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, lookupQuery, queryDefinitions,
  resolveQueryLimit, runNamedQuery, type QueryContext,
} from '../src/query/registry';

const START = 1_000_000_000;
const MS = 1_000_000;

let dir: string;
let db: QueryHandle;
let ctx: QueryContext;

const DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT);
  CREATE TABLE thread(id INT, tid INT, name TEXT, ipid INT);
  CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
    depth INT, cookie INT, parent_id INT, argsetid INT,
    chainId TEXT, spanId TEXT, parentSpanId TEXT, flag TEXT, trace_level TEXT,
    trace_tag TEXT, custom_category TEXT, custom_args TEXT, child_callid INT);
  CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT);
  CREATE TABLE data_dict(id INT, data TEXT);
  CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT);
`;

function seed(d: DatabaseSync): void {
  d.exec(DDL);
  d.exec(`
    INSERT INTO process VALUES (0, 100, 5000, 'com.demo'), (1, 200, 6000, 'render_service');
    INSERT INTO thread VALUES (10, 5000, 'main', 100), (20, 6001, 'RSThread', 200);
    INSERT INTO data_dict VALUES
      (1, 'transaction id'), (2, 'calling tid'), (3, 'code'),
      (4, 'destination process');
    INSERT INTO args VALUES
      (1, 1, 0, 1, 1), (2, 2, 0, 5000, 1), (3, 3, 1, 100, 1),
      (4, 1, 0, 1, 2), (5, 4, 0, 5000, 2), (6, 3, 1, 102, 2);
    INSERT INTO callstack VALUES
      (1, ${START}, 0, 10, 'binder', 'H:binder transaction', 0, 0, 0, 1,
       '', '', '', '', '', '', '', '', 0),
      (2, ${START + 2 * MS}, 0, 20, 'binder', 'H:binder reply', 0, 0, 0, 2,
       '', '', '', '', '', '', '', '', 0),
      (3, 150, 0, 10, 'graphic', 'H:VsyncCallBackListener', 0, 0, 0, 0,
       '', '', '', '', '', '', '', '', 0),
      (4, 250, 0, 20, 'graphic', 'H:Other', 0, 0, 0, 0,
       '', '', '', '', '', '', '', '', 0);
    INSERT INTO frame_slice VALUES
      (1, 100, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 1, 0, 1),
      (2, 200, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 0, 0, 2),
      (3, 300, 0, 17, 44, 0, 10, '', 0, 1, 'expect', 0, 0, 3);
  `);
}

function state(id: CapabilityState['id'], available: boolean): CapabilityState {
  return {
    id, available, collector: available ? 'hitrace' : undefined,
    fidelity: 'exact',
    ...(available ? {} : { reason: 'not supported' }),
    probe: { command: '', stdout: '', stderr: '', code: 0 },
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (err) { return (err as OhosPerfError).code; }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-registry-'));
  const path = join(dir, 't.db');
  const raw = new DatabaseSync(path);
  seed(raw);
  raw.close();
  db = openDb(path);
  ctx = {
    db,
    app: { packageName: 'com.demo', pids: [5000], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([state('trace.frames', true), state('perf.pmu', false)]),
  };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('queryDefinitions', () => {
  it('lists the seven registered names in sorted order', () => {
    expect(queryDefinitions().map((d) => d.name)).toEqual([
      'binder.processStats', 'callstack.matching', 'callstack.range', 'caps.get',
      'frames.all', 'frames.get', 'threads.pattern',
    ]);
  });

  it('pins the limit constants', () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(100);
    expect(MAX_QUERY_LIMIT).toBe(1000);
  });

  it('lookupQuery returns undefined for an unknown name', () => {
    expect(lookupQuery('nope')).toBeUndefined();
  });
});

describe('runNamedQuery', () => {
  it('returns one frame by id', () => {
    expect(runNamedQuery(ctx, 'frames.get', { id: 2 })).toEqual({
      query: 'frames.get',
      rows: [expect.objectContaining({ id: 2, frameNo: 2 })],
      total: 1,
      truncated: false,
    });
  });

  it('returns no rows for an absent frame id', () => {
    expect(runNamedQuery(ctx, 'frames.get', { id: 99 })).toEqual({
      query: 'frames.get', rows: [], total: 0, truncated: false,
    });
  });

  it('filters frames to the requested window, ordered by ts', () => {
    const r = runNamedQuery(ctx, 'frames.all', { window: { startNs: 150, endNs: 250 } });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([2]);
    expect(r.total).toBe(1);
  });

  it('counts every row before applying the limit', () => {
    const window = { startNs: 0, endNs: 1000 };
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 2 })).toMatchObject({
      total: 3, truncated: true,
    });
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 2 }).rows).toHaveLength(2);
    expect(runNamedQuery(ctx, 'frames.all', { window }, { limit: 3 }).truncated).toBe(false);
  });

  it('returns callstack rows inside a time range', () => {
    const r = runNamedQuery(ctx, 'callstack.range', { startNs: 100, endNs: 200 });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([3]);
  });

  it('matches callstack names through a bound LIKE pattern', () => {
    const r = runNamedQuery(ctx, 'callstack.matching', { pattern: 'H:binder%' });
    expect(r.rows.map((row) => (row as { id: number }).id)).toEqual([1, 2]);
  });

  it('reports capability states in the requested order, synthesizing unknown ids', () => {
    const r = runNamedQuery(ctx, 'caps.get', { ids: ['perf.pmu', 'trace.frames', 'ui.tree'] });
    expect(r.rows.map((row) => (row as CapabilityState).id))
      .toEqual(['perf.pmu', 'trace.frames', 'ui.tree']);
    expect((r.rows[2] as CapabilityState).reason).toBe('capability not probed');
    expect((r.rows[2] as CapabilityState).available).toBe(false);
  });

  it('returns the binder statistics for one process pair', () => {
    const r = runNamedQuery(ctx, 'binder.processStats',
      { callerProc: 'com.demo', calleeProc: 'render_service' });
    expect(r.rows).toEqual([{
      callerProc: 'com.demo', calleeProc: 'render_service', count: 1,
      avgLatency: 2, minLatency: 2, maxLatency: 2, qps: null, avgIntervalMs: null,
    }]);
  });

  it('returns no binder statistics without app pids', () => {
    const r = runNamedQuery({ ...ctx, app: { ...ctx.app, pids: [] } }, 'binder.processStats', {});
    expect(r.rows).toEqual([]);
  });

  it('returns no thread patterns without app pids', () => {
    const r = runNamedQuery({ ...ctx, app: { ...ctx.app, pids: [] } }, 'threads.pattern',
      { threadName: 'Worker' });
    expect(r.rows).toEqual([]);
  });

  it('is byte-identical across two runs', () => {
    const args = { window: { startNs: 0, endNs: 1000 } };
    expect(JSON.stringify(runNamedQuery(ctx, 'frames.all', args, { limit: 2 })))
      .toBe(JSON.stringify(runNamedQuery(ctx, 'frames.all', args, { limit: 2 })));
  });

  it('names the available queries for an unknown name', () => {
    expect(codeOf(() => runNamedQuery(ctx, 'nope', {}))).toBe('QUERY_UNKNOWN');
    try { runNamedQuery(ctx, 'nope', {}); } catch (err) {
      expect((err as OhosPerfError).message).toContain('available:');
      expect((err as OhosPerfError).message).toContain('frames.get');
    }
  });

  it('rejects wrong argument types with QUERY_BAD_ARGS', () => {
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', {}))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', { id: '2' }))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.all', { window: { startNs: 1 } })))
      .toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'caps.get', { ids: 'x' }))).toBe('QUERY_BAD_ARGS');
    expect(codeOf(() => runNamedQuery(ctx, 'frames.get', { id: 1, extra: true })))
      .toBe('QUERY_BAD_ARGS');
  });

  it('rejects an out-of-range limit with QUERY_BAD_LIMIT', () => {
    for (const limit of [0, -1, 1.5, MAX_QUERY_LIMIT + 1]) {
      expect(() => resolveQueryLimit(limit)).toThrowError(/between 1 and 1000/);
      expect(codeOf(() => resolveQueryLimit(limit))).toBe('QUERY_BAD_LIMIT');
    }
    expect(resolveQueryLimit(undefined)).toBe(DEFAULT_QUERY_LIMIT);
    expect(resolveQueryLimit(MAX_QUERY_LIMIT)).toBe(MAX_QUERY_LIMIT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/query-registry.test.ts`
Expected: FAIL — cannot resolve `../src/query/registry`.

- [ ] **Step 3: Implement the registry, `FrameQuery.get`, the handle rename, and the exports**

Create `packages/core/src/query/registry.ts` with the interfaces above. Implementation rules:

- `queryDefinitions()` returns a module-level array already in the sorted order listed above; `lookupQuery` builds a `Map` once and returns `undefined` for unknown names.
- Validation helpers (module-private): `badArgs(query, detail)` returns `new OhosPerfError(\`${query}: ${detail}\`, { code: 'QUERY_BAD_ARGS' })`; `rejectUnknownArgs(query, args, allowed)` rejects any key not in `allowed`; `numberArg` requires `typeof value === 'number' && Number.isFinite(value)`; `stringArg` requires a non-empty string; `stringArrayArg` requires a non-empty array of non-empty strings; `windowArg(args, key)` requires an object with only `startNs`/`endNs` finite numbers and `endNs >= startNs`.
- `resolveQueryLimit` returns `DEFAULT_QUERY_LIMIT` for `undefined`; otherwise requires `Number.isInteger` and `1 <= limit <= MAX_QUERY_LIMIT`, else throws `OhosPerfError` code `QUERY_BAD_LIMIT` with message `` limit must be an integer between 1 and 1000, got ${String(limit)} ``.
- `unknownQueryError(name)` message: `` unknown query "${name}"; available: ${names.join(', ')} ``, code `QUERY_UNKNOWN`.
- `runNamedQuery(ctx, name, args = {}, opts = {})`: `lookupQuery` (throw `unknownQueryError`), `resolveQueryLimit(opts.limit)`, `def.parseArgs(args)`, `rows = def.run(ctx, args)`, `total = rows.length`, `truncated = total > limit`; slide with `rows.slice(0, limit)` only when truncated. Never reorder.
- `parseArgs` for each definition validates exactly the keys below and throws `QUERY_BAD_ARGS` otherwise.

Definition bodies (all return arrays; all ordering comes from the underlying query/helper):

| Name | `args` metadata | `run` |
|---|---|---|
| `binder.processStats` | `callerProc` string optional, `calleeProc` string optional | `if (ctx.app.pids.length === 0) return [];` then `computeBinderAnalysis(ctx.db, { appPids: ctx.app.pids }).processStats` filtered by any provided pair fields |
| `callstack.matching` | `pattern` string required; `startNs`, `endNs` numbers optional **as a pair** | `new CallstackQuery(ctx.db).matching(pattern, { ...(range ? { range } : {}), limit: MAX_QUERY_LIMIT })` |
| `callstack.range` | `startNs`, `endNs` numbers required | `new CallstackQuery(ctx.db).all({ startNs, endNs })` |
| `caps.get` | `ids` string[] required | `ids.map((id) => ctx.caps.get(id as CapabilityId) ?? { id: id as CapabilityId, available: false, fidelity: 'exact', reason: 'capability not probed', probe: { command: '', stdout: '', stderr: '', code: 0 } })` |
| `frames.all` | `window` object required | `new FrameQuery(ctx.db).all(windowArg(args, 'window'))` |
| `frames.get` | `id` number required | `const frame = new FrameQuery(ctx.db).get(numberArg(args, 'id')); return frame === undefined ? [] : [frame];` |
| `threads.pattern` | `threadName` string required | `analyzeThreadWakeup(ctx.db, { appPids: ctx.app.pids })` → `computeThreadAnalysis(results).redundantThreadsSummary.redundant_threads`, filtered to patterns where `p.thread_name === name`, `p.thread_name_variants.includes(name)`, or `${p.thread_name}_*` equals `name` |

Set each `description` to one sentence and each `returns` to the row shape (`BinderProcessStat[]`, `CallstackEvent[]`, `CapabilityState[]`, `Frame[]`, `Frame`, `RedundantThreadPattern[]`).

Add to `packages/core/src/query/frames.ts` (after `all()`):

```ts
/** The frame with `id`, or `undefined` when it is absent or has no flag row. */
get(id: number): Frame | undefined {
  const [row] = this.db.query<FrameSliceRow>(`${SELECT_FRAMES} AND id = ? LIMIT 1`, [id]);
  return row ? toFrame(row) : undefined;
}
```

Replace the `callstack.under` handle in `packages/core/src/analyze/frames.ts`:

```ts
{
  label: 'Callstack for frame',
  tool: 'callstack.range',
  args: { startNs, endNs },
  returns: 'CallstackEvent[]',
},
```

(`startNs` / `endNs` are already in scope there.) No other analyzer source changes.

In `packages/core/src/index.ts`, add after the Query exports:

```ts
// Drill-down query registry
export {
  DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, lookupQuery, queryDefinitions,
  resolveQueryLimit, runNamedQuery, unknownQueryError,
} from './query/registry';
export type {
  NamedQueryDefinition, NamedQueryInfo, NamedQueryResult, QueryArgument, QueryContext,
} from './query/registry';
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `npx vitest run packages/core/test/query-registry.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Update the pinned value surface and verify the build**

Add to `VALUE_EXPORTS` in `packages/core/test/types.test.ts`, in the existing alphabetical position:
`DEFAULT_QUERY_LIMIT`, `MAX_QUERY_LIMIT`, `lookupQuery`, `queryDefinitions`, `resolveQueryLimit`, `runNamedQuery`, `unknownQueryError`.

Run: `npm run build -w @ohos-perf/core && npx vitest run packages/core/test/types.test.ts`
Expected: build succeeds; types tests PASS.

- [ ] **Step 6: Typecheck the core workspace**

Run: `npm run typecheck -w @ohos-perf/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/query/registry.ts packages/core/src/query/frames.ts \
  packages/core/src/analyze/frames.ts packages/core/src/index.ts \
  packages/core/test/query-registry.test.ts packages/core/test/types.test.ts
git commit -m "feat(core): add the named drill-down query registry"
```

---

### Task 2: Drill-down resolver and emitted-handle coverage guard

**Files:**
- Modify: `packages/core/src/query/registry.ts` (add `runDrillDown`)
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/types.test.ts` (`runDrillDown` in `VALUE_EXPORTS`)
- Test: `packages/core/test/drilldown.test.ts`

**Interfaces:**
- Consumes: `runNamedQuery`, `queryDefinitions`, `NamedQueryResult`, `QueryContext` from Task 1; `DrillDownHandle` from `src/report/evidence.ts`.
- Produces:

```ts
export function runDrillDown(
  ctx: QueryContext,
  handle: DrillDownHandle,
  opts?: { limit?: number },
): NamedQueryResult;
```

- [ ] **Step 1: Write the failing resolver + coverage tests**

Create `packages/core/test/drilldown.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { OhosPerfError } from '../src/errors';
import { queryDefinitions, runDrillDown, type QueryContext } from '../src/query/registry';

const here = dirname(fileURLToPath(import.meta.url));

let dir: string;
let db: QueryHandle;
let ctx: QueryContext;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-drilldown-'));
  const path = join(dir, 't.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  raw.exec(`INSERT INTO frame_slice VALUES
    (7, 100, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 1, 0, 7)`);
  raw.close();
  db = openDb(path);
  ctx = {
    db,
    app: { packageName: 'com.demo', pids: [], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
  };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runDrillDown', () => {
  it('resolves a frames.get handle into its frame row', () => {
    const r = runDrillDown(ctx, {
      label: 'Frame detail', tool: 'frames.get', args: { id: 7 }, returns: 'Frame',
    });
    expect(r.query).toBe('frames.get');
    expect(r.rows).toEqual([expect.objectContaining({ id: 7 })]);
  });

  it('forwards the limit and rejects an unknown tool by name', () => {
    expect(runDrillDown(ctx, {
      label: 'x', tool: 'frames.get', args: { id: 7 }, returns: 'Frame',
    }, { limit: 1 }).rows).toHaveLength(1);

    try {
      runDrillDown(ctx, {
        label: 'x', tool: 'frames.nope', args: {}, returns: 'Frame[]',
      });
      expect.unreachable();
    } catch (err) {
      expect((err as OhosPerfError).code).toBe('QUERY_UNKNOWN');
      expect((err as OhosPerfError).message).toContain('available:');
    }
  });
});

describe('analyzer drill-down coverage', () => {
  it('registers every tool literal emitted by an analyzer', () => {
    const analyzeDir = join(here, '../src/analyze');
    const tools = new Set<string>();
    for (const file of readdirSync(analyzeDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(analyzeDir, file), 'utf8');
      for (const match of text.matchAll(/tool:\s*'([^']+)'/g)) tools.add(match[1]);
    }
    expect(tools.size).toBeGreaterThan(0);
    const registered = queryDefinitions().map((d) => d.name);
    expect([...tools].filter((tool) => !registered.includes(tool))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/drilldown.test.ts`
Expected: FAIL — `runDrillDown` is not exported by `../src/query/registry`.

- [ ] **Step 3: Implement `runDrillDown` and export it**

In `packages/core/src/query/registry.ts`:

```ts
/** Resolve one Evidence.drillDown handle into rows, with the same limit rules. */
export function runDrillDown(
  ctx: QueryContext,
  handle: DrillDownHandle,
  opts: { limit?: number } = {},
): NamedQueryResult {
  return runNamedQuery(ctx, handle.tool, handle.args, opts);
}
```

Import `DrillDownHandle` as a type. Add `runDrillDown` to the value exports in `packages/core/src/index.ts` and to `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/drilldown.test.ts`
Expected: PASS.

- [ ] **Step 5: Rebuild and verify the pinned surface**

Run: `npm run build -w @ohos-perf/core && npx vitest run packages/core/test/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/query/registry.ts packages/core/src/index.ts \
  packages/core/test/drilldown.test.ts packages/core/test/types.test.ts
git commit -m "feat(core): resolve evidence drill-down handles"
```

---

### Task 3: CLI `query` and `tools`

**Files:**
- Create: `packages/cli/src/query.ts`
- Modify: `packages/cli/src/commands.ts` (`CliDeps.query`, `CliDeps.tools`, `QueryRequest`, `runQuery`, `runTools`)
- Modify: `packages/cli/src/deps.ts` (extract `openOfflineScene`, add `query`/`tools`)
- Modify: `packages/cli/src/program.ts` (two commands)
- Modify: `packages/cli/test/commands.test.ts`, `packages/cli/test/program.test.ts` (deps factories)
- Test: `packages/cli/test/query-cli.test.ts`; additions to `packages/cli/test/deps.test.ts`, `packages/cli/test/program.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_QUERY_LIMIT`, `MAX_QUERY_LIMIT`, `NamedQueryInfo`, `NamedQueryResult`, `lookupQuery`, `queryDefinitions`, `resolveQueryLimit`, `runNamedQuery`, `unknownQueryError` (Tasks 1–2); `createSceneLayout`, `readSceneMetadata`, `readProcfsSamples`, `resolveAppIdentity`, `offlineCapabilities` (existing `deps.ts`).
- Produces:

```ts
// commands.ts
export interface QueryRequest {
  sceneDir: string;
  name: string;
  app?: string;
  args?: Record<string, unknown>;
  limit?: number;
}
export interface CliDeps {
  // ... existing fields ...
  query(req: QueryRequest): Promise<NamedQueryResult>;
  tools(): NamedQueryInfo[];
}
export function runQuery(deps: CliDeps, req: QueryRequest, opts: { json?: boolean }): Promise<CliResult>;
export function runTools(deps: CliDeps, opts: { json?: boolean }): CliResult;

// query.ts
export function parseQueryArgs(raw: string): Record<string, unknown>;
export function parseLimit(raw: string): number;
```

- [ ] **Step 1: Write the failing parser/renderer tests**

Create `packages/cli/test/query-cli.test.ts` with a `deps()` factory (copy the shape from `commands.test.ts`, adding `query` and `tools` defaults) and these assertions:

```ts
describe('parseQueryArgs', () => {
  it('parses a JSON object', () => {
    expect(parseQueryArgs('{"id":2}')).toEqual({ id: 2 });
  });

  it('rejects non-objects and invalid JSON', () => {
    for (const raw of ['[]', 'null', '1', '"x"', '{bad']) {
      expect(() => parseQueryArgs(raw)).toThrowError(/invalid --args/);
    }
  });
});

describe('parseLimit', () => {
  it('parses a valid limit', () => {
    expect(parseLimit('20')).toBe(20);
  });

  it('rejects 0, negatives, fractions and values above the max', () => {
    for (const raw of ['0', '-1', '1.5', '1001', 'abc']) {
      expect(() => parseLimit(raw)).toThrowError(/between 1 and 1000/);
    }
  });
});

describe('runQuery', () => {
  it('prints the API structure with --json', async () => {
    const result = { query: 'frames.all', rows: [{ id: 1 }], total: 3, truncated: true };
    const r = await runQuery(deps({ query: async () => result }),
      { sceneDir: 'scene1', name: 'frames.all' }, { json: true });
    expect(r).toEqual({ stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 });
  });

  it('prints a summary line and one compact JSON row per line', async () => {
    const r = await runQuery(
      deps({ query: async () => ({ query: 'frames.all', rows: [{ id: 1 }, { id: 2 }], total: 5, truncated: true }) }),
      { sceneDir: 'scene1', name: 'frames.all' }, {});
    expect(r.stdout).toBe('frames.all  2/5 rows (truncated)\n{"id":1}\n{"id":2}\n');
  });

  it('maps any failure to exit 1 with empty stdout', async () => {
    const r = await runQuery(
      deps({ query: async () => { throw new Error('boom'); } }),
      { sceneDir: 'scene1', name: 'frames.all' }, { json: true });
    expect(r).toEqual({ stdout: '', stderr: 'boom\n', exitCode: 1 });
  });
});

describe('runTools', () => {
  const info: NamedQueryInfo[] = [{
    name: 'frames.get',
    description: 'One frame by id.',
    args: [{ name: 'id', type: 'number', required: true, description: 'frame row id' }],
    returns: 'Frame',
  }];

  it('prints the definitions as JSON', () => {
    const r = runTools(deps({ tools: () => info }), { json: true });
    expect(JSON.parse(r.stdout)).toEqual(info);
  });

  it('prints one line per tool with required/optional argument names', () => {
    const r = runTools(deps({ tools: () => info }), {});
    expect(r.stdout).toBe('frames.get(id)  -> Frame\n  One frame by id.\n');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/query-cli.test.ts`
Expected: FAIL — cannot resolve `../src/query` / `runQuery` is not exported.

- [ ] **Step 3: Implement `query.ts`, the command layer, and the deps wiring**

`packages/cli/src/query.ts`:

```ts
import { OhosPerfError, resolveQueryLimit } from '@ohos-perf/core';

export function parseQueryArgs(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OhosPerfError('invalid --args: not valid JSON', { code: 'QUERY_BAD_ARGS' });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OhosPerfError('invalid --args: expected a JSON object', { code: 'QUERY_BAD_ARGS' });
  }
  return value as Record<string, unknown>;
}

export function parseLimit(raw: string): number {
  return resolveQueryLimit(Number(raw));
}
```

In `commands.ts`, import the core types and add the two deps plus renderers:

```ts
export function runQuery(deps: CliDeps, req: QueryRequest, opts: { json?: boolean }): Promise<CliResult> {
  // try { const result = await deps.query(req);
  //   if (opts.json) return { stdout: json(result), stderr: '', exitCode: 0 };
  //   const summary = `${result.query}  ${result.rows.length}/${result.total} rows`
  //     + `${result.truncated ? ' (truncated)' : ''}\n`;
  //   return { stdout: summary + result.rows.map((row) => JSON.stringify(row) + '\n').join(''),
  //     stderr: '', exitCode: 0 };
  // } catch (err) { return { stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 }; }
}

export function runTools(deps: CliDeps, opts: { json?: boolean }): CliResult {
  // tools = deps.tools(); json → json(tools);
  // human → each `${name}(${args.map(a => a.required ? a.name : `${a.name}?`).join(', ')})  -> ${returns}\n  ${description}\n`
  // try/catch mirrors runQuery.
}
```

Implement both bodies fully (the comments above are the formatting contract, not pseudocode to ship).

`packages/cli/src/deps.ts`:

1. Add imports: `lookupQuery`, `queryDefinitions`, `resolveQueryLimit`, `runNamedQuery`, `unknownQueryError`, and types `AppIdentity`, `NamedQueryInfo`, `SceneMetadata`.
2. Extract the scene-opening code currently inline in `analyze` into an internal helper inside `realDeps`:

```ts
interface OpenedScene {
  scene: Scene;
  layout: SceneLayout;
  metadata?: SceneMetadata;
  samples: ReturnType<typeof readProcfsSamples>;
  app: AppIdentity;
  caps: CapabilityMatrix;
}

const openOfflineScene = async (sceneDir: string, app?: string): Promise<OpenedScene> => {
  const layout = createSceneLayout(resolve(sceneDir));
  const scene = await ingest(new Streamer(), layout);
  try {
    // Move the existing body verbatim: metadata gate, procfs samples,
    // app identity (explicit --app wins; metadata name then recorded-pids
    // fallback), and offlineCapabilities(db, samples).
    return { scene, layout, app: appIdentity, caps, samples, ...(metadata ? { metadata } : {}) };
  } catch (err) {
    scene.close();
    throw err;
  }
};
```

3. `analyze` becomes: open the scene, `try { build the AnalyzeContext from the opened fields; return runAnalyzers(...) } finally { opened.scene.close(); }`. Behavior must not change — the existing `deps.test.ts` analysis tests are the regression net.
4. Add:

```ts
async query(req) {
  const def = lookupQuery(req.name);
  if (def === undefined) throw unknownQueryError(req.name);
  const args = req.args ?? {};
  def.parseArgs(args);            // validate before any file is opened
  const limit = resolveQueryLimit(req.limit);
  const opened = await openOfflineScene(req.sceneDir, req.app);
  try {
    return runNamedQuery(
      { db: opened.scene.traceDb, app: opened.app, caps: opened.caps },
      req.name, args, { limit },
    );
  } finally {
    opened.scene.close();
  }
},

tools() {
  return queryDefinitions().map((d) => ({
    name: d.name, description: d.description, args: d.args, returns: d.returns,
  }));
},
```

5. Add `query` and `tools` to the `CliDeps` interface and to the fake factories in `packages/cli/test/commands.test.ts` and `packages/cli/test/program.test.ts` (`query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false })`, `tools: () => []`).

`packages/cli/src/program.ts` adds:

```ts
program
  .command('query')
  .description('run one named drill-down query against a captured scene')
  .argument('<scene-dir>', 'directory containing trace.db / trace.htrace')
  .argument('<name>', 'named query; list them with `ohos-perf tools`')
  .option('--app <packageName>', 'app package name, overriding scene.json')
  .option('--args <json>', 'query arguments as a JSON object')
  .option('--limit <n>', 'maximum rows to return (default 100, max 1000)')
  .option('--json', 'print the result as JSON')
  // action: parse --args/--limit in try/catch; on error emit
  // { stdout: '', stderr: `${safeMessage(err)}\n`, exitCode: 1 } and return;
  // otherwise io.emit(await runQuery(deps, request, { json: opts.json })).

program
  .command('tools')
  .description('list the named drill-down queries an agent can call')
  .option('--json', 'print the query definitions as JSON')
  // action: io.emit(runTools(deps, opts))
```

- [ ] **Step 4: Add the deps-level tests for app resolution and fail-before-open**

Add to `packages/cli/test/deps.test.ts` (reusing `createFullTraceDb` and its `processRows` parameter):

```ts
it('runs a named query and closes the scene it opened', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-'));
  try {
    createFullTraceDb(join(parent, 'trace.db'));
    const r = await realDeps('0.0.0').query({
      sceneDir: parent, name: 'frames.all',
      args: { window: { startNs: 0, endNs: 2000 } },
    });
    expect(r.rows).toHaveLength(1);
    expect(r.total).toBe(1);
    rmSync(parent, { recursive: true }); // an unclosed handle blocks this on Windows
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it('rejects an unknown query name before opening the scene', async () => {
  await expect(realDeps('0.0.0').query({
    sceneDir: join(tmpdir(), 'ohosperf-does-not-exist'),
    name: 'nope',
  })).rejects.toThrow(/unknown query "nope"; available: .*frames\.get/);
});

it('rejects malformed arguments before opening the scene', async () => {
  await expect(realDeps('0.0.0').query({
    sceneDir: join(tmpdir(), 'ohosperf-does-not-exist'),
    name: 'frames.get', args: {},
  })).rejects.toThrow(/frames\.get: missing number argument "id"/);
});

it('resolves the app from scene.json, lets --app win, and fabricates no pids', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ohosperf-query-app-'));
  try {
    // createFullTraceDb already creates process/thread/callstack/args/data_dict
    // and one frame row; seed one completed binder transaction through a raw
    // handle (the helper only exposes `processRows`).
    createFullTraceDb(
      join(parent, 'trace.db'),
      '(0, 17, 4999, \'com.demo\', 0, 0, 1, 0, 0), ' +
      '(1, 200, 6000, \'render_service\', 0, 0, 1, 0, 0)',
    );
    const raw = new DatabaseSync(join(parent, 'trace.db'));
    raw.exec(`
      INSERT INTO thread VALUES
        (10, 5000, 4999, 'main', 0, 0, 17, 1, 0),
        (20, 6001, 6000, 'RSThread', 0, 0, 200, 0, 0);
      INSERT INTO data_dict VALUES
        (1, 'transaction id'), (2, 'calling tid'), (3, 'code'),
        (4, 'destination process');
      INSERT INTO args VALUES
        (1, 1, 0, 1, 1), (2, 2, 0, 5000, 1), (3, 3, 1, 100, 1),
        (4, 1, 0, 1, 2), (5, 4, 0, 5000, 2), (6, 3, 1, 102, 2);
      INSERT INTO callstack VALUES
        (1, 1000000000, 0, 10, 'binder', 'H:binder transaction', 0, 0, 0, 1,
         '', '', '', '', '', '', '', '', 0),
        (2, 1002000000, 0, 20, 'binder', 'H:binder reply', 0, 0, 0, 2,
         '', '', '', '', '', '', '', '', 0);
    `);
    raw.close();

    const meta = {
      version: 1,
      app: { packageName: 'com.demo', processNames: ['com.demo'] },
      pids: [], deviceId: 't1', startedAtNs: 1_000_000_000,
    };
    writeFileSync(join(parent, 'scene.json'), JSON.stringify(meta));
    const fromMeta = await realDeps('0.0.0').query({ sceneDir: parent, name: 'binder.processStats' });
    expect(fromMeta.rows).toEqual([
      expect.objectContaining({ callerProc: 'com.demo', calleeProc: 'render_service', count: 1 }),
    ]);

    rmSync(join(parent, 'scene.json'));
    const fromFlag = await realDeps('0.0.0').query({
      sceneDir: parent, name: 'binder.processStats', app: 'com.demo',
    });
    expect(fromFlag.rows).toHaveLength(1);

    const withoutApp = await realDeps('0.0.0').query({ sceneDir: parent, name: 'binder.processStats' });
    expect(withoutApp).toMatchObject({ rows: [], total: 0 });
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
```

`DatabaseSync` is already imported in `deps.test.ts`; `writeFileSync` and
`rmSync` are already imported.

Also add:

```ts
it('exposes the same sorted tool list as the registry', () => {
  expect(realDeps('0.0.0').tools().map((t) => t.name)).toEqual([
    'binder.processStats', 'callstack.matching', 'callstack.range', 'caps.get',
    'frames.all', 'frames.get', 'threads.pattern',
  ]);
});
```

- [ ] **Step 5: Add the program wiring tests**

In `packages/cli/test/program.test.ts`:

```ts
it('query maps flags to one QueryRequest', async () => {
  const seen: unknown[] = [];
  const { emitted } = await parse(
    ['query', 'scene1', 'frames.get', '--app', 'com.demo',
      '--args', '{"id":2}', '--limit', '5', '--json'],
    { query: async (req) => { seen.push(req); return { query: 'frames.get', rows: [], total: 0, truncated: false }; } },
  );
  expect(seen).toEqual([{
    sceneDir: 'scene1', name: 'frames.get', app: 'com.demo', args: { id: 2 }, limit: 5,
  }]);
  expect(emitted[0].exitCode).toBe(0);
});

it('rejects a malformed --args before calling the query layer', async () => {
  let called = false;
  const { emitted } = await parse(['query', 'scene1', 'frames.get', '--args', 'nope'], {
    query: async () => { called = true; throw new Error('should not run'); },
  });
  expect(called).toBe(false);
  expect(emitted).toEqual([{ stdout: '', stderr: 'invalid --args: not valid JSON\n', exitCode: 1 }]);
});

it('rejects an out-of-range --limit with one stderr line', async () => {
  const { emitted } = await parse(['query', 'scene1', 'frames.get', '--limit', '0']);
  expect(emitted).toEqual([{
    stdout: '', stderr: 'limit must be an integer between 1 and 1000, got 0\n', exitCode: 1,
  }]);
});

it('tools forwards --json to the definitions', async () => {
  const info = [{ name: 'frames.get', description: 'd', args: [], returns: 'Frame' }];
  const { emitted } = await parse(['tools', '--json'], { tools: () => info });
  expect(JSON.parse(emitted[0].stdout)).toEqual(info);
});
```

Also extend the `--help` test to assert `query` and `tools` appear.

- [ ] **Step 6: Run the CLI tests**

Run: `npx vitest run packages/cli/test/query-cli.test.ts packages/cli/test/deps.test.ts packages/cli/test/program.test.ts packages/cli/test/commands.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck the CLI workspace**

Run: `npm run typecheck -w @ohos-perf/cli`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/query.ts packages/cli/src/commands.ts packages/cli/src/deps.ts \
  packages/cli/src/program.ts packages/cli/test/query-cli.test.ts \
  packages/cli/test/deps.test.ts packages/cli/test/program.test.ts packages/cli/test/commands.test.ts
git commit -m "feat(cli): expose drill-down queries and tool definitions"
```

---

### Task 4: Agent skill adapter and docs

**Files:**
- Create: `skill/ohos-perf/SKILL.md`
- Modify: `README.md` (Status, Quickstart, Architecture)
- Modify: `site/index.html` (agent card + L7 line, both languages)
- Test: `packages/cli/test/skill.test.ts`

**Interfaces:**
- Consumes: the CLI surface from Task 3 (`query`, `tools`). No API imports.
- Produces: a shipped skill document whose commands cannot drift from the CLI.

- [ ] **Step 1: Write the failing drift test**

Create `packages/cli/test/skill.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const skill = readFileSync(join(root, 'skill/ohos-perf/SKILL.md'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const COMMANDS = new Set(['doctor', 'caps', 'collect', 'analyze', 'query', 'tools']);

describe('agent skill adapter', () => {
  it('has frontmatter with a name and a description', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    const frontmatter = skill.slice(4, skill.indexOf('\n---', 4));
    expect(frontmatter).toMatch(/^name: ohos-perf$/m);
    expect(frontmatter).toMatch(/^description: .{40,}$/m);
  });

  it('only invokes commands the CLI actually has', () => {
    const used = [...skill.matchAll(/ohos-perf ([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(3);
    for (const command of used) expect(COMMANDS).toContain(command);
  });

  it('describes the evidence-to-query workflow it relies on', () => {
    for (const needle of ['drillDown', 'ohos-perf tools --json', 'ohos-perf query',
      '--limit', '--json']) {
      expect(skill).toContain(needle);
    }
  });

  it('is linked from the README', () => {
    expect(readme).toContain('ohos-perf query');
    expect(readme).toContain('skill/ohos-perf');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/skill.test.ts`
Expected: FAIL — `skill/ohos-perf/SKILL.md` does not exist.

- [ ] **Step 3: Write the skill document**

Create `skill/ohos-perf/SKILL.md`:

```markdown
---
name: ohos-perf
description: Measure HarmonyOS app performance on real devices and drill down into captured traces — probe capabilities, collect a scene, read evidence, and follow drillDown handles into frames, callstacks, binder transactions and thread patterns with the ohos-perf CLI.
---

# ohos-perf

Use this skill when a HarmonyOS app must be measured, or when a captured scene
(`trace.db` / `trace.htrace` plus `scene.json`) must be explained. The CLI is
the interface; every command speaks stable JSON with `--json`.

## Workflow

1. Check the toolchain and the attached device: `ohos-perf doctor`
2. Read the capability matrix before asking for data that may not exist:
   `ohos-perf caps --json`. An unavailable capability is absent by design —
   never invent its metric.
3. Capture a scene (10 seconds is a useful default):
   `ohos-perf collect --app <pkg> --duration 10s --out <dir> --json`
4. Analyze it offline: `ohos-perf analyze <dir> --json`
5. Read `evidence[].drillDown`. Each handle names a `tool`, its `args`, and a
   one-line `returns` shape with an optional `estRows`.

## Drilling down

List the available queries and their argument schemas once per session:

```bash
ohos-perf tools --json
```

Then resolve a handle by passing its `tool` and `args` through verbatim:

```bash
ohos-perf query <dir> frames.get --args '{"id":42}' --limit 20 --json
```

Rules:

- Use the handle's `tool` and `args` exactly as emitted; do not rename or
  reshape them.
- Start with a small `--limit`. The result contains `rows`, `total` (matched
  rows before the limit) and `truncated`; follow up only when more rows are
  genuinely needed. The default limit is 100 and the maximum is 1000.
- `/` in a query result is not a path: rows are data from the trace database.
- If a query fails, the CLI writes one line to stderr and exits 1 with empty
  stdout; the message names the available queries or the invalid argument.

## Output contract

`--json` output is the same structure the library returns. Evidence is ordered
by `(kind, window.startNs, id)`, so repeated runs over the same scene and the
same query arguments are byte-identical.
```

- [ ] **Step 4: Update the README**

- Status: change the opening to **"**P1, P2 and P3 are complete**"** and add to
  the implemented list:
  `- named drill-down queries (`ohos-perf tools`, `ohos-perf query`) and the
  agent skill adapter in `skill/ohos-perf/SKILL.md``
- Quickstart: after the `analyze` block, add:

  ```bash
  # Follow an evidence drillDown handle (list the tools first)
  node packages/cli/dist/index.js tools --json
  node packages/cli/dist/index.js query ./scene frames.get \
    --args '{"id":42}' --json
  ```

- Architecture L7 line:
  `L7  API / CLI / Skill      programmatic API · ohos-perf CLI · agent skill (skill/ohos-perf/)`

- [ ] **Step 5: Update the site**

In `site/index.html`, update both languages of the "Built to be called by
agents" paragraph (line ~168) so it names the shipped loop — `ohos-perf query`
turns every `drillDown` handle into the next call, and `skill/ohos-perf/SKILL.md`
packages that workflow. Update the L7 description (line ~297) both languages to
name the shipped skill instead of "the seam for". Keep the `data-en`/`data-zh`
pair balanced.

- [ ] **Step 6: Run the skill test and the CLI suite**

Run: `npx vitest run packages/cli/test/skill.test.ts`
Expected: PASS.

Run: `npx vitest run packages/cli`
Expected: all CLI tests PASS.

- [ ] **Step 7: Commit**

```bash
git add skill/ohos-perf/SKILL.md README.md site/index.html packages/cli/test/skill.test.ts
git commit -m "feat: ship the ohos-perf agent skill"
```

---

### Task 5: End-to-end drill-down on a recorded trace, then final counts

**Files:**
- Create: `packages/core/test/drilldown-e2e.test.ts`
- Modify: `README.md`, `site/index.html` (test counts)

**Interfaces:**
- Consumes: `runAnalyzers` / `defaultAnalyzers` (`src/analyze/engine.ts`), the typed queries, `CapabilityMatrix`, `runDrillDown` (Task 2), and the fixture resolution pattern from `packages/core/test/e2e-offline.test.ts:26-46`.
- Produces: the P3 acceptance proof — every handle from a real analysis resolves to rows.

- [ ] **Step 1: Write the failing end-to-end test**

Create `packages/core/test/drilldown-e2e.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery, ThreadQuery } from '../src/query/process';
import { SchedQuery, InstantQuery } from '../src/query/sched';
import { ThreadStateQuery } from '../src/query/thread-state';
import { CallstackQuery } from '../src/query/callstack';
import { PerfQuery } from '../src/query/perf';
import { BinderQuery } from '../src/query/binder';
import { StartupQuery } from '../src/query/startup';
import { CapabilityMatrix, type CapabilityId } from '../src/device/capability';
import { defaultAnalyzers, runAnalyzers } from '../src/analyze/engine';
import type { AnalyzeContext } from '../src/analyze/types';
import { runDrillDown, type QueryContext } from '../src/query/registry';

const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.OHOS_PERF_E2E_DB ?? join(here, '../../../spike/out/emu_big.db');
const HAVE_DB = existsSync(DB);

function available(id: CapabilityId) {
  return {
    id, available: true as const, collector: 'hitrace', fidelity: 'exact' as const,
    probe: { command: '', stdout: '', stderr: '', code: 0 },
  };
}

function ctxFor(db: ReturnType<typeof openDb>): AnalyzeContext {
  const processes = new ProcessQuery(db);
  const pid = processes.byName('pbench.baseline')?.pid;
  return {
    db,
    frames: new FrameQuery(db),
    processes,
    threads: new ThreadQuery(db),
    sched: new SchedQuery(db),
    instant: new InstantQuery(db),
    threadStates: new ThreadStateQuery(db),
    callstacks: new CallstackQuery(db),
    perf: new PerfQuery(db),
    binder: new BinderQuery(db),
    startup: new StartupQuery(db),
    app: {
      packageName: 'pbench.baseline',
      pids: pid === undefined ? [] : [pid],
      processNames: ['pbench.baseline'],
    },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    // mem.procfs is deliberately absent: memory degrades, which guarantees a
    // caps.get handle in the evidence set.
    caps: new CapabilityMatrix([
      available('trace.frames'), available('trace.binder'),
      available('trace.sched'), available('trace.thread_state'),
    ]),
    deviceId: 'emulator-6.1.0.126',
  };
}

describe.skipIf(!HAVE_DB)('drill-down on a recorded trace', () => {
  it('resolves every handle the analyzers emit', async () => {
    const db = openDb(DB);
    try {
      const ctx = ctxFor(db);
      const result = await runAnalyzers(defaultAnalyzers(), ctx);
      const handles = result.evidence.flatMap((e) => e.drillDown);
      expect(handles.length).toBeGreaterThan(0);

      const tools = new Set(handles.map((h) => h.tool));
      expect(tools.has('frames.get')).toBe(true); // 60 jank evidences
      expect(tools.has('caps.get')).toBe(true);   // degraded memory analyzer

      const queryCtx: QueryContext = { db, app: ctx.app, caps: ctx.caps };
      // Expensive analysis-backed queries (binder/threads) are resolved once
      // per distinct handle; every distinct handle is still proven.
      const seen = new Set<string>();
      for (const handle of handles) {
        const key = `${handle.tool}:${JSON.stringify(handle.args)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const r = runDrillDown(queryCtx, handle, { limit: 5 });
        expect(r.rows.length, `${handle.tool} returned too many rows`).toBeLessThanOrEqual(5);
        expect(r.total).toBeGreaterThanOrEqual(r.rows.length);
        expect(r.truncated).toBe(r.total > r.rows.length);
        // Determinism: the same handle resolves identically twice.
        expect(JSON.stringify(runDrillDown(queryCtx, handle, { limit: 5 })))
          .toBe(JSON.stringify(r));
      }

      for (const handle of handles.filter((h) => h.tool === 'frames.get')) {
        const r = runDrillDown(queryCtx, handle);
        expect(r.rows).toHaveLength(1);
        expect((r.rows[0] as { id: number }).id).toBe(handle.args.id);
      }
    } finally {
      db.close();
    }
  });

  it('produces the same evidence and handles on two runs', async () => {
    const db = openDb(DB);
    try {
      const a = await runAnalyzers(defaultAnalyzers(), ctxFor(db));
      const b = await runAnalyzers(defaultAnalyzers(), ctxFor(db));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.evidence.flatMap((e) => e.drillDown.map((h) => h.tool))).toEqual(
        b.evidence.flatMap((e) => e.drillDown.map((h) => h.tool)),
      );
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/drilldown-e2e.test.ts`
Expected at this point: PASS — this test consumes only code delivered by
Tasks 1–3. If it fails, the failure is a real defect in those tasks (most
likely an emitted handle whose args do not parse); fix it there, not by
weakening this test.
(If `spike/out/emu_big.db` is absent, the suite reports the file as skipped —
run it on a machine with the fixture before claiming P3 done.)

- [ ] **Step 3: Run the whole suite and record the real counts**

Run: `npm test`
Expected: build + all suites green. Note the exact `Test Files` and `Tests`
lines — with the fixture and a device attached everything runs; on a clean
checkout the fixture suites are skipped.

- [ ] **Step 4: Update the published counts**

Update the test counts in `README.md` (Status paragraph and Quickstart comment)
and `site/index.html` (`<b>` stat and the status pill) to the numbers from
Step 3, keeping the "N with fixtures/device, M + K skipped on a clean
checkout" phrasing. Do not change the prose beyond the counts and the
"P1, P2 and P3" status wording from Task 4.

- [ ] **Step 5: Verify both workspaces typecheck and the site stays balanced**

Run: `npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli`
Expected: exit 0.

Run: `node -e "const t=require('fs').readFileSync('site/index.html','utf8'); const en=(t.match(/data-en=/g)||[]).length, zh=(t.match(/data-zh=/g)||[]).length; console.log(en, zh)"`
Expected: equal counts.

- [ ] **Step 6: Commit**

```bash
git add packages/core/test/drilldown-e2e.test.ts README.md site/index.html
git commit -m "test: prove end-to-end drill-down on a recorded trace"
```

---

## Plan self-review

- **Spec coverage:** §D4 handles → Tasks 1–2 (registry + resolver) and the
  rename of the one dangling handle; §8 `query <scene-dir> <query> [--limit N]`
  → Task 3, plus `tools` for the "CLI --json → tool definitions" half; §8 skill
  responsibilities → Task 4; §11 acceptance "agent 可端到端下钻" → Task 5.
- **Review Focus tests:** (1) Task 2 static scan + Task 5 fixture loop; (2)
  Task 1 limit/boundary and two-run tests, Task 5 repeated resolution; (3) Task
  1 error codes, Task 3 program/deps fail-before-open tests; (4) Task 1 limit
  constants and internal `MAX_QUERY_LIMIT` cap; (5) Task 3 scene.json/`--app`
  tests.
- **Type consistency:** `NamedQueryResult.query` is the query name everywhere;
  `QueryContext` has exactly `{ db, app, caps }`; `CliDeps.query` takes
  `QueryRequest` and returns `NamedQueryResult`; `runDrillDown` consumes a full
  `DrillDownHandle`.
