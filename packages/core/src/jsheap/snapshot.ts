/**
 * A JS heap snapshot reader (HapRay parity row 20, extended).
 *
 * A `.heapsnapshot` is a JSON document V8 writes: a small `snapshot` header
 * describing the layout, then two flat number arrays (`nodes`, `edges`) and a
 * `strings` table that the numbers index into. HapRay captures the file and
 * stops; this reader is what makes the capture a measurement.
 *
 * ## Why it does not `JSON.parse` the document
 *
 * Measured on this machine: a 5.5 MB snapshot parses into 17.6 MB of objects.
 * A real HarmonyOS app's snapshot is tens to hundreds of megabytes, so the
 * whole-document parse is the difference between a measurement and an
 * out-of-memory crash. The header is parsed (it is small and bounded), and the
 * number arrays are scanned digit by digit into a `Float64Array`, which is 8
 * bytes a slot instead of a boxed number plus array overhead.
 *
 * ## What is validated, and why it matters
 *
 * The layout is read from `snapshot.meta`, never assumed: V8's field list has
 * changed (`detachedness` was added, and an older snapshot has no such field),
 * so an offset written into this file would silently read the wrong column on
 * another V8. A field list missing something this reader needs is a refusal
 * naming the field — the alternative is a heap report built from misread
 * numbers.
 *
 * Every error carries `JSHEAP_BAD_SNAPSHOT` and names the value that failed,
 * because a snapshot is a file from outside this package: it can be truncated
 * by a killed dump, hand-edited, or produced by a different engine version.
 */

import { OhosPerfError } from '../errors';

/** The layout and counts a snapshot declares about itself. */
export interface HeapSnapshotHeader {
  /** How many numbers one node occupies in `nodes`. */
  readonly nodeFieldCount: number;
  /** How many numbers one edge occupies in `edges`. */
  readonly edgeFieldCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** The type names `nodes[i * nodeFieldCount + typeIndex]` indexes into. */
  readonly nodeTypeNames: readonly string[];
  /** The type names an edge's `type` field indexes into. */
  readonly edgeTypeNames: readonly string[];
  /** Field name -> its offset within one node record. */
  readonly nodeFieldIndex: Readonly<Record<string, number>>;
  /** Field name -> its offset within one edge record. */
  readonly edgeFieldIndex: Readonly<Record<string, number>>;
}

/** One node, resolved out of the flat arrays. */
export interface HeapNode {
  /** Its index in the snapshot (not its `id`). */
  readonly index: number;
  readonly type: string;
  readonly name: string;
  readonly selfSize: number;
  readonly edgeCount: number;
  readonly detached: boolean;
}

/** One constructor's share of the heap, by self size. */
export interface ConstructorShare {
  readonly name: string;
  /** Sum of the `self_size` of every node of this name. */
  readonly selfSize: number;
  /** How many nodes carry this name. */
  readonly count: number;
}

/** A parsed snapshot: the nodes, and the aggregates a report needs. */
export interface HeapSnapshot {
  readonly header: HeapSnapshotHeader;
  readonly nodes: readonly HeapNode[];
  /** How many nodes of each type. */
  readonly nodeCountByType: ReadonlyMap<string, number>;
  /** Sum of every node's `self_size`. */
  readonly totalSelfSize: number;
  /** How many nodes carry `detachedness === 2`. 0 when the field is absent. */
  readonly detachedCount: number;
  /**
   * `object` and `closure` nodes grouped by name, largest first.
   *
   * This is **self** size, not retained size: a dominator-tree pass is a
   * second algorithm with its own failure modes, and the top-N self-size list
   * answers "which constructor holds the most bytes of its own" without one.
   * Every consumer names it `selfSize` so no label claims retained size.
   */
  readonly retainedByConstructor: readonly ConstructorShare[];
}

/** The fields this reader needs; a snapshot without one is refused. */
const REQUIRED_NODE_FIELDS = ['type', 'name', 'self_size', 'edge_count'] as const;
const REQUIRED_EDGE_FIELDS = ['type', 'name_or_index', 'to_node'] as const;

/** How many constructors the top list keeps. */
const TOP_CONSTRUCTORS = 20;

function bad(message: string): OhosPerfError {
  return new OhosPerfError(message, { code: 'JSHEAP_BAD_SNAPSHOT' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The end index (exclusive) of the JSON value starting at `start`.
 *
 * Braces and brackets are counted, and string literals are skipped, so a
 * `}` inside a node name does not end the object early. That is not
 * hypothetical: snapshot names are arbitrary app strings.
 */
function endOfValue(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The `snapshot` block, parsed.
 *
 * Only this slice goes through `JSON.parse`: it is the layout and the counts,
 * a few hundred bytes, while `nodes` and `edges` are what make the document
 * large.
 */
function snapshotBlock(text: string): Record<string, unknown> {
  const key = text.indexOf('"snapshot"');
  if (key === -1) throw bad('no "snapshot" block in the document');
  const open = text.indexOf('{', key);
  if (open === -1) throw bad('the "snapshot" key is not followed by an object');
  const end = endOfValue(text, open);
  if (end === -1) throw bad('the "snapshot" block is not terminated');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, end));
  } catch (err) {
    throw new OhosPerfError(
      `the snapshot header is not valid JSON: ${(err as Error).message}`,
      { code: 'JSHEAP_BAD_SNAPSHOT', cause: err },
    );
  }
  if (!isRecord(parsed)) throw bad('the "snapshot" block is not an object');
  return parsed;
}

/** A string array from the header, refused by name when it is not one. */
function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw bad(`the snapshot's ${where} is not an array of strings`);
  }
  return value as string[];
}

/** A non-negative integer count from the header. */
function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw bad(`the snapshot's ${where} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Field name -> offset, refusing a missing required field by name. */
function fieldIndex(
  fields: readonly string[],
  required: readonly string[],
  where: string,
): Record<string, number> {
  const index: Record<string, number> = {};
  fields.forEach((name, offset) => {
    index[name] = offset;
  });
  for (const name of required) {
    if (index[name] === undefined) {
      throw bad(`the snapshot's ${where} have no ${JSON.stringify(name)}`);
    }
  }
  return index;
}

/**
 * Read the header: the layout, the counts, and the type tables.
 *
 * `detachedness` is deliberately not required: it was added to V8's node
 * fields later, and a snapshot from before it has no such column. Requiring it
 * would refuse a perfectly analyzable heap.
 */
export function readSnapshotHeader(text: string): HeapSnapshotHeader {
  const block = snapshotBlock(text);
  const meta = block['meta'];
  if (!isRecord(meta)) throw bad('the snapshot has no "meta" object');

  const nodeFields = stringList(meta['node_fields'], 'node_fields');
  const edgeFields = stringList(meta['edge_fields'], 'edge_fields');
  const nodeTypes = meta['node_types'];
  const edgeTypes = meta['edge_types'];
  if (!Array.isArray(nodeTypes) || !Array.isArray(nodeTypes[0])) {
    throw bad('the snapshot\'s node_types has no type-name list');
  }
  if (!Array.isArray(edgeTypes) || !Array.isArray(edgeTypes[0])) {
    throw bad('the snapshot\'s edge_types has no type-name list');
  }

  return {
    nodeFieldCount: nodeFields.length,
    edgeFieldCount: edgeFields.length,
    nodeCount: count(block['node_count'], 'node_count'),
    edgeCount: count(block['edge_count'], 'edge_count'),
    nodeTypeNames: stringList(nodeTypes[0], 'node_types[0]'),
    edgeTypeNames: stringList(edgeTypes[0], 'edge_types[0]'),
    nodeFieldIndex: fieldIndex(nodeFields, REQUIRED_NODE_FIELDS, 'node_fields'),
    edgeFieldIndex: fieldIndex(edgeFields, REQUIRED_EDGE_FIELDS, 'edge_fields'),
  };
}

/** Characters a JSON number may contain. */
function isNumberChar(char: string): boolean {
  return (char >= '0' && char <= '9') || char === '-' || char === '+' ||
    char === '.' || char === 'e' || char === 'E';
}

/**
 * The numbers in a top-level flat array, scanned rather than parsed.
 *
 * `Float64Array` because snapshot numbers are integers well inside its exact
 * range (node ids, sizes, slot offsets) and it stores them unboxed — the point
 * of not calling `JSON.parse` on a document with hundreds of thousands of
 * them. The buffer doubles on overflow.
 */
export function readNumberArray(text: string, key: string): Float64Array {
  const label = `"${key}"`;
  const at = text.indexOf(label);
  if (at === -1) throw bad(`no ${label} array in the document`);
  const open = text.indexOf('[', at + label.length);
  if (open === -1) throw bad(`the ${label} key is not followed by an array`);

  let buffer = new Float64Array(1024);
  let length = 0;
  let i = open + 1;
  for (;;) {
    const char = text[i];
    if (char === undefined) {
      throw bad(`the ${label} array is truncated at offset ${i} (no closing bracket)`);
    }
    if (char === ']') return buffer.subarray(0, length);
    if (char === ',' || char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      i++;
      continue;
    }
    if (!isNumberChar(char)) {
      throw bad(`the ${label} array is truncated or not a number array at offset ${i}`);
    }
    let end = i;
    while (end < text.length && isNumberChar(text[end]!)) end++;
    const raw = text.slice(i, end);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw bad(`the ${label} array holds ${JSON.stringify(raw)} at offset ${i}, which is not a number`);
    }
    if (length === buffer.length) {
      const grown = new Float64Array(buffer.length * 2);
      grown.set(buffer);
      buffer = grown;
    }
    buffer[length++] = value;
    i = end;
  }
}
