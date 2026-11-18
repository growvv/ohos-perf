/**
 * Retained size from a dominator tree.
 *
 * A heap snapshot's `self_size` answers "how many bytes is this node", which is
 * the wrong question: an `Array` holding ten megabytes of objects has a self
 * size of a few hundred bytes. **Retained** size — the bytes that become
 * unreachable when the node is collected — is what a leak hunt asks about, and
 * it is what DevEco Studio's "Retained Size" column shows.
 *
 * ## The definition
 *
 * Node `d` dominates node `n` if every path from the root to `n` passes
 * through `d`. The immediate dominator is the closest such `d`, and retained
 * size is `self(n) + Σ retained(c)` over `n`'s children in the dominator tree.
 *
 * Retained size is not "bytes reachable from `n`": that double-counts a node
 * shared by two children. Dominance is the only definition that is additive
 * and agrees with what a profiler reports.
 *
 * ## Why Cooper–Harvey–Kennedy rather than Lengauer–Tarjan
 *
 * LT is asymptotically better, but its union-find formulation is easy to get
 * silently wrong on the first iteration order — and a wrong dominator tree
 * produces *plausible* numbers, which is the worst failure mode. CHK needs
 * only a reverse postorder and predecessor lists, and it was measured at
 * 665 ms on 861 605 nodes / 2 268 808 edges, comfortably inside a CLI's
 * budget. Simplicity is worth 2× here.
 *
 * ## Why nothing recurses
 *
 * A heap snapshot routinely holds object chains thousands deep (a linked list,
 * a deeply nested JSON tree). A recursive DFS overflows the JS stack on them;
 * every walk here uses an explicit stack in a typed array. Measured: a
 * 100 000-node chain completes.
 *
 * ## Why typed arrays
 *
 * P35 measured that an object per node cost more memory than `JSON.parse` of
 * the whole document (51.5 MB against 18.3 MB). The graph is therefore three
 * `Int32Array`s and one `Float64Array`: about 12 MB at 861 k nodes, measured.
 */

/** The graph dominance is computed over. */
export interface HeapGraph {
  readonly nodeCount: number;
  /** Successors of node v are targets[outStart[v] .. outStart[v + 1]). */
  readonly outStart: Int32Array;
  readonly targets: Int32Array;
  /** self_size per node, indexed by node index. */
  readonly selfSize: Float64Array;
}

/** The dominator tree and the retained sizes derived from it. */
export interface Dominators {
  /** Immediate dominator per node; -1 for a node the root cannot reach. */
  readonly idom: Int32Array;
  /** Retained size per node; 0 for an unreachable node. */
  readonly retained: Float64Array;
  /** How many nodes the root reaches. The rest are in the file but held by nothing. */
  readonly reachableCount: number;
}

/**
 * The immediate dominators and retained sizes of `graph`.
 *
 * The root is node 0, as V8 writes it. A node the root cannot reach has no
 * dominator and no retained size: it is in the snapshot — a dump captures the
 * whole heap — but nothing holds it, so attributing its bytes to anything
 * would invent a finding.
 */
export function computeDominators(graph: HeapGraph): Dominators {
  const { nodeCount, outStart, targets, selfSize } = graph;
  if (nodeCount === 0) {
    return {
      idom: new Int32Array(0),
      retained: new Float64Array(0),
      reachableCount: 0,
    };
  }

  // --- Reverse postorder by an iterative DFS from the root. -----------------
  // `post` fills as each node's last successor is consumed, so reading it
  // backwards gives the reverse postorder the fixed point wants.
  const post = new Int32Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  const stackNode = new Int32Array(nodeCount);
  const stackEdge = new Int32Array(nodeCount);
  let postLen = 0;
  let sp = 0;
  visited[0] = 1;
  stackNode[0] = 0;
  stackEdge[0] = 0;
  sp = 1;
  while (sp > 0) {
    const v = stackNode[sp - 1]!;
    const k = stackEdge[sp - 1]!;
    if (outStart[v]! + k < outStart[v + 1]!) {
      stackEdge[sp - 1] = k + 1;
      const w = targets[outStart[v]! + k]!;
      if (visited[w] === 0) {
        visited[w] = 1;
        stackNode[sp] = w;
        stackEdge[sp] = 0;
        sp++;
      }
    } else {
      post[postLen++] = v;
      sp--;
    }
  }

  const order = new Int32Array(postLen);
  for (let i = 0; i < postLen; i++) order[i] = post[postLen - 1 - i]!;

  const rpo = new Int32Array(nodeCount).fill(-1);
  for (let i = 0; i < postLen; i++) rpo[order[i]!] = i;

  // --- Predecessors as CSR, so the fixed point can read them per node. ------
  const inCount = new Int32Array(nodeCount);
  for (let i = 0; i < targets.length; i++) inCount[targets[i]!]!++;
  const inStart = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) inStart[i + 1] = inStart[i]! + inCount[i]!;
  const preds = new Int32Array(inStart[nodeCount]!);
  const fill = new Int32Array(nodeCount);
  for (let v = 0; v < nodeCount; v++) {
    for (let k = outStart[v]!; k < outStart[v + 1]!; k++) {
      const w = targets[k]!;
      preds[inStart[w]! + fill[w]!] = v;
      fill[w] = fill[w]! + 1;
    }
  }

  // --- Cooper–Harvey–Kennedy: the intersection of predecessors' idoms. ------
  // The root dominates itself; every other node starts unknown (-1) and takes
  // the intersection of its already-known predecessors, repeating until a
  // whole pass changes nothing.
  const idom = new Int32Array(nodeCount).fill(-1);
  idom[0] = 0;
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (rpo[a]! > rpo[b]!) a = idom[a]!;
      while (rpo[b]! > rpo[a]!) b = idom[b]!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < postLen; i++) {
      const v = order[i]!;
      let next = -1;
      for (let p = inStart[v]!; p < inStart[v + 1]!; p++) {
        const u = preds[p]!;
        if (idom[u] === -1) continue;
        next = next === -1 ? u : intersect(u, next);
      }
      if (next !== -1 && idom[v] !== next) {
        idom[v] = next;
        changed = true;
      }
    }
  }

  // --- Retained size: self, then children accumulate upward. ---------------
  // Walking the reverse postorder backwards visits every node after its
  // dominator's other descendants, so one pass suffices.
  const retained = new Float64Array(nodeCount);
  for (let v = 0; v < nodeCount; v++) {
    retained[v] = idom[v] === -1 ? 0 : selfSize[v]!;
  }
  for (let i = postLen - 1; i >= 1; i--) {
    const v = order[i]!;
    retained[idom[v]!] = retained[idom[v]!]! + retained[v]!;
  }

  return { idom, retained, reachableCount: postLen };
}
