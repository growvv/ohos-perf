import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { readNumberArray, readSnapshotHeader } from '../src/jsheap/snapshot';

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
});
