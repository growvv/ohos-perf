import type { UiNode } from '../query/ui';

/** One node-level difference between two captures. */
export interface UiTreeDifference {
  readonly change: 'added' | 'removed' | 'changed';
  /** Document path, e.g. `0.2.1` — the position in the *later* tree for added
   * and changed nodes, in the earlier tree for removed ones. */
  readonly path: string;
  /** The identity the match used, so a caller can find the node again. */
  readonly identity: string;
  readonly type: string;
  readonly bounds?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /** Attribute-level differences; absent for added and removed nodes. */
  readonly attributes?: Array<{ name: string; before: string; after: string }>;
}

export interface UiTreeDiff {
  readonly added: UiTreeDifference[];
  readonly removed: UiTreeDifference[];
  readonly changed: UiTreeDifference[];
  /** Matched nodes with no reported difference. */
  readonly unchanged: number;
}

/**
 * Attributes excluded from the comparison.
 *
 * HapRay's list, kept for the same reason it exists: these are renderer
 * internals that change between two captures of an identical screen, so
 * reporting them would drown a real difference in noise.
 */
export const IGNORED_ATTRIBUTES: readonly string[] = [
  'id',
  'accessibilityId',
  'rsNode',
  'frameProxy',
  'frameRecord',
  'contentConstraint',
  'parentLayoutConstraint',
  'user defined constraint',
];

/**
 * Geometry differences smaller than this are not differences.
 *
 * A node that moved by 3 px between two captures of the same screen is layout
 * jitter, not a UI change; 5 px is HapRay's measured threshold and the one the
 * diff reports in its own output.
 */
export const GEOMETRY_TOLERANCE_PX = 5;

/** Attribute names compared as geometry, edge by edge. */
const GEOMETRY_ATTRIBUTES = new Set(['bounds']);

/**
 * A node's identity for matching.
 *
 * `bundleName | type | id | text`, with an empty `id` or `text` omitted. Text
 * is part of the identity deliberately: a label *is* what that node is, so a
 * text change reads as one removed node plus one added one rather than a
 * "changed" node whose meaning is unclear. Matching by identity instead of by
 * index is what stops one inserted sibling from shifting every later
 * comparison.
 */
export function nodeIdentity(node: UiNode): string {
  const parts = [node.bundleName, node.type];
  if (node.id !== '') parts.push(`#${node.id}`);
  if (node.text !== '') parts.push(`"${node.text}"`);
  return parts.join('|');
}

interface Parsed {
  readonly node: UiNode;
  readonly path: string;
  readonly identity: string;
  readonly children: Parsed[];
}

/**
 * Rebuild the tree from the flattened node list.
 *
 * The flattening is depth-first in document order with `depth` and a direct
 * child count, which is enough to reconstruct parent/child links exactly: walk
 * forward, push a node's children onto it until `children` of them are
 * consumed. Reconstructing keeps the diff's input a plain `UiNode[]`, so a
 * caller that already has a flattened list (the query layer, the analyzer) does
 * not need a second representation.
 */
function rebuild(nodes: readonly UiNode[]): Parsed[] {
  let index = 0;
  const build = (depth: number, path: string): Parsed => {
    const node = nodes[index];
    index += 1;
    const children: Parsed[] = [];
    for (let i = 0; i < node.children && index < nodes.length; i += 1) {
      children.push(build(depth + 1, `${path}.${i}`));
    }
    return { node, path, identity: nodeIdentity(node), children };
  };
  const roots: Parsed[] = [];
  let root = 0;
  while (index < nodes.length) {
    roots.push(build(0, String(root)));
    root += 1;
  }
  return roots;
}

/** Compare one matched pair's attributes; returns the differences, sorted. */
function compareAttributes(before: UiNode, after: UiNode): Array<{
  name: string; before: string; after: string;
}> {
  const left = before.attributes ?? {};
  const right = after.attributes ?? {};
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const differences: Array<{ name: string; before: string; after: string }> = [];
  for (const name of names) {
    if (IGNORED_ATTRIBUTES.includes(name)) continue;
    const a = left[name] ?? '';
    const b = right[name] ?? '';
    if (a === b) continue;
    if (GEOMETRY_ATTRIBUTES.has(name) && withinTolerance(before, after)) continue;
    differences.push({ name, before: a, after: b });
  }
  return differences;
}

/** True when both nodes parsed bounds and every edge moved under the tolerance. */
function withinTolerance(before: UiNode, after: UiNode): boolean {
  const a = before.boundsRect;
  const b = after.boundsRect;
  if (a === undefined || b === undefined) return false;
  return (
    Math.abs(a.left - b.left) < GEOMETRY_TOLERANCE_PX &&
    Math.abs(a.top - b.top) < GEOMETRY_TOLERANCE_PX &&
    Math.abs(a.right - b.right) < GEOMETRY_TOLERANCE_PX &&
    Math.abs(a.bottom - b.bottom) < GEOMETRY_TOLERANCE_PX
  );
}

/** Plain lexicographic order over a dotted path, component by component. */
function byPath(a: UiTreeDifference, b: UiTreeDifference): number {
  const left = a.path.split('.').map(Number);
  const right = b.path.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? -1;
    const y = right[i] ?? -1;
    if (x !== y) return x - y;
  }
  return a.change < b.change ? -1 : a.change > b.change ? 1 : 0;
}

function difference(
  change: UiTreeDifference['change'],
  parsed: Parsed,
  extra: { attributes?: UiTreeDifference['attributes'] } = {},
): UiTreeDifference {
  return {
    change,
    path: parsed.path,
    identity: parsed.identity,
    type: parsed.node.type,
    ...(parsed.node.boundsRect === undefined ? {} : { bounds: parsed.node.boundsRect }),
    ...(extra.attributes === undefined ? {} : { attributes: extra.attributes }),
  };
}

/**
 * Compare two flattened trees by node identity.
 *
 * Children are bucketed by identity and paired in document order within each
 * bucket, so an insertion consumes one slot instead of shifting the rest. A
 * node present only on the later side is `added`, only on the earlier side
 * `removed`, and a matched pair with attribute differences is `changed`.
 * Output arrays are sorted by path, so the result is byte-stable (D5).
 */
export function diffTrees(
  before: readonly UiNode[],
  after: readonly UiNode[],
): UiTreeDiff {
  const added: UiTreeDifference[] = [];
  const removed: UiTreeDifference[] = [];
  const changed: UiTreeDifference[] = [];
  let unchanged = 0;

  const walk = (left: Parsed[], right: Parsed[]): void => {
    const buckets = new Map<string, Parsed[]>();
    for (const node of right) {
      const bucket = buckets.get(node.identity);
      if (bucket === undefined) buckets.set(node.identity, [node]);
      else bucket.push(node);
    }
    const matched = new Set<Parsed>();

    for (const node of left) {
      const bucket = buckets.get(node.identity);
      const match = bucket?.shift();
      if (match === undefined) {
        removed.push(difference('removed', node));
        continue;
      }
      matched.add(match);
      const attributes = compareAttributes(node.node, match.node);
      if (attributes.length === 0) unchanged += 1;
      else changed.push(difference('changed', match, { attributes }));
      walk(node.children, match.children);
    }

    for (const node of right) {
      if (!matched.has(node)) added.push(difference('added', node));
    }
  };

  walk(rebuild(before), rebuild(after));
  return {
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    changed: changed.sort(byPath),
    unchanged,
  };
}
