import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeHeapSnapshot } from 'node:v8';
import { readNumberArray, readSnapshotHeader, parseHeapSnapshot } from '../src/jsheap/snapshot';
import type { ConstructorShare, HeapSnapshot } from '../src/jsheap/snapshot';

/** A minimal but structurally real snapshot, in V8's own shape. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [
          ['hidden', 'array', 'string', 'object'],
          'string', 'number', 'number', 'number', 'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [
          ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
          'string_or_number', 'node',
        ],
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
    const older = document().replace(
      '"node_fields":["type","name","id","self_size","edge_count","detachedness"]',
      '"node_fields":["type","name","id","self_size","edge_count"]',
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
    // The header object is complete, so this reaches the parser: a hand-edited
    // or corrupted header must name itself, not surface a `SyntaxError`.
    expect(() => readSnapshotHeader('{"snapshot":{"meta":,}}')).toThrow(/not valid JSON/);
  });

  it('refuses a truncated header, naming the truncation', () => {
    expect(() => readSnapshotHeader('{"snapshot":{"meta":{"node_fields":['))
      .toThrow(/not terminated/);
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
    const truncated = document().replace(
      '"nodes":[9,1,1,0,1,0,3,2,2,64,0,0]',
      '"nodes":[9,1,1,0,1,0,3,2',
    );
    expect(() => readNumberArray(truncated, 'nodes')).toThrow(/nodes.*truncated|truncated.*nodes/);
  });

  it('refuses a missing key', () => {
    expect(() => readNumberArray('{"snapshot":{}}', 'edges')).toThrow(/no "edges" array/);
  });
});

/**
 * A snapshot this engine wrote, read by the scanner.
 *
 * The fixtures above are hand-built, and a hand-built document can agree with
 * a reader that is wrong about the real format. This one is V8's own output:
 * the field lists, the slot offsets and the `to_node` encoding are whatever
 * the running engine actually writes.
 */
describe('a snapshot written by this engine', () => {
  let dir: string;
  let path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsheap-real-'));
    path = join(dir, 'sample.heapsnapshot');
    // Keep enough alive that the heap is not trivially empty.
    const keep: unknown[] = [];
    for (let i = 0; i < 500; i++) keep.push({ i, s: `value-${i % 50}` });
    writeHeapSnapshot(path);
    expect(keep.length).toBe(500);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the header V8 wrote', () => {
    const header = readSnapshotHeader(readFileSync(path, 'utf8'));
    expect(header.nodeFieldCount).toBeGreaterThanOrEqual(5);
    expect(header.nodeFieldIndex['type']).toBe(0);
    expect(header.nodeFieldIndex['self_size']).toBeGreaterThan(0);
    expect(header.nodeTypeNames).toContain('object');
    expect(header.nodeCount).toBeGreaterThan(0);
  });

  it('scans exactly the slot count the header declares', () => {
    // A scanner that stopped early, or read one value twice, would still pass
    // the hand-built fixtures. This checks the count against the real file.
    const text = readFileSync(path, 'utf8');
    const header = readSnapshotHeader(text);
    expect(readNumberArray(text, 'nodes')).toHaveLength(header.nodeCount * header.nodeFieldCount);
    expect(readNumberArray(text, 'edges')).toHaveLength(header.edgeCount * header.edgeFieldCount);
  });

  it('parses every node and keeps its counts consistent with the header', () => {
    const snapshot = parseHeapSnapshot(readFileSync(path, 'utf8'));
    expect(snapshot.nodeCount).toBe(snapshot.header.nodeCount);
    const byType = [...snapshot.nodeCountByType.values()].reduce((a, b) => a + b, 0);
    expect(byType).toBe(snapshot.header.nodeCount);
    expect(snapshot.totalSelfSize).toBeGreaterThan(0);
    // Not `0`: how many nodes a heap snapshot marks detached is a property of
    // the engine that wrote it, and CI measured 111 on Node 22 where this
    // machine measured 0 on Node 26. The invariant is that the count is a
    // number inside the node count, not that it is zero.
    expect(snapshot.detachedCount).toBeGreaterThanOrEqual(0);
    expect(snapshot.detachedCount).toBeLessThanOrEqual(snapshot.nodeCount);
  });

  it('agrees with a whole-document JSON.parse about the heap total', () => {
    // The scanner exists to avoid `JSON.parse` on a large file, so the one
    // thing it must never do is disagree with it. The reference parse is cheap
    // at this fixture's size; the point is that two independent readings of
    // the same bytes produce the same total and the same type counts.
    const text = readFileSync(path, 'utf8');
    const reference = JSON.parse(text) as {
      snapshot: { meta: { node_fields: string[]; node_types: string[][] }; node_count: number };
      nodes: number[];
    };
    const fields = reference.snapshot.meta.node_fields;
    const typeAt = fields.indexOf('type');
    const sizeAt = fields.indexOf('self_size');
    const width = fields.length;
    let total = 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < reference.snapshot.node_count; i++) {
      const base = i * width;
      total += reference.nodes[base + sizeAt]!;
      const type = reference.snapshot.meta.node_types[0]![reference.nodes[base + typeAt]!]!;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    const snapshot = parseHeapSnapshot(text);
    expect(snapshot.totalSelfSize).toBe(total);
    expect([...snapshot.nodeCountByType.entries()].sort())
      .toEqual([...counts.entries()].sort());
  });
});

describe('parseHeapSnapshot', () => {
  it('keeps no per-node object array', () => {
    const snapshot = parseHeapSnapshot(heap());
    // Aggregates only. A `nodes` array of one object per node is what made the
    // first version peak at 51.5 MB against JSON.parse's 18.3 MB.
    expect('nodes' in snapshot).toBe(false);
    expect(snapshot.nodeCount).toBe(3);
  });

  /** Two objects of 64 and 32 bytes under the root, one detached. */
  function heap(): string {
    return JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
          node_types: [
            ['hidden', 'array', 'string', 'object'],
            'string', 'number', 'number', 'number', 'number',
          ],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
        },
        node_count: 3,
        edge_count: 2,
      },
      // root(hidden, 0 bytes), A(object, 64, detached), B(object, 32)
      nodes: [0, 0, 1, 0, 2, 0, 3, 1, 2, 64, 0, 2, 3, 2, 3, 32, 0, 1],
      // root --property--> A ; root --property--> B. to_node is index * 6.
      edges: [2, 1, 6, 2, 2, 12],
      strings: ['', 'A', 'B'],
    });
  }

  it('counts nodes by type and keeps each constructor self size', () => {
    const snapshot = parseHeapSnapshot(heap());
    expect(snapshot.nodeCount).toBe(3);
    expect(snapshot.nodeCountByType.get('object')).toBe(2);
    const measured = measuredRows(snapshot);
    expect(measured.find((row) => row.name === 'A'))
      .toEqual({ name: 'A', selfSize: 64, retainedSize: 64, count: 1 });
    expect(measured.find((row) => row.name === 'B'))
      .toEqual({ name: 'B', selfSize: 32, retainedSize: 32, count: 1 });
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
    expect(measuredRows(snapshot).map((row) => row.name)).toEqual(['A', 'B']);
    expect(snapshot.nodeCountByType.get('object')).toBe(2);
  });

  it('refuses an edge that points past the end of the node array', () => {
    const bad = heap().replace('"edges":[2,1,6,2,2,12]', '"edges":[2,1,6,2,2,999]');
    expect(() => parseHeapSnapshot(bad)).toThrow(/edge 1|999/);
  });

  it('refuses an edge with a negative to_node', () => {
    // -6 divides evenly by the node field count (-6 % 6 is -0) and -1 is below
    // nodeCount, so the range check alone lets it through; the target would be
    // node -1, silently dropped from reachability.
    for (const corrupt of [-6, -12]) {
      const bad = heap().replace('"edges":[2,1,6,2,2,12]', `"edges":[2,1,6,2,2,${corrupt}]`);
      expect(() => parseHeapSnapshot(bad)).toThrow(/edge 1|negative|to_node/);
    }
  });

  it('refuses a node whose edge count is negative', () => {
    // The CSR prefix sum walks backwards and the edge writes land before the
    // start of `targets`, where they are silently dropped — every node below
    // the corrupt one becomes unreachable instead of the file being refused.
    const bad = heap().replace(
      '"nodes":[0,0,1,0,2,0,',
      '"nodes":[0,0,1,0,-1,0,',
    );
    expect(() => parseHeapSnapshot(bad)).toThrow(/edge_count|edge count|-1/);
  });

  it('refuses per-node edge counts that do not add up to edge_count', () => {
    // Either direction corrupts the graph without moving any array length:
    // too few leaves zero-filled `targets` slots pointing at node 0, too many
    // drops the surplus writes.
    const tooMany = heap().replace('"nodes":[0,0,1,0,2,0,', '"nodes":[0,0,1,0,3,0,');
    expect(() => parseHeapSnapshot(tooMany)).toThrow(/edge_count|edge count|3/);
    const tooFew = heap().replace('"nodes":[0,0,1,0,2,0,', '"nodes":[0,0,1,0,1,0,');
    expect(() => parseHeapSnapshot(tooFew)).toThrow(/edge_count|edge count|1/);
  });

  it('refuses a node with a negative self size', () => {
    // A negative size flows straight into the total and the retained ranking,
    // producing a negative "bytes" column instead of a refusal.
    const bad = heap().replace('3,1,2,64,0,2', '3,1,2,-64,0,2');
    expect(() => parseHeapSnapshot(bad)).toThrow(/self_size|self size|-64/);
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
    expect(snapshot.nodeCount).toBe(1);
  });

  it('ranks constructors by self size, ties broken by name', () => {
    const snapshot = parseHeapSnapshot(heap());
    expect(measuredRows(snapshot)[0]!.name).toBe('A');
    expect(measuredRows(snapshot).map((row) => row.name)).toEqual(['A', 'B']);
  });
});

/** The measured constructor rows, asserting the analysis was not omitted. */
function measuredRows(snapshot: HeapSnapshot): readonly ConstructorShare[] {
  expect(snapshot.retained.kind).toBe('measured');
  if (snapshot.retained.kind !== 'measured') throw new Error('unreachable');
  return snapshot.retained.byConstructor;
}

/**
 * The reader's whole reason for existing is memory: a real app's snapshot is
 * tens to hundreds of megabytes, and `JSON.parse` on it allocates an object
 * per number. That claim was written into the module and never measured, and
 * the first implementation was **worse** than `JSON.parse` — it built a
 * `HeapNode` object per node, which is the cost the scan was meant to avoid.
 *
 * These tests pin the property, not the number: the parser must not retain a
 * per-node object graph, and its peak must stay below a full parse of the same
 * file.
 */
describe('the reader is cheaper than a whole-document parse', () => {
  /**
   * The comparison runs in **separate processes**, and both load the module
   * before taking a baseline.
   *
   * An in-process RSS delta is not a measurement: the first parse's garbage is
   * still resident when the second starts, so the second number inherits the
   * first's peak. Measured in one process on CI, that reported the scan at
   * 50.8 MB against a parse at 30.1 MB — the reverse of the truth, because the
   * parse had already happened.
   *
   * The module is imported on both sides, before the baseline: the scanner
   * lives in a 769 KB bundle, and charging that to the scan alone was enough to
   * reverse the comparison on a small fixture.
   */
  it('peaks below JSON.parse on a snapshot this engine writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsheap-mem-'));
    try {
      const file = join(dir, 'mem.heapsnapshot');
      const keep: unknown[] = [];
      for (let i = 0; i < 20_000; i++) keep.push({ i, s: `v-${i % 97}`, a: [i] });
      writeHeapSnapshot(file);
      expect(keep.length).toBe(20_000);

      // A child script that reads the file one way and prints its peak.
      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `
        import { readFileSync } from 'node:fs';
        const [mode, file, moduleUrl] = process.argv.slice(2);
        const { parseHeapSnapshot } = await import(moduleUrl);
        const text = readFileSync(file, 'utf8');
        const base = process.memoryUsage().rss;
        let peak = base;
        const timer = setInterval(() => {
          const rss = process.memoryUsage().rss;
          if (rss > peak) peak = rss;
        }, 1);
        if (mode === 'parse') {
          const parsed = JSON.parse(text);
          if (parsed.nodes.length === 0) throw new Error('empty');
        } else if (mode === 'omit') {
          // The ceiling's whole purpose: past it the reader must cost what the
          // stream costs, not what the graph costs.
          if (parseHeapSnapshot(text, { maxGraphEdges: 0 }).retained.kind !== 'omitted') {
            throw new Error('attribution was not omitted');
          }
        } else if (mode === 'build') {
          // Explicit, not the fallthrough: the build peak has to measure a
          // built graph, or the comparison below silently becomes omit-vs-scan.
          if (parseHeapSnapshot(text).retained.kind !== 'measured') {
            throw new Error('attribution was not measured');
          }
        } else if (parseHeapSnapshot(text).nodeCount === 0) {
          throw new Error('empty');
        }
        peak = Math.max(peak, process.memoryUsage().rss);
        clearInterval(timer);
        console.log(peak - base);
      `);
      const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
      const peakOf = (mode: string): number => {
        const run = spawnSync(process.execPath, [probe, mode, file, moduleUrl], {
          encoding: 'utf8',
        });
        if (run.status !== 0) throw new Error(`${mode} probe failed: ${run.stderr}`);
        return Number(run.stdout.trim());
      };
      expect(peakOf('scan')).toBeLessThan(peakOf('parse'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Retained attribution materializes the graph, which costs memory the
   * streaming parse did not. This pins that the reader still wins on a fixture
   * large enough for the graph to dominate — the size a real app's heap is.
   *
   * Measured when this test was written: at 200 000 objects (a 50 MB snapshot)
   * the reader peaks at 77.4 MB against `JSON.parse`'s 106.7 MB. The margin is
   * ~28%, not the 3× it was before dominators, and that is the honest cost of
   * retained size.
   */
  it('still beats a whole-document parse once the graph is materialized', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsheap-mem-big-'));
    try {
      const file = join(dir, 'mem.heapsnapshot');
      const keep: unknown[] = [];
      for (let i = 0; i < 200_000; i++) keep.push({ i, s: `v-${i % 97}`, a: [i] });
      writeHeapSnapshot(file);
      expect(keep.length).toBe(200_000);

      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `
        import { readFileSync } from 'node:fs';
        const [mode, file, moduleUrl] = process.argv.slice(2);
        const { parseHeapSnapshot } = await import(moduleUrl);
        const text = readFileSync(file, 'utf8');
        const base = process.memoryUsage().rss;
        let peak = base;
        const timer = setInterval(() => {
          const rss = process.memoryUsage().rss;
          if (rss > peak) peak = rss;
        }, 1);
        if (mode === 'parse') {
          const parsed = JSON.parse(text);
          if (parsed.nodes.length === 0) throw new Error('empty');
        } else if (mode === 'omit') {
          // The ceiling's whole purpose: past it the reader must cost what the
          // stream costs, not what the graph costs.
          if (parseHeapSnapshot(text, { maxGraphEdges: 0 }).retained.kind !== 'omitted') {
            throw new Error('attribution was not omitted');
          }
        } else if (mode === 'build') {
          // Explicit, not the fallthrough: the build peak has to measure a
          // built graph, or the comparison below silently becomes omit-vs-scan.
          if (parseHeapSnapshot(text).retained.kind !== 'measured') {
            throw new Error('attribution was not measured');
          }
        } else if (parseHeapSnapshot(text).nodeCount === 0) {
          throw new Error('empty');
        }
        peak = Math.max(peak, process.memoryUsage().rss);
        clearInterval(timer);
        console.log(peak - base);
      `);
      const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
      const peakOf = (mode: string): number => {
        const run = spawnSync(process.execPath, [probe, mode, file, moduleUrl], {
          encoding: 'utf8',
        });
        if (run.status !== 0) throw new Error(`${mode} probe failed: ${run.stderr}`);
        return Number(run.stdout.trim());
      };
      expect(peakOf('scan')).toBeLessThan(peakOf('parse'));
      // The ceiling must buy back what the graph costs. Measured on this
      // fixture: omit 22.2 MB against build 77.5 MB, a ratio of 0.29. The
      // defect this pins is real and was reproduced: the ceiling was checked
      // after the per-node arrays were allocated, so the omitted path paid
      // 35.9 MB for arrays it never read — a ratio of 0.46. Comparing omit to
      // *build* rather than to scan is what makes the test discriminate.
      expect(peakOf('omit')).toBeLessThan(peakOf('build') * 0.4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * `root -> Array(self 8) -> 10 x Item(self 100 each)`, plus an optional
 * orphan object nobody points at.
 *
 * Retained size answers a different question from self size: the Array's own
 * bytes are 8, so a self-size ranking puts `Item` (1000) far ahead, while what
 * the Array *holds* is 1008 bytes — which is what a leak hunt asks about. Self
 * 8 rather than 0 is deliberate: at 0 the Array's retained size would tie
 * `Item`'s and the ranking test could pass on the alphabetical tiebreak
 * instead of on the property it claims to test.
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

  it('does not let a weak edge retain its target', () => {
    // A `weak` edge is not a reference: the collector may drop the target
    // whatever the source does. Treating it as strong makes a Map that merely
    // mentions a payload look like the payload's owner, and inflates every
    // row above it. `shortcut` is different — DevTools keeps it — so it is
    // pinned as still-strong in the next test.
    const doc = (edgeType: number): string =>
      JSON.stringify({
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
        // root --property--> Map(self 16) --edgeType--> Payload(self 10000)
        nodes: [0, 0, 1, 0, 1, 0, 3, 1, 2, 16, 1, 1, 3, 2, 3, 10000, 0, 1],
        edges: [2, 1, 6, edgeType, 2, 12],
        strings: ['', 'Map', 'Payload'],
      });
    const weak = parseHeapSnapshot(doc(6));
    if (weak.retained.kind !== 'measured') throw new Error('unreachable');
    // The payload is in the file but held by nothing: it keeps its row and its
    // self size, contributes no retained bytes, and is counted unreachable.
    expect(weak.retained.unreachableCount).toBe(1);
    expect(weak.retained.byConstructor.find((row) => row.name === 'Payload'))
      .toEqual({ name: 'Payload', selfSize: 10000, retainedSize: 0, count: 1 });
    // And the Map no longer looks like its owner.
    expect(weak.retained.byConstructor.find((row) => row.name === 'Map'))
      .toEqual({ name: 'Map', selfSize: 16, retainedSize: 16, count: 1 });
    // The heap total still counts it: it is in the file.
    expect(weak.totalSelfSize).toBe(10016);
  });

  it('keeps a shortcut edge as a reference', () => {
    // V8 writes `shortcut` for a property that forwards to another node (a
    // bound function's target, a prototype link). DevTools counts it, so the
    // target stays reachable and the source retains it.
    const doc = JSON.stringify({
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
      nodes: [0, 0, 1, 0, 1, 0, 3, 1, 2, 16, 1, 1, 3, 2, 3, 10000, 0, 1],
      edges: [2, 1, 6, 5, 2, 12],
      strings: ['', 'Map', 'Payload'],
    });
    const s = parseHeapSnapshot(doc);
    if (s.retained.kind !== 'measured') throw new Error('unreachable');
    expect(s.retained.unreachableCount).toBe(0);
    expect(s.retained.byConstructor.find((row) => row.name === 'Payload')?.retainedSize)
      .toBe(10000);
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

  it('omits attribution, naming the size, when the graph is past the ceiling', () => {
    // The fixture has 11 edges and a 5-edge ceiling, so the graph is refused.
    // The cheap aggregates are still exact — the heap was read, only the
    // attribution is omitted.
    const snapshot = parseHeapSnapshot(container(), { maxGraphEdges: 5 });
    expect(snapshot.retained.kind).toBe('omitted');
    if (snapshot.retained.kind !== 'omitted') throw new Error('unreachable');
    expect(snapshot.retained.reason).toMatch(/11 edges/);
    expect(snapshot.retained.reason).toMatch(/5-edge/);
    // Both counts, so a reader can tell how far past the ceiling the file is
    // without opening it: 12 nodes and 11 edges, refused at 5.
    expect(snapshot.retained.reason).toMatch(/12 nodes/);
    expect(snapshot.totalSelfSize).toBe(1008);
    expect(snapshot.nodeCount).toBe(12);
  });

  it('refuses a ceiling that is not a non-negative integer', () => {
    // A typo in the option would otherwise be echoed into the omission reason
    // as "past the NaN-edge ceiling", which reads like a measurement.
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => parseHeapSnapshot(container(), { maxGraphEdges: bad }))
        .toThrow(/maxGraphEdges/);
      expect(() => parseHeapSnapshot(container(), { maxGraphNodes: bad }))
        .toThrow(/maxGraphNodes/);
    }
  });

  it('bounds the node count too, not only the edge count', () => {
    // A snapshot of many zero-edge nodes has no edges to trip the edge
    // ceiling, but the dominator working set is ~53 bytes a node: a file
    // declaring 50 million of them would allocate gigabytes with the guard
    // reporting itself satisfied. The ceiling is a memory bound, so it bounds
    // both dimensions.
    const snapshot = parseHeapSnapshot(container(), { maxGraphNodes: 5 });
    expect(snapshot.retained.kind).toBe('omitted');
    if (snapshot.retained.kind !== 'omitted') throw new Error('unreachable');
    expect(snapshot.retained.reason).toMatch(/12 nodes/);
    expect(snapshot.retained.reason).toMatch(/5-node ceiling/);
    // The cheap aggregates are still exact.
    expect(snapshot.totalSelfSize).toBe(1008);
    expect(snapshot.nodeCount).toBe(12);
  });

  it('still refuses a corrupt edge when attribution is omitted', () => {
    // The ceiling skips the *graph*, not the validation: a snapshot whose
    // to_node points past the node array is corrupt whatever the ceiling is,
    // and reporting it as a readable heap would hide the corruption.
    const corrupt = container().replace('"edges":[2,1,6', '"edges":[2,1,999');
    expect(() => parseHeapSnapshot(corrupt, { maxGraphEdges: 1 }))
      .toThrow(/to_node 999/);
  });
});

/**
 * Top-level keys are found by depth, not by the first occurrence of their
 * quoted name.
 *
 * A `.heapsnapshot`'s string table holds arbitrary app strings, and one of
 * them can be `nodes` or `edges` — the very names this reader looks up. The
 * first version used `text.indexOf('"nodes"')`, so a table entry with that
 * name, emitted before the array, made the reader parse the wrong span and
 * refuse a legitimate file. V8 happens to write `strings` last, which is why
 * every real snapshot passed; a reordered or hand-built one did not.
 */
describe('a key name inside the string table', () => {
  /** `strings` first, and its second entry is the literal `nodes`. */
  const text = [
    '{"strings":["","nodes"],',
    '"snapshot":{"meta":{',
    '"node_fields":["type","name","id","self_size","edge_count"],',
    '"node_types":[["hidden","object"],"string","number","number","number"],',
    '"edge_fields":["type","name_or_index","to_node"],',
    '"edge_types":[["property"],"string_or_number","node"]},',
    '"node_count":1,"edge_count":0},',
    '"nodes":[1,1,1,16,0],"edges":[]}',
  ].join('');

  it('does not mistake the table entry for the array', () => {
    const snapshot = parseHeapSnapshot(text);
    expect(snapshot.nodeCount).toBe(1);
    expect(snapshot.totalSelfSize).toBe(16);
  });
});
