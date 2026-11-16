import { existsSync, readFileSync } from 'node:fs';

/**
 * One node of a `uitest dumpLayout` tree, flattened for querying.
 *
 * Only the inspector fields an agent actually filters on are kept; the full
 * dump carries dozens more (`level`, `inspectorId`, `$rect`, …) and copying
 * them would make every row large without making a query easier. `children`
 * is the direct child count, not the subtree size, so a caller can tell a leaf
 * from a container without re-walking.
 */
export interface UiNode {
  readonly depth: number;
  readonly type: string;
  readonly bundleName: string;
  readonly abilityName: string;
  readonly text: string;
  readonly id: string;
  readonly bounds: string;
  readonly clickable: boolean;
  readonly enabled: boolean;
  readonly scrollable: boolean;
  /** Direct child count. */
  readonly children: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an attribute as a string. A non-string value (a number, `null`, a
 * missing field) becomes `''`: the dump's attributes are strings, so anything
 * else is a shape change worth ignoring rather than propagating as `"[object
 * Object]"`.
 */
function attr(attributes: Record<string, unknown>, name: string): string {
  const value = attributes[name];
  return typeof value === 'string' ? value : '';
}

/** Inspector flags are the strings `'true'`/`'false'`; anything else is false. */
function flag(attributes: Record<string, unknown>, name: string): boolean {
  return attributes[name] === 'true';
}

/**
 * Flatten a `dumpLayout` document depth-first in document order.
 *
 * The root is depth 0. A node without an `attributes` object is skipped
 * **with its subtree**: the dump always carries attributes, so an orphan is a
 * malformed document, and promoting its children would report depths relative
 * to a parent that does not exist.
 *
 * A document that is not a tree at all yields `[]` rather than throwing: the
 * caller asked "what is on screen", and "nothing parseable" is a valid answer
 * that the `ui.get` query can return as zero rows.
 */
export function flattenUiTree(root: unknown): UiNode[] {
  const nodes: UiNode[] = [];

  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || !isRecord(node.attributes)) return;
    const attributes = node.attributes;
    const children = Array.isArray(node.children) ? node.children : [];
    nodes.push({
      depth,
      type: attr(attributes, 'type'),
      bundleName: attr(attributes, 'bundleName'),
      abilityName: attr(attributes, 'abilityName'),
      text: attr(attributes, 'text'),
      id: attr(attributes, 'id'),
      bounds: attr(attributes, 'bounds'),
      clickable: flag(attributes, 'clickable'),
      enabled: flag(attributes, 'enabled'),
      scrollable: flag(attributes, 'scrollable'),
      children: children.length,
    });
    for (const child of children) walk(child, depth + 1);
  };

  walk(root, 0);
  return nodes;
}

/**
 * Read a captured `ui.json` and flatten it.
 *
 * A missing file is not an error (the scene may have no uitest capture);
 * invalid JSON is likewise `undefined`, because a truncated dump is not a
 * screen with no nodes.
 */
export function readUiTree(path: string): UiNode[] | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return flattenUiTree(parsed);
}
