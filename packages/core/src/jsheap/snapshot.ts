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
 * Measured on this machine, peak RSS above a baseline taken after the text is
 * read: a 9.4 MB snapshot parses into 19.6 MB with `JSON.parse`, and this
 * reader peaks at 12.7 MB; on a 50 MB snapshot, 106.7 MB against 77.4 MB. A
 * real HarmonyOS app's snapshot is tens to hundreds of megabytes.
 *
 * The header is parsed (it is small and bounded) and the string table is
 * parsed from its own slice. `nodes` and `edges` are **streamed**, never
 * materialized: holding them is 8 bytes a slot, the same order as what
 * `JSON.parse` allocates for them, so a scanner that built both arrays and
 * then aggregated measured *worse* than the parse it exists to replace
 * (29.6 MB against 19.6 MB on the 9.4 MB file). Only aggregates are retained.
 *
 * Retained attribution needs the whole graph — dominance is not a streaming
 * property — so the graph is materialized as typed arrays (see
 * {@link computeDominators}). That is the price of retained size: on the 50 MB
 * fixture the reader peaked at 30.1 MB before it computed dominators and
 * 77.4 MB after, still below `JSON.parse`'s 106.7 MB. On the 9.4 MB fixture
 * the graph fits in the existing headroom and the peak did not move (12.3 MB
 * before, 12.7 MB after).
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
import { computeDominators } from './dominators';

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

/** One constructor's share of the heap, by self and retained size. */
export interface ConstructorShare {
  readonly name: string;
  /** Sum of the `self_size` of every node of this name. */
  readonly selfSize: number;
  /**
   * Sum of the **retained** size of every node of this name.
   *
   * Retained size is what the constructor holds: the bytes that become
   * unreachable when its nodes are collected. It is always at least
   * `selfSize` for a reachable node, and it is what a leak hunt asks about —
   * an `Array` of a few hundred bytes can retain megabytes.
   *
   * A node nested inside another node of the same name contributes to both
   * nodes' retained size, so a row can exceed the heap total. DevTools reports
   * the same figure and has the same property.
   */
  readonly retainedSize: number;
  /** How many nodes carry this name. */
  readonly count: number;
}

/**
 * Retained attribution, or the measured reason it was not produced.
 *
 * A union rather than an empty list: "attribution was skipped because the
 * graph is too large" and "no constructor retained anything" are different
 * facts, and a caller that cannot tell them apart would report a heap with no
 * holder as a healthy one.
 */
export type RetainedAnalysis =
  | {
      readonly kind: 'measured';
      /** `object` and `closure` nodes grouped by name, largest retained first. */
      readonly byConstructor: readonly ConstructorShare[];
      /** Nodes the root cannot reach: in the file, held by nothing. */
      readonly unreachableCount: number;
    }
  | {
      readonly kind: 'omitted';
      /** Why attribution was skipped, naming the size that triggered it. */
      readonly reason: string;
    };

/**
 * A parsed snapshot: the aggregates a report reads.
 *
 * There is deliberately no per-node array. The first version returned one and
 * peaked at 51.5 MB against `JSON.parse`'s 18.3 MB on a 5.5 MB file (measured)
 * — the object-per-node graph was exactly the cost the scan exists to avoid.
 */
export interface HeapSnapshot {
  readonly header: HeapSnapshotHeader;
  /** How many nodes the snapshot holds (its `node_count`, validated). */
  readonly nodeCount: number;
  /** How many nodes of each type. */
  readonly nodeCountByType: ReadonlyMap<string, number>;
  /** Sum of every node's `self_size`. */
  readonly totalSelfSize: number;
  /** How many nodes carry `detachedness === 2`. 0 when the field is absent. */
  readonly detachedCount: number;
  /**
   * What each constructor holds, by retained size — or why that was omitted.
   *
   * Retained size comes from a dominator tree ({@link computeDominators}),
   * which needs the whole graph: dominance is a property no single streaming
   * pass can compute. The graph is compact — three `Int32Array`s and one
   * `Float64Array` — so the parse itself still streams, and the string table
   * is the only other large allocation.
   *
   * `selfSize` stays on each row because the two answer different questions:
   * self size is what a constructor's own nodes cost, retained size is what
   * they hold. A reader needs both to see which containers amplify.
   */
  readonly retained: RetainedAnalysis;
}

/** The fields this reader needs; a snapshot without one is refused. */
const REQUIRED_NODE_FIELDS = ['type', 'name', 'self_size', 'edge_count'] as const;
const REQUIRED_EDGE_FIELDS = ['type', 'name_or_index', 'to_node'] as const;

/** How many constructors the top list keeps. */
const TOP_CONSTRUCTORS = 20;

/**
 * The largest graph this reader will build, in edges.
 *
 * Retained attribution needs the whole graph in memory, and that is the one
 * place this reader is not streaming: 4 bytes an edge for the forward
 * adjacency, 4 for the reverse, plus ~12 bytes a node for the working arrays.
 * At this ceiling that is roughly 160 MB of edges alone, on top of the text
 * and the string table.
 *
 * The number is a budget, not a measurement of what fits: a real HarmonyOS
 * snapshot is tens to hundreds of megabytes, and a 100 MB one holds about
 * 4.5 million edges. Twenty million leaves headroom for a large app while
 * keeping a runaway dump from turning an analysis into an out-of-memory kill
 * with no report.
 */
export const MAX_GRAPH_EDGES = 20_000_000;

/** How `parseHeapSnapshot` may be constrained. */
export interface HeapParseOptions {
  /** Lower (or raise) the edge ceiling; see {@link MAX_GRAPH_EDGES}. */
  readonly maxGraphEdges?: number;
}

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

/** A backslash, by code point, so this file needs no escape gymnastics. */
const BACKSLASH = String.fromCharCode(92);

/** Whitespace JSON permits between tokens. */
function isSpace(char: string): boolean {
  return char === ' ' || char === String.fromCharCode(10) ||
    char === String.fromCharCode(13) || char === String.fromCharCode(9);
}

/**
 * The offset of a **top-level** key, or -1.
 *
 * `text.indexOf('"nodes"')` is not that: a `.heapsnapshot`'s string table
 * holds arbitrary app strings, and one of them can be `nodes` or `edges` — the
 * names this reader looks up. V8 writes `strings` last, so every real snapshot
 * passed, but a reordered or hand-built document had its array read from the
 * wrong span and was refused as truncated.
 *
 * Depth is tracked the same way {@link endOfValue} tracks it, and string
 * literals are skipped, so only a key sitting directly inside the root object
 * matches. A key and a string *value* both sit at depth 1, so a match also has
 * to be followed by a colon.
 */
function topLevelKey(text: string, key: string): number {
  const quoted = `"${key}"`;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === BACKSLASH) i++;
      else if (char === '"') {
        inString = false;
        // A string closing at depth 1 is a key position. A key and a string
        // value both sit at depth 1, and only a key is followed by a colon.
        const start = i - quoted.length + 1;
        if (depth === 1 && start >= 0 && text.startsWith(quoted, start)) {
          let j = i + 1;
          while (j < text.length && isSpace(text[j]!)) j++;
          if (text[j] === ':') return start;
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
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
  const key = topLevelKey(text, 'snapshot');
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

/** How many number tokens an array holds, counted without allocating. */
function countNumbers(text: string, label: string, open: number): number {
  let count = 0;
  let i = open + 1;
  for (;;) {
    const char = text[i];
    if (char === undefined) {
      throw bad(`the ${label} array is truncated at offset ${i} (no closing bracket)`);
    }
    if (char === ']') return count;
    if (char === ',' || isSpace(char)) {
      i++;
      continue;
    }
    if (!isNumberChar(char)) {
      throw bad(`the ${label} array is truncated or not a number array at offset ${i}`);
    }
    count++;
    i++;
    while (i < text.length && isNumberChar(text[i]!)) i++;
  }
}

/** Beyond this an integer accumulator is no longer exact; defer to `Number`. */
const EXACT_INTEGER_LIMIT = 9e15;

/**
 * The number spanning `text[start, end)`, without allocating a string.
 *
 * Snapshot numbers are integers — ids, sizes, slot offsets — and almost all of
 * them fit the fast path. `text.slice` per number is what made the scanner
 * allocate one string per slot (2.2 million on a 9 MB file, measured); a
 * fractional or exponent form, or an integer past 2^53, takes the slow path and
 * is the only case that allocates.
 */
function numberAt(text: string, start: number, end: number): number {
  let i = start;
  let negative = false;
  if (text[i] === '-') {
    negative = true;
    i++;
  }
  let value = 0;
  for (; i < end; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) {
      value = Number(text.slice(start, end));
      return value;
    }
    value = value * 10 + digit;
    if (value > EXACT_INTEGER_LIMIT) {
      value = Number(text.slice(start, end));
      return value;
    }
  }
  return negative ? -value : value;
}

/**
 * A cursor over the numbers in a top-level flat array.
 *
 * Exists so the parser never holds the array: `nodes` and `edges` are read
 * slot by slot, and only the aggregates built from them are retained. Holding
 * both arrays is itself a `JSON.parse`-sized allocation (8 bytes a slot for
 * 1.4 million edge slots, measured), so a scanner that materializes them and
 * then aggregates cannot beat the parse it exists to replace.
 */
class NumberCursor {
  private i: number;

  constructor(
    private readonly text: string,
    /** The quoted key, for error messages. */
    readonly label: string,
    /** The array's opening bracket. */
    readonly start: number,
  ) {
    this.i = start + 1;
  }

  /** The next number, or `undefined` when the array ends. */
  next(): number | undefined {
    const text = this.text;
    for (;;) {
      const char = text[this.i];
      if (char === undefined) {
        throw bad(`the ${this.label} array is truncated at offset ${this.i} (no closing bracket)`);
      }
      if (char === ']') return undefined;
      if (char === ',' || isSpace(char)) {
        this.i++;
        continue;
      }
      if (!isNumberChar(char)) {
        throw bad(`the ${this.label} array is truncated or not a number array at offset ${this.i}`);
      }
      let end = this.i + 1;
      while (end < text.length && isNumberChar(text[end]!)) end++;
      const start = this.i;
      this.i = end;
      const value = numberAt(text, start, end);
      if (!Number.isFinite(value)) {
        throw bad(
          `the ${this.label} array holds ${JSON.stringify(text.slice(start, end))} at offset ${start},` +
          ' which is not a number',
        );
      }
      return value;
    }
  }
}

/** A cursor positioned at a top-level number array, refused when absent. */
function numberCursor(text: string, key: string): NumberCursor {
  const label = `"${key}"`;
  const at = topLevelKey(text, key);
  if (at === -1) throw bad(`no ${label} array in the document`);
  const open = text.indexOf('[', at + label.length);
  if (open === -1) throw bad(`the ${label} key is not followed by an array`);
  return new NumberCursor(text, label, open);
}

/**
 * The numbers in a top-level flat array, scanned rather than parsed.
 *
 * `Float64Array` because snapshot numbers are integers well inside its exact
 * range (node ids, sizes, slot offsets) and it stores them unboxed. Sizing is
 * exact via a counting pass: doubling instead peaked at twice the array's size
 * (old and new buffer both live across a doubling).
 *
 * The parser itself does not call this — it streams through {@link NumberCursor}
 * and keeps only aggregates. This is the API for a caller that wants the
 * numbers themselves.
 */
export function readNumberArray(text: string, key: string): Float64Array {
  const cursor = numberCursor(text, key);
  const values = new Float64Array(countNumbers(text, cursor.label, cursor.start));
  let length = 0;
  for (;;) {
    const value = cursor.next();
    if (value === undefined) return values;
    values[length++] = value;
  }
}

/** A string-table lookup, refused by index when it points outside the table. */
function stringAt(strings: readonly string[], index: number, where: string): string {
  const value = strings[index];
  if (value === undefined) {
    throw bad(`${where} points at strings[${index}], past the end of ${strings.length} strings`);
  }
  return value;
}

/**
 * Parse a snapshot into the aggregates a report reads.
 *
 * The two arrays are **streamed, never materialized**. Holding `nodes` and
 * `edges` as arrays is 8 bytes a slot — the same order as what `JSON.parse`
 * allocates for them — so a scanner that built both and then aggregated
 * measured *worse* than `JSON.parse` on every fixture tried (29.6 MB against
 * 19.6 MB on a 9.4 MB file, 112.8 against 106.6 on a 50 MB one). Only the
 * aggregates and the string table are retained.
 *
 * Each array is read twice: once to count its slots, which validates the
 * length against `node_count * node_field_count` before any aggregate is
 * built, and once to aggregate. A dump killed mid-write leaves a short array,
 * and reporting the nodes that happened to fit would present a partial heap as
 * the whole heap.
 *
 * `to_node` is a **node slot offset**, not an index — V8 writes
 * `node_index * node_field_count`. Reading it as an index is the classic way
 * to mis-attribute every edge; it is validated here so a corrupt value is a
 * refusal rather than a silently wrong aggregate.
 */
export function parseHeapSnapshot(text: string, options?: HeapParseOptions): HeapSnapshot {
  const header = readSnapshotHeader(text);
  const nodeCursor = numberCursor(text, 'nodes');
  const edgeCursor = numberCursor(text, 'edges');

  const expectedNodes = header.nodeCount * header.nodeFieldCount;
  const nodeSlots = countNumbers(text, nodeCursor.label, nodeCursor.start);
  if (nodeSlots !== expectedNodes) {
    throw bad(
      `the "nodes" array holds ${nodeSlots} values; node_count * node_fields is ${expectedNodes}`,
    );
  }
  const expectedEdges = header.edgeCount * header.edgeFieldCount;
  const edgeSlots = countNumbers(text, edgeCursor.label, edgeCursor.start);
  if (edgeSlots !== expectedEdges) {
    throw bad(
      `the "edges" array holds ${edgeSlots} values; edge_count * edge_fields is ${expectedEdges}`,
    );
  }

  const strings = readStringTable(text);
  const typeAt = header.nodeFieldIndex['type']!;
  const nameAt = header.nodeFieldIndex['name']!;
  const selfSizeAt = header.nodeFieldIndex['self_size']!;
  const edgeCountAt = header.nodeFieldIndex['edge_count']!;
  const detachedAt = header.nodeFieldIndex['detachedness'];
  const width = header.nodeFieldCount;

  // One pass, aggregates only. The first version built a `HeapNode` object per
  // node and was *more* expensive than `JSON.parse` on the same file (51.5 MB
  // against 18.3 MB on a 5.5 MB snapshot, measured) — the object graph was
  // exactly the cost the scan exists to avoid. Nothing here is retained per
  // node except the constructor groups, which are bounded by the number of
  // distinct names, not by the number of nodes, and the typed arrays the
  // dominator pass needs.
  const nodeCountByType = new Map<string, number>();
  const byName = new Map<string, { selfSize: number; count: number }>();
  let totalSelfSize = 0;
  let detachedCount = 0;

  // The ceiling is decided here, before any per-node array is allocated: the
  // point of the ceiling is to bound memory, so allocating 14.6 MB of arrays
  // the omitted path never reads would defeat it.
  const edgeLimit = options?.maxGraphEdges ?? MAX_GRAPH_EDGES;
  const buildGraph = header.edgeCount <= edgeLimit;

  // The dominator pass needs per-node facts it cannot re-derive from the
  // aggregates, so they are collected here while the text is already being
  // read. Typed arrays, not objects: see the module doc. Absent when the
  // graph is omitted, so the node loop below skips writing them.
  const selfSizeOf = buildGraph ? new Float64Array(header.nodeCount) : undefined;
  const edgeCountOf = buildGraph ? new Int32Array(header.nodeCount) : undefined;
  const nameOf = buildGraph ? new Int32Array(header.nodeCount) : undefined;
  /** 1 when the node is an `object` or `closure`, the types a row groups. */
  const namedOf = buildGraph ? new Uint8Array(header.nodeCount) : undefined;

  // One record buffer, reused. Allocating it per node was a per-node
  // allocation of the very kind this reader exists to avoid.
  const record = new Float64Array(width);
  let edgeSum = 0;
  for (let index = 0; index < header.nodeCount; index++) {
    for (let slot = 0; slot < width; slot++) record[slot] = nodeCursor.next()!;
    const type = stringAt(header.nodeTypeNames, record[typeAt]!, `node ${index} type`);
    nodeCountByType.set(type, (nodeCountByType.get(type) ?? 0) + 1);
    const selfSize = record[selfSizeAt]!;
    if (!Number.isInteger(selfSize) || selfSize < 0) {
      throw bad(`node ${index} has self_size ${selfSize}, which is not a non-negative integer`);
    }
    totalSelfSize += selfSize;
    const edgeCount = record[edgeCountAt]!;
    // A negative count would walk the CSR prefix sum backwards and write edges
    // before the start of `targets`, where they vanish; a count that does not
    // add up leaves zero-filled targets (every one of them node 0) or drops
    // surplus writes. Both corrupt the graph without changing any array length,
    // so the dominator tree would be plausible and wrong.
    if (!Number.isInteger(edgeCount) || edgeCount < 0) {
      throw bad(`node ${index} has edge_count ${edgeCount}, which is not a non-negative integer`);
    }
    edgeSum += edgeCount;
    if (selfSizeOf !== undefined) {
      selfSizeOf[index] = selfSize;
      edgeCountOf![index] = edgeCount;
      nameOf![index] = record[nameAt]!;
    }
    if (detachedAt !== undefined && record[detachedAt] === 2) detachedCount += 1;
    if (type === 'object' || type === 'closure') {
      if (namedOf !== undefined) namedOf[index] = 1;
      const name = stringAt(strings, record[nameAt]!, `node ${index} name`);
      const entry = byName.get(name);
      if (entry === undefined) byName.set(name, { selfSize, count: 1 });
      else {
        entry.selfSize += selfSize;
        entry.count += 1;
      }
    }
  }
  if (edgeSum !== header.edgeCount) {
    throw bad(
      `the per-node edge counts sum to ${edgeSum}; edge_count is ${header.edgeCount}`,
    );
  }

  // The forward adjacency, in the same CSR layout `computeDominators` reads.
  // Past the ceiling it is not built at all: the edges are still validated —
  // a corrupt one must still be a refusal — but nothing is retained for them.
  const outStart = new Int32Array(buildGraph ? header.nodeCount + 1 : 0);
  const targets = buildGraph ? new Int32Array(header.edgeCount) : undefined;
  // `weak` edges are not references: the collector may drop their target
  // whatever the source does. They are still validated and still counted in
  // the heap total, but they are not written into the graph, so a `Map` that
  // merely mentions a payload does not appear to own it. DevTools does the
  // same, and keeps `shortcut` — a forwarding property is a real reference.
  const strongCount = buildGraph ? new Int32Array(header.nodeCount) : undefined;
  const edgeTypeAt = header.edgeFieldIndex['type']!;
  const weakType = header.edgeTypeNames.indexOf('weak');

  const edgeWidth = header.edgeFieldCount;
  const toNodeAt = header.edgeFieldIndex['to_node']!;
  const edgeRecord = new Float64Array(edgeWidth);
  // The edge loop walks the same per-node counts the node loop read, so it can
  // tell which node each edge starts from without a second index.
  let written = 0;
  let source = 0;
  let sourceRemaining = header.nodeCount > 0 ? edgeCountOf?.[0] ?? 0 : 0;
  for (let edge = 0; edge < header.edgeCount; edge++) {
    for (let slot = 0; slot < edgeWidth; slot++) edgeRecord[slot] = edgeCursor.next()!;
    const toNode = edgeRecord[toNodeAt]!;
    const target = toNode / width;
    // `-6 % 6` is `-0` and `-1 < nodeCount`, so the range check alone lets a
    // negative offset through as node -1; it must be refused first.
    if (toNode < 0 || toNode % width !== 0 || target >= header.nodeCount) {
      throw bad(
        `edge ${edge} points at to_node ${toNode}, outside the ${header.nodeCount} nodes`,
      );
    }
    if (targets !== undefined && edgeRecord[edgeTypeAt] !== weakType) {
      targets[written++] = target;
      strongCount![source] = strongCount![source]! + 1;
    }
    if (buildGraph) {
      sourceRemaining -= 1;
      while (sourceRemaining === 0 && source < header.nodeCount - 1) {
        source += 1;
        sourceRemaining = edgeCountOf![source]!;
      }
    }
  }
  if (strongCount !== undefined) {
    for (let i = 0; i < header.nodeCount; i++) {
      outStart[i + 1] = outStart[i]! + strongCount[i]!;
    }
  }
  // Only the strong prefix is a graph. Handing the whole buffer over would put
  // its unwritten zero tail into the predecessor counts as edges to node 0.
  const strongTargets = targets === undefined ? undefined : targets.subarray(0, written);

  if (targets === undefined) {
    return {
      header,
      nodeCount: header.nodeCount,
      nodeCountByType,
      totalSelfSize,
      detachedCount,
      retained: {
        kind: 'omitted',
        reason:
          `the graph has ${header.nodeCount} nodes and ${header.edgeCount} edges,` +
          ` past the ${edgeLimit}-edge ceiling;` +
          ' heap totals are reported without retained attribution',
      },
    };
  }

  const { idom, retained, reachableCount } = computeDominators({
    nodeCount: header.nodeCount,
    outStart,
    targets: strongTargets!,
    selfSize: selfSizeOf!,
  });

  // Retained bytes are attributed to the node's own constructor, and only for
  // nodes the root reaches: an unreachable node's bytes are held by nothing,
  // so adding them to a constructor row would invent a finding.
  const byNameRetained = new Map<string, number>();
  for (let index = 0; index < header.nodeCount; index++) {
    if (idom[index] === -1 || namedOf![index] === 0) continue;
    const name = stringAt(strings, nameOf![index]!, `node ${index} name`);
    byNameRetained.set(name, (byNameRetained.get(name) ?? 0) + retained[index]!);
  }

  return {
    header,
    nodeCount: header.nodeCount,
    nodeCountByType,
    totalSelfSize,
    detachedCount,
    retained: {
      kind: 'measured',
      byConstructor: rankConstructors(byName, byNameRetained),
      unreachableCount: header.nodeCount - reachableCount,
    },
  };
}

/** The `strings` table, parsed from its own slice. */
function readStringTable(text: string): readonly string[] {
  const key = topLevelKey(text, 'strings');
  if (key === -1) throw bad('no "strings" array in the document');
  const open = text.indexOf('[', key);
  if (open === -1) throw bad('the "strings" key is not followed by an array');
  const end = endOfValue(text, open);
  if (end === -1) throw bad('the "strings" array is not terminated');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(open, end));
  } catch (err) {
    throw new OhosPerfError(
      `the "strings" array is not valid JSON: ${(err as Error).message}`,
      { code: 'JSHEAP_BAD_SNAPSHOT', cause: err },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw bad('the "strings" array is not an array of strings');
  }
  return parsed as string[];
}

/**
 * The constructor rows, largest retained size first.
 *
 * Ranked by **retained** size, because that is the question: what holds the
 * memory. `selfSize` rides along on each row so a reader can see the
 * difference — a container whose retained size dwarfs its self size is the
 * actionable shape.
 *
 * Ties break on name so two runs on one file agree byte for byte. The list is
 * bounded to {@link TOP_CONSTRUCTORS} so a heap with half a million distinct
 * names keeps a flat memory profile.
 */
function rankConstructors(
  byName: ReadonlyMap<string, { selfSize: number; count: number }>,
  byNameRetained: ReadonlyMap<string, number>,
): readonly ConstructorShare[] {
  return [...byName.entries()]
    .map(([name, share]) => ({
      name,
      selfSize: share.selfSize,
      retainedSize: byNameRetained.get(name) ?? 0,
      count: share.count,
    }))
    .sort((a, b) => (b.retainedSize - a.retainedSize) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, TOP_CONSTRUCTORS);
}
