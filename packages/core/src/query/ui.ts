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
  /**
   * `bounds` parsed into a rect, or `undefined` when the string did not match
   * the measured `"[l,t][r,b]"` form. The diff compares geometry edge by edge,
   * so it needs numbers; a node whose bounds did not parse simply has none.
   */
  readonly boundsRect?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  /**
   * Every string attribute the dump carried, for the UI diff's attribute
   * comparison. Optional so a caller that only lists nodes does not pay for a
   * copy of every field; `flattenUiTree` always fills it.
   */
  readonly attributes?: Readonly<Record<string, string>>;
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

/** The measured `bounds` form: `"[left,top][right,bottom]"`. */
const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

/**
 * Parse a `bounds` string into a rect.
 *
 * The dump writes `"[0,0][1080,2340]"`. Anything else — a different separator,
 * a float, a single corner — is `undefined` rather than a guess: the UI diff
 * treats geometry as numbers, and a guessed rect would mark the wrong region.
 */
export function parseBounds(bounds: string): UiNode['boundsRect'] {
  const match = BOUNDS.exec(bounds);
  if (match === null) return undefined;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

/** Every string-valued attribute, copied, so the diff has a stable snapshot. */
function stringAttributes(attributes: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
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
 *
 * `opts.full` adds `boundsRect` and the raw `attributes` map, which the UI diff
 * needs and `ui.get` does not: a query row carries the documented subset, so an
 * agent reading a screen does not get every renderer field with it.
 */
export function flattenUiTree(
  root: unknown,
  opts: { full?: boolean } = {},
): UiNode[] {
  const nodes: UiNode[] = [];

  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || !isRecord(node.attributes)) return;
    const attributes = node.attributes;
    const children = Array.isArray(node.children) ? node.children : [];
    const bounds = attr(attributes, 'bounds');
    const extra = opts.full === true
      ? {
          ...(parseBounds(bounds) === undefined ? {} : { boundsRect: parseBounds(bounds) }),
          attributes: stringAttributes(attributes),
        }
      : {};
    nodes.push({
      depth,
      type: attr(attributes, 'type'),
      bundleName: attr(attributes, 'bundleName'),
      abilityName: attr(attributes, 'abilityName'),
      text: attr(attributes, 'text'),
      id: attr(attributes, 'id'),
      bounds,
      clickable: flag(attributes, 'clickable'),
      enabled: flag(attributes, 'enabled'),
      scrollable: flag(attributes, 'scrollable'),
      children: children.length,
      ...extra,
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
 *
 * `opts.full` is passed through to {@link flattenUiTree}: the UI diff reads a
 * scene with it, the `ui.get` query does not.
 */
export function readUiTree(
  path: string,
  opts: { full?: boolean } = {},
): UiNode[] | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return flattenUiTree(parsed, opts);
}
