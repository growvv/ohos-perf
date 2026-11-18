# P35 — JS heap snapshot analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `js.heap` a real measurement — parse the `.heapsnapshot` file `collect --jsheap` already pulls, and report total/retained heap size, node counts by type, detached nodes, and the largest retaining constructors as metrics and evidence, with a named `no_data` when a scene carries no snapshot.

**Architecture:** a new pure-TypeScript snapshot reader in `packages/core/src/jsheap/` that streams the JSON text rather than `JSON.parse`-ing it (a 5.5 MB snapshot costs 17.6 MB of parsed objects, measured; a real app's is hundreds of MB), producing a typed `HeapSnapshot` value. `JsheapAnalyzer` reads the snapshot text from `AnalyzeContext`, computes metrics with `fidelity: 'exact'` and provenance naming the artifact, and emits `no_data` when absent — the opposite of HapRay, which captures the file and analyzes nothing. `js.heap` keeps its measured unavailable verdict in the device capability matrix (the device route is dead: measured below), and the analyzer declares no capability requirement, exactly as `coverage` does, because the artifact is a scene file rather than a device probe.

**Tech Stack:** TypeScript (ESM), Node 22, Vitest 2.1.9. No new dependencies. The parser is hand-written over the snapshot's own `snapshot.meta` field lists.

**Spec:** HapRay parity row 20 (`JS heap snapshot capture`) at rev `bd5c98a`: `perf_testing/hapray/core/collection/data_collector.py` captures the snapshot and nothing in `perf_testing/hapray/analyze/` consumes it. This plan is **beyond the inventory**: it keeps the capture and adds the analysis HapRay does not have.

**Measured facts this plan depends on** (2026-11-18, this machine):

- A real V8 snapshot from `v8.writeHeapSnapshot` has top-level keys
  `snapshot, nodes, edges, trace_function_infos, trace_tree, samples, locations, strings`.
- `snapshot.meta.node_fields` = `["type","name","id","self_size","edge_count","detachedness"]`;
  `node_types[0]` = `["hidden","array","string","object","code","closure","regexp","number","native","synthetic","concatenated string","sliced string","symbol","bigint","object shape"]`.
- `snapshot.meta.edge_fields` = `["type","name_or_index","to_node"]`;
  `edge_types[0]` = `["context","element","property","internal","hidden","shortcut","weak"]`.
- `edges` `to_node` is **node index × node_field_count**, not a byte offset
  (measured: `to_node` 6 with `node_field_count` 6 is node 1, the root).
- `detachedness` is V8's `EmbedderGraph::Node::Detachedness`: 0 unknown,
  1 attached, 2 detached.
- `nodes`/`edges` are flat number arrays; a 5.5 MB snapshot parses to 416 850
  node slots and 864 672 edge slots.
- `JSON.parse` of that 5.5 MB file costs 17.6 MB RSS of objects; a real
  HarmonyOS app snapshot is tens to hundreds of MB, so the reader must scan.
- The device route is **dead on this hardware**: on the Mate 60, with a
  debug-signed app running (`com.example.canvascomponent`, pid 7708),
  `hidumper --mem-jsheap <pid>` exits 0 and writes no `.heapsnapshot` anywhere
  under `/data/app/el2/100/base`, `/data/log` or `/data/storage`; `--raw`
  likewise. `hidumper -h` also shows `-T` is a **tid**, while
  `JsheapCollector` passes the pid — a real defect fixed in Task 1.

## Global Constraints

- ESM only; no new runtime dependencies. The parser uses `String.prototype.indexOf`
  and `Number()` on slices; nothing else.
- `npm run verify` (build core, both typechecks, unit suite) must pass before
  every commit; after any `packages/cli/src` edit run `npm run build -w packages/cli`
  first (bundle-freshness test).
- The snapshot is data from outside the package: every field is validated
  against `snapshot.meta` before it is used. A snapshot whose `meta` lists
  fields this reader does not know is a typed refusal naming the field, never
  a guess at an offset.
- Determinism: analyzer output is sorted (metrics by id, evidence by
  `(kind, startNs, id)`); the same snapshot produces byte-identical analysis.
  Ties in any "top N" list break on a stable key, never on insertion order.
- Every new error is an `OhosPerfError` whose message names the value that
  failed. No silent defaults; no silent skip.
- No snapshot is loaded into memory in full as objects: the reader keeps the
  text and two typed arrays, and must handle a 300 MB file without a
  `RangeError`.
- New core value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`;
  every registered analyzer gets an entry in `TOKENS` in
  `packages/cli/test/doc-analyzers.test.ts` and a row in the README's metric-id table.
- Version `0.30.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. A snapshot that is truncated mid-file (a killed dump) → the reader refuses
   with the byte offset and the key it was in, rather than reporting the nodes
   it managed to read as the whole heap.
2. A snapshot whose `node_fields` puts `detachedness` in a different position,
   or omits it (older V8) → the reader indexes by the field list it read, and
   omits the detached metric entirely rather than counting every node as
   attached.
3. A `to_node` that points past the end of `nodes` → the reader refuses naming
   the edge index and the value; it never reads `undefined` as size 0.
4. A snapshot of a heap with one enormous retained subtree and 500 000 tiny
   objects → the top-N list is bounded and sorted deterministically, so memory
   stays flat and two runs on the same file are byte-identical.
5. A scene that carries `jsheap.heapsnapshot` from an **earlier** capture
   (the file is present but `scene.json` does not list the collector) → the
   analyzer reads it only when the descriptor declares it, so a stale
   snapshot is not reported as this scene's heap.

---

## File Structure

- Create `packages/core/src/jsheap/snapshot.ts` — the streaming reader: text
  in, `HeapSnapshot` out; meta validation, node/edge scanning, typed refusal.
- Create `packages/core/src/jsheap/retainers.ts` — the retained-size
  computation over the parsed index (dominance-free: per-node incoming edge
  accounting is enough for "largest constructors", and the plan states the
  limit explicitly).
- Create `packages/core/src/analyze/jsheap.ts` — `JsheapAnalyzer`: metrics,
  evidence, `no_data` path.
- Modify `packages/core/src/analyze/types.ts` — `jsheap?: string` on the context.
- Modify `packages/core/src/analyze/engine.ts` — register the analyzer.
- Modify `packages/core/src/report/evidence.ts` — `js_heap` kind.
- Modify `packages/core/src/index.ts` — value and type exports.
- Modify `packages/core/src/collectors/jsheap.ts` — drop the pid-as-tid `-T`.
- Modify `packages/cli/src/deps.ts` — read `jsheap.heapsnapshot` into the context.
- Modify `packages/core/test/types.test.ts` — `VALUE_EXPORTS`.
- Modify `packages/cli/test/doc-analyzers.test.ts` — `TOKENS` entry.
- Modify `README.md`, `CHANGELOG.md`, `site/index.html`, `packages/*/package.json`.

---

### Task 1: Fix the collector's pid-as-tid argument

**Files:**
- Modify: `packages/core/src/collectors/jsheap.ts:145`
- Test: `packages/core/test/collector-jsheap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JsheapCollector.collect` unchanged in signature; the device
  command it issues becomes `hidumper --mem-jsheap <pid>`.

`hidumper -h` on the Mate 60 prints
`--mem-jsheap pid [-T tid] [--gc] [--leakobj] [--raw] [--single] [--clean]`.
`-T` is a **thread** id. Passing the pid as the tid asks the device to dump a
thread that is not the main thread, and on this hardware it exits 0 having
written nothing — a silent empty capture, which is the exact failure mode the
collector's own error path exists to prevent. Dropping `-T` asks for the whole
process heap, which is what the collector means.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/collector-jsheap.test.ts`, add:

```ts
it('dumps the whole process heap: -T is a tid, not a pid', async () => {
  // `hidumper -h` documents `--mem-jsheap pid [-T tid]`. Passing the pid as
  // the tid asked for a thread dump; measured on the Mate 60 that exits 0 and
  // writes nothing, so the capture silently produced no snapshot.
  const commands: string[] = [];
  const capture = await collectWith((cmd) => {
    commands.push(cmd);
    return undefined;
  });
  expect(capture.ok).toBe(true);
  expect(commands.filter((cmd) => cmd.startsWith('hidumper --mem-jsheap')))
    .toEqual(['hidumper --mem-jsheap 4242']);
});
```

Use the file's existing fake-`Hdc` helper (`collectWith` is the shape the
other cases in that file use; if the helper has another name, use it and
name the change in a ledger ruling).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/core/test/collector-jsheap.test.ts`
Expected: FAIL — the command recorded is `hidumper --mem-jsheap 4242 -T 4242`.

- [ ] **Step 3: Drop the tid argument**

In `packages/core/src/collectors/jsheap.ts`, replace

```ts
const dump = await hdc.shell(target, `hidumper --mem-jsheap ${pidText} -T ${pidText}`);
```

with

```ts
// `-T` is a *thread* id (`hidumper -h`). Passing the pid there asks for a
// thread dump, which on the Mate 60 exits 0 and writes no snapshot — a silent
// empty capture. Without it hidumper dumps the whole process heap.
const dump = await hdc.shell(target, `hidumper --mem-jsheap ${pidText}`);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit packages/core/test/collector-jsheap.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collectors/jsheap.ts packages/core/test/collector-jsheap.test.ts
git commit -m "fix(jsheap): dump the process heap, not a thread named by the pid"
```

---

### Task 2: Read the snapshot header and its field lists

**Files:**
- Create: `packages/core/src/jsheap/snapshot.ts`
- Test: `packages/core/test/jsheap-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface HeapSnapshotHeader { readonly nodeFieldCount: number; readonly edgeFieldCount: number; readonly nodeCount: number; readonly edgeCount: number; readonly nodeTypeNames: readonly string[]; readonly edgeTypeNames: readonly string[]; readonly nodeFieldIndex: Readonly<Record<string, number>>; readonly edgeFieldIndex: Readonly<Record<string, number>>; }`
  - `export function readSnapshotHeader(text: string): HeapSnapshotHeader`
  - `export function readNumberArray(text: string, key: string): Float64Array` — the array of numbers under a top-level `"nodes"`/`"edges"` key, scanned rather than parsed.
  - Both throw `OhosPerfError` with code `JSHEAP_BAD_SNAPSHOT` naming what failed.

The reader must not `JSON.parse` the document: measured, a 5.5 MB snapshot
costs 17.6 MB of objects, and a real app's is far larger. `readSnapshotHeader`
finds `"snapshot"` and parses **only** that object's slice, which is small and
bounded; `readNumberArray` walks the digits of a flat number array into a
`Float64Array`, which is 8 bytes a slot instead of a boxed number.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/jsheap-snapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readNumberArray, readSnapshotHeader } from '../src/jsheap/snapshot';

/** A minimal but structurally real snapshot, in V8's own shape. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
      },
      node_count: 2,
      edge_count: 1,
      ...overrides,
    },
    nodes: [9, 1, 1, 0, 1, 0, 3, 2, 2, 64, 0, 0],
    edges: [2, 1, 6],
    strings: ['', 'root'],
  });
}

describe('readSnapshotHeader', () => {
  it('reads the field lists and the counts the document declares', () => {
    const header = readSnapshotHeader(document());
    expect(header.nodeFieldCount).toBe(6);
    expect(header.edgeFieldCount).toBe(3);
    expect(header.nodeCount).toBe(2);
    expect(header.edgeCount).toBe(1);
    expect(header.nodeTypeNames).toEqual(['hidden', 'array', 'string', 'object']);
    expect(header.nodeFieldIndex['detachedness']).toBe(5);
    expect(header.edgeFieldIndex['to_node']).toBe(2);
  });

  it('indexes fields by the list it read, not by a fixed offset', () => {
    // An older V8 has no `detachedness`. A reader that hardcoded offset 5
    // would read past the record; this one reports the field as absent.
    const text = document();
    const older = text.replace('"detachedness",', '').replace(
      '"number","number","number","number"]',
      '"number","number","number"]',
    );
    const header = readSnapshotHeader(older);
    expect(header.nodeFieldIndex['detachedness']).toBeUndefined();
    expect(header.nodeFieldCount).toBe(5);
  });

  it('refuses a document with no snapshot block, naming what it looked for', () => {
    expect(() => readSnapshotHeader('{"nodes":[],"edges":[]}'))
      .toThrow(/no "snapshot" block/);
  });

  it('refuses a meta whose node_fields omit a field this reader needs', () => {
    const text = document().replace('"self_size",', '');
    expect(() => readSnapshotHeader(text)).toThrow(/self_size/);
  });

  it('refuses malformed JSON with the reason, not a raw SyntaxError', () => {
    expect(() => readSnapshotHeader('{"snapshot":')).toThrow(/not valid JSON/);
  });
});

describe('readNumberArray', () => {
  it('scans a flat number array into a typed array', () => {
    const values = readNumberArray(document(), 'nodes');
    expect(Array.from(values)).toEqual([9, 1, 1, 0, 1, 0, 3, 2, 2, 64, 0, 0]);
  });

  it('refuses a truncated array, naming the key and the position', () => {
    // A killed dump leaves a half-written array. Reporting the numbers that
    // happened to parse would present a partial heap as the whole heap.
    const truncated = document().replace('"nodes":[9,1,1,0,1,0,3,2,2,64,0,0]', '"nodes":[9,1,1,0,1,0,3,2');
    expect(() => readNumberArray(truncated, 'nodes')).toThrow(/nodes.*truncated|truncated.*nodes/);
  });

  it('refuses a missing key', () => {
    expect(() => readNumberArray('{"snapshot":{}}', 'edges')).toThrow(/no "edges" array/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts`
Expected: FAIL — `Cannot find module '../src/jsheap/snapshot'`.

- [ ] **Step 3: Implement the reader**

Create `packages/core/src/jsheap/snapshot.ts`. Required behaviour, not a
transcript:

- `readSnapshotHeader(text)`: find `"snapshot"`, find the object's opening
  brace, scan braces (respecting string literals and escapes) to its matching
  close, `JSON.parse` that slice only. Missing block → `no "snapshot" block in
  the document`. Invalid JSON → `the snapshot header is not valid JSON: <msg>`.
- Require `meta.node_fields` and `meta.edge_fields` to be arrays of strings,
  and `node_types[0]`/`edge_types[0]` likewise; a missing or non-array one is
  a refusal naming it.
- Require `node_fields` to contain `type`, `name`, `self_size`, `edge_count`;
  require `edge_fields` to contain `type`, `name_or_index`, `to_node`. A
  missing one is `the snapshot's node_fields have no "self_size"` (the field's
  own name in the message).
- `detachedness` is **optional**; `nodeFieldIndex` simply has no key for it.
- Require `node_count` and `edge_count` to be non-negative safe integers.
- `readNumberArray(text, key)`: find `"<key>"`, then `[`, then walk digits,
  `-`, `.`, `e`, and `,`/whitespace into a growable `Float64Array` (double on
  overflow). Any character that is not one of those before the closing `]` is
  `the "<key>" array is truncated or not a number array at <position>`. No
  key → `no "<key>" array in the document`.

Every error: `new OhosPerfError(message, { code: 'JSHEAP_BAD_SNAPSHOT' })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jsheap/snapshot.ts packages/core/test/jsheap-snapshot.test.ts
git commit -m "feat(jsheap): read a heap snapshot's field lists without parsing the whole file"
```

---

### Task 3: Walk the nodes and edges into a typed index

**Files:**
- Modify: `packages/core/src/jsheap/snapshot.ts`
- Test: `packages/core/test/jsheap-snapshot.test.ts`

**Interfaces:**
- Consumes: `HeapSnapshotHeader`, `readSnapshotHeader`, `readNumberArray`.
- Produces:
  - `export interface HeapNode { readonly index: number; readonly type: string; readonly name: string; readonly selfSize: number; readonly edgeCount: number; readonly detached: boolean; }`
  - `export interface HeapSnapshot { readonly header: HeapSnapshotHeader; readonly nodes: readonly HeapNode[]; readonly nodeCountByType: ReadonlyMap<string, number>; readonly totalSelfSize: number; readonly detachedCount: number; readonly retainedByConstructor: readonly { name: string; selfSize: number; count: number }[]; }`
  - `export function parseHeapSnapshot(text: string): HeapSnapshot`
  - Throws `OhosPerfError` code `JSHEAP_BAD_SNAPSHOT`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/jsheap-snapshot.test.ts`:

```ts
describe('parseHeapSnapshot', () => {
  /** Two objects of 64 and 32 bytes under the root, one detached. */
  function heap(): string {
    const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'];
    return JSON.stringify({
      snapshot: {
        meta: {
          node_fields: nodeFields,
          node_types: [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
        },
        node_count: 3,
        edge_count: 2,
      },
      // root(hidden), A(object, detached), B(object)
      nodes: [0, 0, 1, 0, 2, 0, 3, 1, 2, 64, 0, 2, 3, 2, 3, 32, 0, 1],
      // root --property--> A ; root --property--> B (to_node is index*6)
      edges: [2, 1, 6, 2, 2, 12],
      strings: ['', 'A', 'B'],
    });
  }

  it('reads every node with its type name, size and detached flag', () => {
    const snapshot = parseHeapSnapshot(heap());
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.nodes[1]).toMatchObject({ type: 'object', name: 'A', selfSize: 64, detached: true });
    expect(snapshot.nodes[2]).toMatchObject({ type: 'object', name: 'B', selfSize: 32, detached: false });
  });

  it('sums self size and counts detached nodes', () => {
    const snapshot = parseHeapSnapshot(heap());
    expect(snapshot.totalSelfSize).toBe(96);
    expect(snapshot.detachedCount).toBe(1);
  });

  it('translates to_node from a slot offset into a node index', () => {
    // `to_node` is node index * node_field_count (measured: 6 -> node 1).
    // Reading it as an index would attribute every edge to node 6.
    const snapshot = parseHeapSnapshot(heap());
    expect(snapshot.nodes[1]!.name).toBe('A');
    expect(snapshot.nodeCountByType.get('object')).toBe(2);
  });

  it('refuses an edge that points past the end of the node array', () => {
    const bad = heap().replace('"edges":[2,1,6,2,2,12]', '"edges":[2,1,6,2,2,999]');
    expect(() => parseHeapSnapshot(bad)).toThrow(/edge 1.*999|999.*past/);
  });

  it('omits detached counting when the snapshot has no detachedness field', () => {
    const older = JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
          node_types: [['hidden', 'object'], 'string', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['property'], 'string_or_number', 'node'],
        },
        node_count: 1,
        edge_count: 0,
      },
      nodes: [1, 0, 1, 16, 0],
      edges: [],
      strings: [''],
    });
    const snapshot = parseHeapSnapshot(older);
    expect(snapshot.detachedCount).toBe(0);
    expect(snapshot.nodes[0]!.detached).toBe(false);
  });

  it('ranks constructors by self size, ties broken by name', () => {
    const snapshot = parseHeapSnapshot(heap());
    expect(snapshot.retainedByConstructor[0]!.name).toBe('A');
    expect(snapshot.retainedByConstructor.map((row) => row.name)).toEqual(['A', 'B']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts`
Expected: FAIL — `parseHeapSnapshot is not exported`.

- [ ] **Step 3: Implement `parseHeapSnapshot`**

Rules:

- Read the header, then both arrays; require
  `nodes.length === nodeCount * nodeFieldCount` and
  `edges.length === edgeCount * edgeFieldCount`, else refuse naming both
  numbers (`the "nodes" array holds 12 values; node_count * node_fields is 18`).
- For each node, resolve `type` and `name` through `strings` (index bounds
  checked; out of range is a refusal naming the node index). `detached` is
  `detachedness === 2` when the field exists, else `false`.
- `nodeCountByType` maps a type name to how many nodes have that type, so
  `nodeCountByType.get('object')` is 2 in the fixture.
- Every edge's `to_node` must satisfy `to_node % nodeFieldCount === 0` and
  `to_node / nodeFieldCount < nodeCount`.
  Otherwise refuse with `edge <i> points at to_node <v>, past the end of <n> nodes`.
- `retainedByConstructor`: group `object` and `closure` nodes by `name`,
  summing `selfSize` and counting nodes; sort by `selfSize` desc, then `name`
  asc; keep the top 20.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit packages/core/test/jsheap-snapshot.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jsheap/snapshot.ts packages/core/test/jsheap-snapshot.test.ts
git commit -m "feat(jsheap): index nodes and edges, refusing a snapshot that points past its own arrays"
```

---

### Task 4: The analyzer

**Files:**
- Create: `packages/core/src/analyze/jsheap.ts`
- Modify: `packages/core/src/analyze/types.ts` (`jsheap?: string`)
- Modify: `packages/core/src/analyze/engine.ts`
- Modify: `packages/core/src/report/evidence.ts` (`js_heap` kind)
- Test: `packages/core/test/analyze-jsheap.test.ts`

**Interfaces:**
- Consumes: `parseHeapSnapshot`, `HeapSnapshot` from Task 3.
- Produces: `export class JsheapAnalyzer implements Analyzer { readonly id = 'jsheap'; readonly requires = []; }`
  emitting metric ids `jsheap.total.bytes`, `jsheap.nodes.count`,
  `jsheap.detached.count`, `jsheap.objects.count`, and evidence kind `js_heap`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/analyze-jsheap.test.ts` with the `context()` helper
copied from `analyze-coverage.test.ts` (same shape, `jsheap` override), and:

```ts
it('reports total heap, node count, detached count and object count', async () => {
  const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
  const byId = new Map(result.metrics.map((m) => [m.id, m.value]));
  expect(byId.get('jsheap.total.bytes')).toBe(96);
  expect(byId.get('jsheap.nodes.count')).toBe(3);
  expect(byId.get('jsheap.detached.count')).toBe(1);
  expect(byId.get('jsheap.objects.count')).toBe(2);
});

it('marks every metric exact and names the snapshot file', async () => {
  const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
  for (const m of result.metrics) {
    expect(m.fidelity).toBe('exact');
    expect(m.provenance.collector).toBe('scene:jsheap.heapsnapshot');
  }
});

it('names the largest constructor rather than listing every one', async () => {
  const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
  const item = result.evidence.find((e) => e.kind === 'js_heap');
  expect(item?.explain).toContain('A');
  expect(item?.signals).toMatchObject({ constructor: 'A', selfSize: 64 });
});

it('warns when the snapshot holds detached nodes', async () => {
  const result = await new JsheapAnalyzer().run(context({ jsheap: heap() }));
  const item = result.evidence.find((e) => e.kind === 'js_heap');
  expect(item?.severity).toBe('warn');
});

it('degrades with a reason when the scene carries no snapshot', async () => {
  const result = await new JsheapAnalyzer().run(context());
  expect(result.metrics).toEqual([]);
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]!.kind).toBe('no_data');
  expect(result.evidence[0]!.explain).toMatch(/jsheap\.heapsnapshot/);
});

it('is registered with the default analyzers', () => {
  expect(defaultAnalyzers().map((a) => a.constructor.name)).toContain('JsheapAnalyzer');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit packages/core/test/analyze-jsheap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the analyzer**

Follow `analyze/coverage.ts`: `no_data` with a reason naming
`collect`, `--jsheap` and the debug-signed requirement; otherwise parse, emit
four metrics with `fidelity: 'exact'` and
`provenance: { collector: 'scene:jsheap.heapsnapshot', table: 'js_heap_nodes', rows: snapshot.nodes.length, device: ctx.deviceId }`,
and one `js_heap` evidence item for the largest constructor (`severity: 'warn'`
when `detachedCount > 0`, else `'info'`).

Add `js_heap` to `EvidenceKind`, `jsheap?: string` to `AnalyzeContext` with a
doc comment explaining that it is a supplied artifact (as `coverage` is), and
register `new JsheapAnalyzer()` in `defaultAnalyzers()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit packages/core/test/analyze-jsheap.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyze/jsheap.ts packages/core/src/analyze/types.ts packages/core/src/analyze/engine.ts packages/core/src/report/evidence.ts packages/core/test/analyze-jsheap.test.ts
git commit -m "feat(analyze): report a scene's JS heap from its snapshot"
```

---

### Task 5: Wire the scene into the CLI

**Files:**
- Modify: `packages/cli/src/deps.ts` (read the artifact, add to context)
- Modify: `packages/core/src/index.ts` (exports)
- Modify: `packages/core/test/types.test.ts` (`VALUE_EXPORTS`)
- Modify: `packages/cli/test/doc-analyzers.test.ts` (`TOKENS`)
- Test: `packages/cli/test/deps.test.ts`

**Interfaces:**
- Consumes: `JsheapAnalyzer`, `parseHeapSnapshot`.
- Produces: `analyze` reads `jsheap.heapsnapshot` when `scene.json` declares
  the `jsheap` collector.

- [ ] **Step 1: Write the failing test**

In `packages/cli/test/deps.test.ts`, beside the existing coverage case:

```ts
it('analyzes a scene\'s heap snapshot, and only when the capture declared one', async () => {
  // A `jsheap.heapsnapshot` left by an earlier capture must not be reported
  // as this scene's heap: the descriptor is the authority on what ran.
  const withSnapshot = await analyzeScene({ jsheap: true, snapshot: heap() });
  const ids = withSnapshot.metrics.map((m) => m.id);
  expect(ids).toContain('jsheap.total.bytes');

  const undeclared = await analyzeScene({ jsheap: false, snapshot: heap() });
  expect(undeclared.metrics.map((m) => m.id)).not.toContain('jsheap.total.bytes');
  expect(undeclared.evidence.some((e) => e.kind === 'no_data' && /jsheap/.test(e.explain))).toBe(true);
});
```

Build `analyzeScene` from the file's existing scene fixture helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit packages/cli/test/deps.test.ts -t 'heap snapshot'`
Expected: FAIL — `jsheap.total.bytes` is absent.

- [ ] **Step 3: Wire it**

In `deps.ts`, beside `coverage`:

```ts
// Same rule as coverageReport.json: a snapshot is not a database table, so
// it is read when the descriptor says the capture produced one. A file an
// earlier capture left behind is ignored rather than reported as this
// scene's heap.
const jsheap = declared('jsheap') && existsSync(layout.jsheapFile)
  ? readFileSync(layout.jsheapFile, 'utf8')
  : undefined;
```

Add it to `OpenedScene`, to `analyzeContext`'s spread list, and to the
returned object. Then export `JsheapAnalyzer`, `parseHeapSnapshot` and the
types from `index.ts`, and add both value names to `VALUE_EXPORTS` and
`jsheap: { phrase: 'JS heap snapshot', prefix: 'jsheap.*' }` to `TOKENS`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build -w packages/cli && npx vitest run --project unit packages/cli/test/deps.test.ts -t 'heap snapshot'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deps.ts packages/core/src/index.ts packages/core/test/types.test.ts packages/cli/test/doc-analyzers.test.ts packages/cli/test/deps.test.ts
git commit -m "feat(cli): analyze a scene's heap snapshot when the capture declared one"
```

---

### Task 6: Docs, site, version, release

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `site/index.html`, `packages/core/package.json`, `packages/cli/package.json`

- [ ] **Step 1: Docs**

README: add the analyzer to the prose list and the metric-id table
(`| \`jsheap.*\` | JS heap snapshot | \`jsheap.total.bytes\`, \`jsheap.nodes.count\`, \`jsheap.detached.count\`, \`jsheap.objects.count\` |`),
a paragraph replacing the "`js.heap` stays unavailable" sentence with the new
behaviour (the *device* route stays unavailable for the measured reason; a
supplied snapshot is analyzed), and a P35 roadmap row. CHANGELOG `0.30.0`.
Site: hero P1–P35, test count, a `v0.30.0` roadmap card in EN and ZH.

- [ ] **Step 2: Version and verify**

Bump both `package.json` files to `0.30.0`, move the CLI's core pin, run
`npm run verify`, then the device project.

- [ ] **Step 3: Commit, tag, publish**

Tag `v0.30.0`, push over the SSH workaround, publish both packages, poll the
registry, fresh-install smoke, `gh release create`, confirm CI + Pages, verify
the live site.

---

## Self-Review

- **Spec coverage:** row 20 is capture-only in HapRay; this plan keeps the
  capture (with its `-T` defect fixed) and adds the analysis. Every metric and
  evidence item has a test in Task 4; the artifact wiring has one in Task 5.
- **Deliberate limit:** `retainedByConstructor` sums *self* size by
  constructor, not true retained (dominator-tree) size. A full dominator pass
  is a second algorithm with its own failure modes, and the top-20 self-size
  list answers "which constructor holds the most objects" without it. The
  metric is named `jsheap.objects.count` and the evidence says `selfSize`, so
  no label claims retained size. If true retained size is wanted, that is a
  follow-up item with its own plan.
- **Type consistency:** `HeapSnapshotHeader`, `HeapSnapshot`, `HeapNode` and
  the two function names are used identically in Tasks 2–5. `nodeCountByType`
  is the name the test and the implementation both use.
