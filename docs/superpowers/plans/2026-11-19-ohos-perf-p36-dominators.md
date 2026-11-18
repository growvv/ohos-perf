# P36 — Retained size via a dominator tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the JS heap report answer "what holds the memory" instead of "which constructor holds the most bytes of its own" — compute retained size from a dominator tree, rank constructors by it, and report the largest retained holder and the unreachable node count as `exact` metrics.

**Architecture:** a new pure module `packages/core/src/jsheap/dominators.ts` computes immediate dominators (iterative Cooper–Harvey–Kennedy) and retained sizes over a compact CSR graph held in `Int32Array`/`Float64Array` — never objects. `parseHeapSnapshot` builds that graph while it streams the snapshot text (it already walks every node and edge slot), then attributes retained bytes to constructor names. `JsheapAnalyzer` reports the new metrics and its evidence item names the largest holder **by retained size**.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-ohos-perf-p36-dominators-design.md`

**Measured facts this plan depends on** (2026-11-19, this machine):

- A prototype of exactly this algorithm over real engine-written snapshots:
  9.4 MB / 141 605 nodes / 468 808 edges → dominator pass **175 ms**, graph
  **4.9 MB**, root retained 8.7 MB; 50 MB / 861 605 nodes / 2 268 808 edges →
  **665 ms**, graph **12.2 MB**, root retained 32.4 MB.
- The iterative algorithm converges in **~70 rounds** (69 and 70) on both.
- Known-answer check on `0→1→3, 0→2→3, 3→4` with self sizes
  `[1,10,100,1000,10000]`: idom `[0,0,0,0,3]`, retained
  `[11111,10,100,11000,10000]`.
- Self vs retained on a real 9.4 MB snapshot: `Array` self 0.62 MB / retained
  **3.78 MB**; `Object` self 0.96 MB / retained **3.14 MB**; `system / Context`
  self 0.07 MB / retained **0.49 MB**. Ranked by self size `Object` leads;
  ranked by retained `Array` leads.

## Global Constraints

- ESM only; no new runtime dependencies.
- The graph is typed arrays only: `Int32Array` for indices, `Float64Array` for
  sizes. No per-node objects — that was P35's measured regression (51.5 MB
  against `JSON.parse`'s 18.3 MB).
- No recursion in the graph walk. A 100 000-deep object chain must not throw
  `RangeError`.
- Determinism: constructor rows sort by retained size descending, ties broken
  by name; the same snapshot produces byte-identical output everywhere.
- Every new error is an `OhosPerfError` naming the value that failed.
- `npm run verify` (build core, both typechecks, unit suite) passes before
  every commit. After any `packages/cli/src` edit, run
  `npm run build -w packages/cli` first (bundle-freshness test).
- New value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`.
- Version `0.31.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **A node the root cannot reach** (V8 writes nodes the GC already detached) →
   excluded from the retained total, counted in `unreachableCount`, never
   attributed to the root. A retained total equal to the sum of all self sizes
   is the symptom of getting this wrong.
2. **A node with two paths from the root** → its idom is the common ancestor,
   not the first predecessor found.
3. **A very deep chain** (100 000 nested objects) → the iterative DFS completes.
4. **A graph past the documented ceiling** → a named omission naming the node
   and edge counts, not an OOM and not a silently truncated tree.
5. **An object nested inside another object of the same name** → the
   constructor column double-counts it (DevTools does the same); this is
   documented and pinned by a test so it is a stated property, not an accident.

---

### Task 1: The dominator algorithm, pinned to a known graph

**Files:**
- Create: `packages/core/src/jsheap/dominators.ts`
- Test: `packages/core/test/jsheap-dominators.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HeapGraph {
    readonly nodeCount: number;
    /** Successors of node v are targets[outStart[v] .. outStart[v + 1]). */
    readonly outStart: Int32Array;
    readonly targets: Int32Array;
    /** self_size per node, indexed by node index. */
    readonly selfSize: Float64Array;
  }
  export interface Dominators {
    /** Immediate dominator per node; -1 for a node the root cannot reach. */
    readonly idom: Int32Array;
    /** Retained size per node; 0 for an unreachable node. */
    readonly retained: Float64Array;
    readonly reachableCount: number;
  }
  export function computeDominators(graph: HeapGraph): Dominators
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeDominators, type HeapGraph } from '../src/jsheap/dominators';

/** A graph from a successor list and per-node self sizes. */
function graphOf(succ: number[][], selfSize: number[]): HeapGraph {
  const outStart = new Int32Array(succ.length + 1);
  for (let i = 0; i < succ.length; i++) outStart[i + 1] = outStart[i]! + succ[i]!.length;
  const targets = new Int32Array(outStart[succ.length]!);
  succ.forEach((row, v) => row.forEach((w, k) => { targets[outStart[v]! + k] = w; }));
  return { nodeCount: succ.length, outStart, targets, selfSize: Float64Array.from(selfSize) };
}

/**
 * A graph whose dominators can be computed by hand.
 *
 *   0 -> 1 -> 3 -> 4
 *   0 -> 2 -> 3
 *
 * Two paths reach 3, so its immediate dominator is their common ancestor 0,
 * not either predecessor. Self sizes are powers of ten so a mis-attributed
 * byte is unmistakable.
 */
function known(): HeapGraph {
  return graphOf([[1, 2], [3], [3], [4], []], [1, 10, 100, 1000, 10000]);
}

describe('computeDominators', () => {
  it('gives a node with two paths the common ancestor as its immediate dominator', () => {
    const { idom } = computeDominators(known());
    expect(Array.from(idom)).toEqual([0, 0, 0, 0, 3]);
  });

  it('sums retained size up the dominator tree', () => {
    // 4 is dominated only by 3, 3 only by 0, and 1 and 2 only by 0.
    const { retained } = computeDominators(known());
    expect(Array.from(retained)).toEqual([11111, 10, 100, 11000, 10000]);
  });

  it('counts only the nodes the root can reach', () => {
    expect(computeDominators(known()).reachableCount).toBe(5);
  });

  it('leaves an unreachable node out of the retained total', () => {
    // Node 5 is the same shape as the known graph plus an orphan nobody
    // points at. Removing an edge instead would not work: 3 is reachable by
    // two paths, so cutting one leaves it reachable.
    const { idom, retained, reachableCount } = computeDominators(
      graphOf([[1, 2], [3], [3], [4], [], []], [1, 10, 100, 1000, 10000, 500]),
    );
    expect(Array.from(idom)).toEqual([0, 0, 0, 0, 3, -1]);
    expect(retained[5]).toBe(0);
    expect(reachableCount).toBe(5);
    // The root holds 1 + 10 + 100 + 1000 + 10000, not the orphan's 500.
    expect(retained[0]).toBe(11111);
  });

  it('walks a deep chain without recursing', () => {
    // A recursive DFS throws RangeError here; the iterative one does not.
    const depth = 100_000;
    const succ: number[][] = [];
    for (let i = 0; i < depth; i++) succ.push(i + 1 < depth ? [i + 1] : []);
    const { retained, reachableCount } = computeDominators(
      graphOf(succ, new Array(depth).fill(1)),
    );
    expect(reachableCount).toBe(depth);
    expect(retained[0]).toBe(depth);
  });

  it('never reports a retained size below the node\'s own', () => {
    // Retained >= self for every reachable node is a property of a correct
    // tree; a contradictory share means the accumulation is wrong.
    const graph = known();
    const { retained } = computeDominators(graph);
    for (let v = 0; v < graph.nodeCount; v++) {
      expect(retained[v]).toBeGreaterThanOrEqual(graph.selfSize[v]!);
    }
  });

  it('returns empty results for a heap with no nodes', () => {
    const { idom, retained, reachableCount } = computeDominators({
      nodeCount: 0,
      outStart: new Int32Array(1),
      targets: new Int32Array(0),
      selfSize: new Float64Array(0),
    });
    expect(idom).toHaveLength(0);
    expect(retained).toHaveLength(0);
    expect(reachableCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/jsheap-dominators.test.ts`
Expected: FAIL — cannot resolve `../src/jsheap/dominators`.

- [ ] **Step 3: Implement `computeDominators` in `packages/core/src/jsheap/dominators.ts`**

The module doc must state: what dominance means, why CHK rather than
Lengauer–Tarjan (simpler, measured fast enough — 665 ms at 861 k nodes), and
why the walk is iterative (a deep chain would overflow a recursive stack).

Algorithm, in order:

1. **Postorder by iterative DFS from node 0.** Three parallel `Int32Array`
   stacks (`stackNode`, `stackEdge`) and a `Uint8Array` `visited`; record a
   node into `post` when its last successor has been taken. Then
   `order[i] = post[postLen - 1 - i]` is reverse postorder.
2. **RPO number per node** in an `Int32Array` filled with -1.
3. **Predecessor CSR** built by counting `targets` and prefix-summing
   (`inStart`, `preds`), exactly as the prototype does.
4. **CHK fixed point.** `idom[0] = 0`; for every other node in RPO order,
   intersect the already-assigned predecessors with
   ```ts
   const intersect = (a: number, b: number): number => {
     while (a !== b) {
       while (rpo[a]! > rpo[b]!) a = idom[a]!;
       while (rpo[b]! > rpo[a]!) b = idom[b]!;
     }
     return a;
   };
   ```
   Repeat until no `idom` changes.
5. **Retained** starts as a copy of `selfSize`, then for `i = postLen - 1 .. 1`
   add `retained[order[i]]` into `retained[idom[order[i]]]`.
6. Nodes with `idom === -1` keep `retained = 0`; `reachableCount = postLen`.

Guard: `nodeCount === 0` returns empty arrays rather than throwing (a
zero-node snapshot is structurally valid).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/jsheap-dominators.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jsheap/dominators.ts packages/core/test/jsheap-dominators.test.ts
git commit -m "feat(jsheap): compute retained size from a dominator tree"
```

---

### Task 2: Build the graph while streaming, and attribute retained size

**Files:**
- Modify: `packages/core/src/jsheap/snapshot.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/jsheap-snapshot.test.ts`

**Interfaces:**
- Consumes: `computeDominators`, `HeapGraph` from Task 1.
- Produces:
  ```ts
  export interface ConstructorShare {
    readonly name: string;
    readonly selfSize: number;
    /** Sum of the retained size of every node of this name. */
    readonly retainedSize: number;
    readonly count: number;
  }
  export type RetainedAnalysis =
    | {
        readonly kind: 'measured';
        readonly byConstructor: readonly ConstructorShare[];
        readonly unreachableCount: number;
      }
    | { readonly kind: 'omitted'; readonly reason: string };
  ```
  `HeapSnapshot` replaces `retainedByConstructor` with
  `readonly retained: RetainedAnalysis`.
  `parseHeapSnapshot(text: string)` keeps its one-argument signature (the size
  option arrives in Task 4).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/jsheap-snapshot.test.ts`.

**Define `container` at module scope**, not inside the describe: Task 4's test
uses it too.

```ts
/**
 * Retained size answers a different question from self size.
 *
 * `root -> Array(self 8) -> 10 x Item(self 100)`. The Array's own bytes are 8,
 * so a self-size ranking puts `Item` (1000) far ahead; what the Array *holds*
 * is 1008 bytes, which is what a leak hunt is asking about. Self 8 rather than
 * 0 is deliberate: at 0 the Array's retained size would tie `Item`'s and the
 * ranking test could pass on the alphabetical tiebreak instead of on the
 * property it claims to test.
 */

/**
 * `root -> Array(self 8) -> 10 x Item(self 100 each)`, plus an optional
 * orphan object nobody points at.
 *
 * Node 0 is the root (hidden, one edge), node 1 the Array, nodes 2..11 the
 * Items. Every record is `[type, name, id, self_size, edge_count,
 * detachedness]` and every edge is `[type, name_or_index, to_node]` with
 * `to_node` the node index times the node field count (6).
 */
function container(orphanSelfSize?: number): string {
  const nodes: number[] = [0, 0, 1, 0, 1, 0, 3, 1, 2, 8, 10, 0];
  for (let i = 0; i < 10; i++) nodes.push(3, 2, 3 + i, 100, 0, 0);
  const edges: number[] = [2, 1, 6];
  for (let i = 0; i < 10; i++) edges.push(2, i, (2 + i) * 6);
  const strings = ['', 'Array', 'Item'];
  let nodeCount = 12;
  if (orphanSelfSize !== undefined) {
    // Node 12, named `Orphan`, and no edge points at it.
    nodes.push(3, 3, 99, orphanSelfSize, 0, 0);
    strings.push('Orphan');
    nodeCount = 13;
  }
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
      },
      node_count: nodeCount,
      edge_count: 11,
    },
    nodes,
    edges,
    strings,
  });
}

describe('retained attribution', () => {
  it('attributes what a container holds to the container', () => {
    const snapshot = parseHeapSnapshot(container());
    expect(snapshot.retained.kind).toBe('measured');
    if (snapshot.retained.kind !== 'measured') throw new Error('unreachable');
    expect(snapshot.retained.byConstructor.find((row) => row.name === 'Array'))
      .toEqual({ name: 'Array', selfSize: 8, retainedSize: 1008, count: 1 });
    expect(snapshot.retained.byConstructor.find((row) => row.name === 'Item'))
      .toEqual({ name: 'Item', selfSize: 1000, retainedSize: 1000, count: 10 });
    expect(snapshot.retained.unreachableCount).toBe(0);
  });

  it('ranks by retained size, not self size', () => {
    // By self size Item (1000) beats Array (8). By retained size Array holds
    // 1008 and ranks first — the motivating difference, and not a tie, so the
    // ordering cannot come from the name tiebreak.
    const snapshot = parseHeapSnapshot(container());
    if (snapshot.retained.kind !== 'measured') throw new Error('unreachable');
    expect(snapshot.retained.byConstructor[0]!.name).toBe('Array');
  });

  it('gives a node the root cannot reach no retained size', () => {
    // An object nothing points at is memory no one holds. It still counts in
    // the heap total — it is in the file — but contributes no retained bytes.
    const snapshot = parseHeapSnapshot(container(500));
    if (snapshot.retained.kind !== 'measured') throw new Error('unreachable');
    expect(snapshot.retained.unreachableCount).toBe(1);
    expect(snapshot.totalSelfSize).toBe(1508);
    expect(snapshot.retained.byConstructor.find((row) => row.name === 'Orphan'))
      .toEqual({ name: 'Orphan', selfSize: 500, retainedSize: 0, count: 1 });
  });

  it('double-counts an object nested inside one of the same name, like DevTools', () => {
    // `root -> Array(self 10) -> Array(self 20)`. One row sums both nodes'
    // retained sizes (10 + 20 = 30 for the outer, 20 for the inner), so the
    // row reports 50 against a heap of 30. DevTools does the same; the point
    // of pinning it is that it is a stated property, not a surprise.
    const text = JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
          node_types: [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
        },
        node_count: 3,
        edge_count: 2,
      },
      nodes: [0, 0, 1, 0, 1, 0, 3, 1, 2, 10, 1, 0, 3, 1, 3, 20, 0, 0],
      edges: [2, 1, 6, 2, 2, 12],
      strings: ['', 'Array'],
    });
    const snapshot = parseHeapSnapshot(text);
    if (snapshot.retained.kind !== 'measured') throw new Error('unreachable');
    expect(snapshot.retained.byConstructor)
      .toEqual([{ name: 'Array', selfSize: 30, retainedSize: 50, count: 2 }]);
    expect(snapshot.totalSelfSize).toBe(30);
  });
});
```

Also update the three existing assertions that spell out a `ConstructorShare`
object literal so they include `retainedSize`, and the two that read
`snapshot.retainedByConstructor` so they read `snapshot.retained`:
- `expect(...).toEqual({ name: 'A', selfSize: 64, count: 1 })` →
  `{ name: 'A', selfSize: 64, retainedSize: 64, count: 1 }` (and the same for
  `B`, retained 32).
- The `'translates to_node …'` and `'ranks constructors by self size …'` tests
  read `.retainedByConstructor` → read the measured rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts`
Expected: FAIL — `snapshot.retained` is undefined; `retainedSize` missing.

- [ ] **Step 3: Build the graph in `parseHeapSnapshot`**

In `packages/core/src/jsheap/snapshot.ts`:

1. Change `ConstructorShare` to carry `retainedSize`, and add
   `RetainedAnalysis` exactly as the Interfaces block says. Replace
   `HeapSnapshot.retainedByConstructor` with `readonly retained: RetainedAnalysis`
   and rewrite the doc comment: retained size is now measured; the union's
   `omitted` arm exists for Task 4's guard.
2. Allocate `selfSizeOf = new Float64Array(header.nodeCount)` and
   `edgeCountOf = new Int32Array(header.nodeCount)` and
   `nameOf = new Int32Array(header.nodeCount)` before the node loop. Fill them
   in it. Keep `byName` for self size and count as today, and add a parallel
   `byNameRetained` map filled in a later pass.
3. Hoist the per-node `record` allocation out of the loop — one
   `new Float64Array(width)` before it, reused, instead of one per node.
4. Prefix-sum `edgeCountOf` into `outStart` (`Int32Array`, nodeCount + 1) and
   fill `targets` (`Int32Array`, edgeCount) in the existing edge loop, keeping
   its `to_node` validation exactly as it is. Write `targets[cursor++] = target`.
5. Call `computeDominators({ nodeCount, outStart, targets, selfSize })`.
6. Attribute: for every node `v` with `idom[v] !== -1` whose type is `object`
   or `closure`, add `retained[v]` into `byNameRetained` under
   `strings[nameOf[v]]`. Nodes with `idom === -1` contribute nothing.
7. `rankConstructors` takes both maps and sorts by `retainedSize` descending,
   ties broken by name, returning `{ name, selfSize, retainedSize, count }`.
8. `retained` is `{ kind: 'measured', byConstructor, unreachableCount: nodeCount - reachableCount }`.

The `unreachableCount` must come from `computeDominators`'s `reachableCount`,
not from a separate reachability walk.

- [ ] **Step 4: Export the new types**

In `packages/core/src/index.ts`, add `RetainedAnalysis` to the type export list
beside `ConstructorShare`, and export `computeDominators` plus
`type { HeapGraph, Dominators }` from `./jsheap/dominators`.

Add `'computeDominators'` to `VALUE_EXPORTS` in
`packages/core/test/types.test.ts`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts packages/core/test/jsheap-dominators.test.ts packages/core/test/types.test.ts`
Expected: PASS. `types.test.ts` may first fail on a stale `dist` — run
`npm run build -w packages/core` and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/jsheap packages/core/src/index.ts packages/core/test
git commit -m "feat(jsheap): attribute retained size to constructors"
```

---

### Task 3: Report retained size from the analyzer

**Files:**
- Modify: `packages/core/src/analyze/jsheap.ts`
- Test: `packages/core/test/analyze-jsheap.test.ts`

**Interfaces:**
- Consumes: `HeapSnapshot.retained` from Task 2.
- Produces: metrics `jsheap.retained.largest.bytes` and
  `jsheap.unreachable.count`.

- [ ] **Step 1: Write the failing test**

Replace the fixture's expectations and add two tests in
`packages/core/test/analyze-jsheap.test.ts`:

```ts
  it('reports the largest retained holder and the unreachable count', async () => {
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    const byId = new Map(result.metrics.map((m) => [m.id, m.value]));
    // Both objects are held only by the root, so each retains its own bytes.
    expect(byId.get('jsheap.retained.largest.bytes')).toBe(64);
    expect(byId.get('jsheap.unreachable.count')).toBe(0);
  });

  it('names the largest constructor by retained size and says so', async () => {
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
    const item = result.evidence.find((e) => e.kind === 'js_heap');
    expect(item?.explain).toContain('retained');
    expect(item?.signals).toMatchObject({
      constructor: 'A', selfSize: 64, retainedSize: 64,
    });
  });
```

Update the existing `'names the largest constructor rather than listing every
one'` test's `toMatchObject` to include `retainedSize: 64`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/analyze-jsheap.test.ts`
Expected: FAIL — `jsheap.retained.largest.bytes` is undefined.

- [ ] **Step 3: Implement in `packages/core/src/analyze/jsheap.ts`**

- Add the two metrics to the `metrics` array, both `exact`, same provenance.
  `jsheap.retained.largest.bytes` is `0` when there are no constructor rows
  (an empty heap legitimately has no holder).
- The evidence item reads `snapshot.retained.byConstructor[0]` when the
  analysis is `measured`; its `explain` becomes
  `` `${name} retains the largest self size ...` `` — see the exact wording
  below — and its signals gain `retainedSize`.
- When `retained.kind === 'omitted'` (Task 4 makes this reachable), skip both
  new metrics and the constructor evidence, and emit one `info` item of kind
  `js_heap` whose `explain` is the omission reason. Task 4 supplies the test.
- Update the class doc comment: it currently says the numbers are self size;
  it must say retained size is now measured and name the dominator pass.

Exact `explain` wording:
```ts
`${largest.name} retains the largest share: ${largest.retainedSize} bytes of` +
` retained size across ${largest.count} nodes (self size ${largest.selfSize} bytes)` +
(detached > 0 ? `; ${detached} node(s) are detached` : '')
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit packages/core/test/analyze-jsheap.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/jsheap.ts packages/core/test/analyze-jsheap.test.ts
git commit -m "feat(jsheap): report the largest retained holder and unreachable nodes"
```

---

### Task 4: Refuse to build an impossible graph

**Files:**
- Modify: `packages/core/src/jsheap/snapshot.ts`
- Modify: `packages/core/src/analyze/jsheap.ts`
- Test: `packages/core/test/jsheap-snapshot.test.ts`, `packages/core/test/analyze-jsheap.test.ts`

**Interfaces:**
- Produces: `parseHeapSnapshot(text: string, options?: HeapParseOptions)` where
  `HeapParseOptions = { readonly maxGraphEdges?: number }`; exported constant
  `MAX_GRAPH_EDGES = 20_000_000`.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/jsheap-snapshot.test.ts`:

```ts
  it('omits attribution, naming the size, when the graph is past the ceiling', () => {
    // The fixture has 11 edges and a 5-edge ceiling, so the graph is refused.
    // The cheap aggregates are still exact — the heap was read, only the
    // attribution is omitted.
    const snapshot = parseHeapSnapshot(container(), { maxGraphEdges: 5 });
    expect(snapshot.retained.kind).toBe('omitted');
    if (snapshot.retained.kind !== 'omitted') throw new Error('unreachable');
    expect(snapshot.retained.reason).toMatch(/11 edges/);
    expect(snapshot.retained.reason).toMatch(/5-edge ceiling/);
    expect(snapshot.totalSelfSize).toBe(1008);
    expect(snapshot.nodeCount).toBe(12);
  });
```

In `packages/core/test/analyze-jsheap.test.ts`:

```ts
  it('reports the heap totals without attribution when the graph is too large', async () => {
    const result = await new JsheapAnalyzer().run(context({ jsheap: heap(), jsheapMaxGraphEdges: 1 }));
    const ids = result.metrics.map((m) => m.id);
    expect(ids).toContain('jsheap.total.bytes');
    expect(ids).not.toContain('jsheap.retained.largest.bytes');
    expect(ids).not.toContain('jsheap.unreachable.count');
    expect(result.evidence.find((e) => e.kind === 'js_heap')?.explain).toMatch(/too large|attribution/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts packages/core/test/analyze-jsheap.test.ts`
Expected: FAIL — `parseHeapSnapshot` ignores a second argument;
`jsheapMaxGraphEdges` is not a context field.

- [ ] **Step 3: Implement**

- In `snapshot.ts`: `export const MAX_GRAPH_EDGES = 20_000_000;` with a doc
  comment deriving it from the measured cost (8 bytes an edge for both
  adjacency arrays, so ~160 MB at the ceiling) and saying what a real
  HarmonyOS snapshot is (tens to hundreds of MB, ~4.5 M edges for a 100 MB one).
  `parseHeapSnapshot` takes `options`, and when
  `header.edgeCount > (options.maxGraphEdges ?? MAX_GRAPH_EDGES)` it returns
  the snapshot with
  `retained: { kind: 'omitted', reason: \`the graph has ${header.edgeCount} edges, past the ${limit}-edge ceiling; heap totals are reported without retained attribution\` }`
  — after still doing the validation pass and the self-size aggregation.
- In `analyze/types.ts`: add `readonly jsheapMaxGraphEdges?: number;` to
  `AnalyzeContext` with a comment saying it exists so a constrained caller can
  lower the ceiling.
- In `analyze/jsheap.ts`: pass `{ maxGraphEdges: ctx.jsheapMaxGraphEdges }`
  and handle the `omitted` arm per Task 3's step 3.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts packages/core/test/analyze-jsheap.test.ts packages/core/test/analyze-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/core/test
git commit -m "feat(jsheap): omit attribution past a documented graph ceiling"
```

---

### Task 5: Docs, counts, and 0.31.0

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `site/index.html`, `packages/core/package.json`, `packages/cli/package.json`

- [ ] **Step 1: Measure the real counts before writing them**

Run: `npm run verify` and record the unit total.
Run the clean-checkout measurement by moving the two fixture databases aside:
```bash
mkdir -p /tmp/ohosfix && mv spike/out/emu_big.db spike/out/real_device.db /tmp/ohosfix/
npx vitest run --project unit 2>&1 | tail -4
mv /tmp/ohosfix/emu_big.db /tmp/ohosfix/real_device.db spike/out/
```
Never copy the previous release's numbers — 0.30.1 shipped a stale 2392 that
measured 2395.

- [ ] **Step 2: Update the metric table and the P36 row**

- `README.md` metric-id table: the `jsheap.*` row gains
  `jsheap.retained.largest.bytes` and `jsheap.unreachable.count`.
- `README.md` roadmap: add the P36 row after P35, stating what the dominator
  pass measures, the self-vs-retained divergence numbers from the spec, the
  measured cost (665 ms and 12.2 MB at 861 k nodes), the DevTools-compatible
  double-count, and `shipped in 0.31.0`.
- `README.md` status: the new counts, measured in Step 1.
- `CHANGELOG.md`: a 0.31.0 entry whose lead is the self-vs-retained table, and
  which states the **breaking change**: `HeapSnapshot.retainedByConstructor`
  is replaced by `retained: RetainedAnalysis`.
- `site/index.html`: the P36 card in both English and Chinese, the metric list,
  the counts, and the version badge. Both languages must say twenty-three
  analyzers (the count does not change) and the same test totals.
- Both `package.json` files to `0.31.0`; the CLI's `@ohos-perf/core` pin to
  `0.31.0`.

- [ ] **Step 3: Run the doc tests**

Run: `npm run verify`
Expected: PASS, including `doc-counts`, `doc-analyzers` and `doc-measured`.
If `doc-measured` fails, the analyzer's `no_data` count per scene moved —
re-read its message and use the number it reports.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md site/index.html packages/*/package.json
git commit -m "docs: record P36 retained size and 0.31.0"
```

- [ ] **Step 5: Release**

Tag `v0.31.0`, push `master` and the tag to
`ssh://git@ssh.github.com:443/growvv/ohos-perf.git`, publish both packages with
`NPM_CONFIG_USERCONFIG=/tmp/npmrc-publish`, poll the registry until both report
`0.31.0`, smoke-test a fresh install (a real snapshot: assert the retained
ranking puts a container above a leaf of larger self size), create the GitHub
release, and confirm CI and Pages are green before reporting the release
complete.
