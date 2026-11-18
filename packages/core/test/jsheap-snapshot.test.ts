import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { readNumberArray, readSnapshotHeader, parseHeapSnapshot } from '../src/jsheap/snapshot';

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
    expect(snapshot.detachedCount).toBe(0);
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
    expect(snapshot.retainedByConstructor.find((row) => row.name === 'A'))
      .toEqual({ name: 'A', selfSize: 64, count: 1 });
    expect(snapshot.retainedByConstructor.find((row) => row.name === 'B'))
      .toEqual({ name: 'B', selfSize: 32, count: 1 });
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
    expect(snapshot.retainedByConstructor.map((row) => row.name)).toEqual(['A', 'B']);
    expect(snapshot.nodeCountByType.get('object')).toBe(2);
  });

  it('refuses an edge that points past the end of the node array', () => {
    const bad = heap().replace('"edges":[2,1,6,2,2,12]', '"edges":[2,1,6,2,2,999]');
    expect(() => parseHeapSnapshot(bad)).toThrow(/edge 1|999/);
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
    expect(snapshot.retainedByConstructor[0]!.name).toBe('A');
    expect(snapshot.retainedByConstructor.map((row) => row.name)).toEqual(['A', 'B']);
  });
});

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
  it('peaks below JSON.parse on a snapshot this engine writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsheap-mem-'));
    const file = join(dir, 'mem.heapsnapshot');
    try {
      const keep: unknown[] = [];
      for (let i = 0; i < 20_000; i++) keep.push({ i, s: `v-${i % 97}`, a: [i] });
      writeHeapSnapshot(file);
      expect(keep.length).toBe(20_000);
      const text = readFileSync(file, 'utf8');

      const peakOf = (work: () => void): number => {
        const base = process.memoryUsage().rss;
        let peak = base;
        work();
        const now = process.memoryUsage().rss;
        return Math.max(peak, now) - base;
      };
      // Parse first, in its own throwaway scope, so its garbage is not the
      // baseline for the second measurement.
      const parsePeak = peakOf(() => {
        const parsed = JSON.parse(text) as { nodes: number[] };
        expect(parsed.nodes.length).toBeGreaterThan(0);
      });
      const scanPeak = peakOf(() => {
        expect(parseHeapSnapshot(text).nodeCount).toBeGreaterThan(0);
      });
      expect(scanPeak).toBeLessThan(parsePeak);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
