# P36 — Retained size via a dominator tree

**Status:** approved for implementation (selected by the user from the P35 follow-on)
**Release:** `0.31.0`
**Builds on:** P35 JS heap snapshot analysis (`0.30.1`)
**Parity rows:** none — all 38 inventory rows are ported; only row 37 (`build`, a
`deveco-cli` wrapper) is deliberately out. This is **beyond the inventory**.

## Why this phase

P35 shipped `retainedByConstructor` and named every field `selfSize`, because a
dominator pass is a second algorithm with its own failure modes. That deferral
is now the largest gap in the JS heap analysis: self size answers "which
constructor holds the most bytes of its own", which is not the question a heap
snapshot exists to answer. **Retained** size — the bytes a node would free if
it were collected — is.

The difference is not marginal. Measured on a real 9.4 MB snapshot this engine
wrote (`writeHeapSnapshot`, 141 605 nodes):

| constructor | self size | retained size |
|---|---|---|
| `Array` | 0.62 MB | **3.78 MB** |
| `Object` | 0.96 MB | **3.14 MB** |
| `system / Context` | 0.07 MB | **0.49 MB** |
| `NodeError` | 0.04 MB | **0.35 MB** |
| `Map` | — (not in top 6) | **0.15 MB** |

Ranked by self size, `Object` leads. Ranked by retained size, `Array` leads and
holds **six times** the bytes its own nodes account for, because it holds its
elements. A reader who acts on the current metric optimizes the wrong
constructor. `system / Context` is seven times its self size; `Map` does not
appear in the self-size top six at all.

HapRay never reads the snapshot, so every part of this is beyond the inventory.

## What a dominator tree is, and why it is the right answer

Node *d* dominates node *n* if every path from the root to *n* passes through
*d*. The **immediate dominator** is the closest such *d*. Retained size is then
`self(n) + Σ retained(c)` over the children *c* of *n* in the dominator tree:
the bytes that become unreachable when *n* is collected.

This is exactly "what holds the memory", and it is what DevEco Studio's
"Retained Size" column shows. It is also the only way to attribute a
container's contents to the container rather than to the leaves.

## Scope

**In scope**

- **`packages/core/src/jsheap/dominators.ts`** — the graph and the algorithm,
  over typed arrays only:
  - Build a CSR graph from the streamed `nodes`/`edges` arrays: `outStart`
    (`Int32Array`, node count + 1), `targets` (`Int32Array`, edge count),
    `inStart`/`preds` for the reverse edges the algorithm needs.
  - Iterative DFS for a postorder (no recursion — a deep object chain would
    overflow the JS stack), then reverse postorder numbering.
  - Iterative Cooper–Harvey–Kennedy for the immediate dominator: process nodes
    in RPO, intersect predecessors' idoms until a fixed point.
  - Retained size by accumulating in reverse RPO.
  - Root is node 0, as V8 writes it. Nodes the root cannot reach are counted
    and excluded from the retained total — they are not "held" by anything.
- **`HeapSnapshot` gains retained attribution.** `ConstructorShare` grows a
  `retainedSize: number` beside the existing `selfSize`; `retainedByConstructor`
  is **ranked by retained size**, and every row keeps both numbers so a
  consumer can see the difference. `selfSize` is not removed — both are true
  and a reader needs both to see which containers amplify.
- **Two new `exact` metrics:**
  - `jsheap.retained.largest.bytes` — the largest single constructor's retained
    size (the actionable number).
  - `jsheap.unreachable.count` — nodes the root cannot reach. This is a
    *measured* account of the detached subtrees that P35 approximated with the
    `detachedness` column; the two are reported separately because they answer
    different questions and can legitimately disagree.
- **The `js_heap` evidence item** names the largest constructor **by retained
  size**, carries `retainedSize` and `selfSize` in its signals, and its
  `explain` says "retained" so no reader assumes self size.
- **A graph-size guard.** A snapshot whose graph cannot be built within a
  documented budget is a named `no_data` (`jsheap:graph-too-large`), not an
  OOM. The budget is derived from measured cost, not guessed.

**Out of scope**

- A two-snapshot diff ("what grew between A and B"). It is the natural next
  phase and needs retained attribution to be meaningful, but it is a separate
  release with its own comparison model.
- Dominator *paths* ("what holds this node"): the retained-size tree answers
  the ranking question; a path query is a second presentation layer.
- `locations`, `trace_tree`, `samples`, `trace_function_infos`. They are empty
  in every snapshot measured here (measured: all four length 0 on a real
  engine-written file) and are not needed for retained size.

## Measured facts this phase depends on

Measured 2026-11-19 on this machine, `packages/core/dist/index.js`:

- **Feasibility** (a prototype of exactly this algorithm over `JSON.parse`d
  fixtures, so the numbers include a parse the real implementation will not do):

  | snapshot | nodes | edges | dominator pass | graph memory | root retained |
  |---|---|---|---|---|---|
  | 9.4 MB | 141 605 | 468 808 | 175 ms | 4.9 MB | 8.7 MB |
  | 50.0 MB | 861 605 | 2 268 808 | 665 ms | 12.2 MB | 32.4 MB |

- The algorithm converges in **~70 rounds** on both fixtures (69 and 70), so
  the iterative form is not pathological on real heaps.
- The graph in typed arrays costs ~12 MB of adjacency at 861 k nodes / 2.27 M
  edges — **but the adjacency is not the whole cost.** Measured end to end
  after implementation, peak RSS on the 50 MB fixture moved 30.1 MB → 77.4 MB,
  because the pass also holds postorder, reverse postorder, two DFS stacks,
  predecessor CSR, idom and retained. The implementation's doc comment carries
  the measured figure; the table above measures the adjacency alone. Still
  below `JSON.parse`'s 106.7 MB, and the edge ceiling exists to bound exactly
  this working set.
- **Correctness pinned on a known graph** before any code: a five-node graph
  with two paths into node 3 (`0→1→3`, `0→2→3`) yields idom `[0,0,0,0,3]` and
  retained `[11111,10,100,11000,10000]`, matching hand-computed answers. A
  wrong dominator tree produces plausible numbers, which is the worst failure
  mode, so this is the first test.
- **Self vs retained divergence** is the motivating measurement above.
- `detachedness` is 0 on Node 26 and 111 on Node 22 for the same fixture (CI
  measured the latter), so `jsheap.detached.count` and
  `jsheap.unreachable.count` are kept as separate metrics and neither is
  asserted to be zero.

## Design decisions

**Why a dominator tree rather than reference counting.** Retained size is not
"bytes reachable from n" — that double-counts shared children. Dominance is
the only definition that is additive and matches what a profiler shows.

**Why CHK rather than Lengauer–Tarjan.** LT is asymptotically better but its
union-find form is subtle and easy to get silently wrong on the first
iteration order. CHK is simpler, needs only RPO + predecessor lists, and
measured 665 ms at 861 k nodes — comfortably inside a CLI's budget. Simplicity
is worth 2× here because a wrong idom is undetectable by inspection.

**Why the graph is materialized when the parse is not.** Dominance is a
whole-graph property: it cannot be computed in one streaming pass. The
compromise is that only the compact graph (three `Int32Array`s) is held, never
objects, and the parse itself stays streaming so the text is the only large
allocation.

**Why `unreachable.count` is separate from `detached.count`.** `detachedness`
is an embedder annotation written at dump time; reachability is a graph fact
computed now. A node can be marked detached but still reachable (a bug in the
app's embedder hooks) or unreachable without the annotation. Reporting one as
the other would hide exactly the discrepancy a leak hunt looks for.

**Why the guard exists.** A 300 MB snapshot can have millions of nodes; the
graph is 12 bytes a node plus 4 a edge in typed arrays. Past a documented
ceiling the honest answer is "too large to attribute, here is the size", not a
process killed mid-analysis with no report.

## Global Constraints

- ESM only; no new runtime dependencies.
- Typed arrays only for the graph: `Int32Array` for indices, `Float64Array` for
  sizes. No per-node objects, ever — that was P35's measured regression.
- No recursion in the graph walk; an object chain thousands deep must not
  overflow the stack.
- Determinism: ties in the constructor ranking break on name; the same
  snapshot produces byte-identical output on every run and every platform.
- Every new error is an `OhosPerfError` naming the value that failed; the
  graph guard is a `no_data` evidence, not an exception.
- `npm run verify` before every commit; `npm run build -w packages/cli` after
  any `packages/cli/src` edit.
- Version `0.31.0` in both packages; the CLI's `@ohos-perf/core` pin moves.
- New value exports go in `VALUE_EXPORTS` in `packages/core/test/types.test.ts`;
  the README metric-id table gains the two new ids.
- Commits end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. **A snapshot whose root does not reach every node** (the common case — V8
   writes nodes the GC has already detached) → unreachable nodes are excluded
   from the retained total and counted separately, never silently attributed
   to the root. A retained total that equals the sum of all self sizes is the
   symptom of getting this wrong.
2. **A node with two paths from the root** → its idom is the common ancestor,
   not the first predecessor found. The known-graph test pins this; the risk is
   a heap where it is rarer and only slightly wrong.
3. **A very deep chain** (100 000 nested objects) → the DFS is iterative, so it
   completes; a recursive implementation throws `RangeError` and would be
   caught only by this test.
4. **A graph past the documented ceiling** → a named `no_data` naming the node
   and edge counts, not an OOM and not a silently truncated tree.
5. **A constructor whose retained size is smaller than its self size** → this
   is impossible for a correct tree (retained ≥ self for every node), so the
   implementation asserts it rather than reporting a negative or contradictory
   share.

## Success criteria

- `jsheap.retained.largest.bytes` and `jsheap.unreachable.count` are `exact`
  metrics with provenance naming the artifact.
- On a fixture where a container holds a large payload, the retained ranking
  puts the container first even though its self size is small — the motivating
  measurement, pinned as a test.
- The known-graph idom and retained values match hand-computed answers.
- The full suite is green and the documented counts move with it.
