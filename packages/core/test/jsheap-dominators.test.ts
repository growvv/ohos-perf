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
