/**
 * Selecting UI nodes by what they are, rather than by where they are.
 *
 * A coordinate is a claim about one device's resolution. A selector is a claim
 * about the screen's content, which is what a scenario actually means to say:
 * "tap the button that says OK", not "tap 540, 1170". This module is the whole
 * matching language — it reads a flattened `UiNode[]` and answers with nodes,
 * never with device calls, so it is testable without a device and a scenario's
 * selector can be checked against a captured screen before it ever runs.
 *
 * The types are data, validated at load time like every other scenario field.
 * An unknown key is a refusal naming its JSON path, because a selector typo
 * that silently matched nothing would turn a test into a no-op that reports
 * "the app did not change" instead of "your test is wrong".
 */

import { OhosPerfError } from '../errors';
import type { UiNode } from '../query/ui';

/** A rectangle in device pixels, matching `UiNode.boundsRect`. */
export interface SelectorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How a selector names nodes. Every kind is exhaustive and closed. */
export type Selector =
  | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean }
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'clickable' }
  | { readonly kind: 'all'; readonly of: readonly Selector[] }
  | { readonly kind: 'any'; readonly of: readonly Selector[] }
  | { readonly kind: 'not'; readonly of: Selector }
  | { readonly kind: 'index'; readonly of: Selector; readonly index: number }
  | { readonly kind: 'bounds'; readonly of: Selector; readonly within: SelectorRect }
  | {
      readonly kind: 'relative';
      readonly of: Selector;
      readonly relation: 'above' | 'below' | 'leftOf' | 'rightOf';
      readonly to: Selector;
    };

/** The relations `relative` understands. */
const RELATIONS = ['above', 'below', 'leftOf', 'rightOf'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(path: string, message: string): never {
  throw new OhosPerfError(`${path}: ${message}`, { code: 'SCENARIO_BAD_SELECTOR' });
}

/** A required non-empty string field, named by its own path. */
function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    bad(path, 'expected a non-empty string');
  }
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bad(path, 'expected a number');
  }
  return value;
}

function requiredRect(value: unknown, path: string): SelectorRect {
  if (!isRecord(value)) bad(path, 'expected an object with left, top, right, bottom');
  const rect: SelectorRect = {
    left: requiredNumber(value.left, `${path}.left`),
    top: requiredNumber(value.top, `${path}.top`),
    right: requiredNumber(value.right, `${path}.right`),
    bottom: requiredNumber(value.bottom, `${path}.bottom`),
  };
  if (rect.right < rect.left || rect.bottom < rect.top) {
    bad(path, 'right must not be left of left, and bottom must not be above top');
  }
  return rect;
}

/** The allowed keys of each kind, so a typo is a refusal and not a silent default. */
const KEYS: Readonly<Record<Selector['kind'], readonly string[]>> = {
  text: ['kind', 'text', 'exact'],
  id: ['kind', 'id'],
  type: ['kind', 'type'],
  clickable: ['kind'],
  all: ['kind', 'of'],
  any: ['kind', 'of'],
  not: ['kind', 'of'],
  index: ['kind', 'of', 'index'],
  bounds: ['kind', 'of', 'within'],
  relative: ['kind', 'of', 'relation', 'to'],
};

function checkKeys(
  value: Record<string, unknown>,
  kind: Selector['kind'],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!KEYS[kind].includes(key)) {
      bad(path, `unknown key ${JSON.stringify(key)} for a ${kind} selector`);
    }
  }
}

/**
 * Validate one selector document.
 *
 * `path` is the JSON path of the selector in the scenario — `steps[0].target`,
 * `steps[0].expect.present[0].selector` — and every rejection message starts
 * with it so a large scenario's error says where to look. Nested selectors
 * extend the path (`.of[1]`, `.to`), which is what makes a deep typo findable.
 */
export function parseSelector(value: unknown, path: string): Selector {
  if (!isRecord(value)) bad(path, 'expected a selector object');
  const kind = value.kind;
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `toString`
  // and `constructor` would pass this guard and then crash in `KEYS[kind]`.
  if (typeof kind !== 'string' || !Object.hasOwn(KEYS, kind)) {
    bad(path, `unknown selector kind ${JSON.stringify(kind)}`);
  }
  const selectorKind = kind as Selector['kind'];
  checkKeys(value, selectorKind, path);

  switch (selectorKind) {
    case 'text': {
      const text = requiredText(value.text, `${path}.text`);
      const exact = value.exact;
      if (exact !== undefined && typeof exact !== 'boolean') {
        bad(`${path}.exact`, 'expected true or false');
      }
      return exact === undefined ? { kind: 'text', text } : { kind: 'text', text, exact };
    }
    case 'id':
      return { kind: 'id', id: requiredText(value.id, `${path}.id`) };
    case 'type':
      return { kind: 'type', type: requiredText(value.type, `${path}.type`) };
    case 'clickable':
      return { kind: 'clickable' };
    case 'all':
    case 'any': {
      if (!Array.isArray(value.of) || value.of.length === 0) {
        bad(`${path}.of`, 'expected a non-empty array of selectors');
      }
      return {
        kind: selectorKind,
        of: value.of.map((child: unknown, index: number) =>
          parseSelector(child, `${path}.of[${index}]`),
        ),
      };
    }
    case 'not':
      return { kind: 'not', of: parseSelector(value.of, `${path}.of`) };
    case 'index': {
      const index = requiredNumber(value.index, `${path}.index`);
      if (!Number.isSafeInteger(index) || index < 0) {
        bad(`${path}.index`, 'expected a non-negative whole number');
      }
      return { kind: 'index', of: parseSelector(value.of, `${path}.of`), index };
    }
    case 'bounds':
      return {
        kind: 'bounds',
        of: parseSelector(value.of, `${path}.of`),
        within: requiredRect(value.within, `${path}.within`),
      };
    case 'relative': {
      const relation = value.relation;
      if (typeof relation !== 'string' || !(RELATIONS as readonly string[]).includes(relation)) {
        bad(`${path}.relation`, `expected one of ${RELATIONS.join(', ')}`);
      }
      return {
        kind: 'relative',
        of: parseSelector(value.of, `${path}.of`),
        relation: relation as (typeof RELATIONS)[number],
        to: parseSelector(value.to, `${path}.to`),
      };
    }
  }
}

/** A node's centre, or `undefined` when its bounds never parsed. */
function centre(node: UiNode): { x: number; y: number } | undefined {
  const rect = node.boundsRect;
  if (rect === undefined) return undefined;
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  };
}

/** A node's position for ordering: top first, then left, then identity. */
function comparePosition(a: UiNode, b: UiNode): number {
  const ra = a.boundsRect;
  const rb = b.boundsRect;
  // A node with unparsed bounds sorts after every parsed one: it has no
  // position to compare, and putting it first would make `index: 0` select it.
  if (ra === undefined && rb !== undefined) return 1;
  if (ra !== undefined && rb === undefined) return -1;
  if (ra !== undefined && rb !== undefined) {
    if (ra.top !== rb.top) return ra.top - rb.top;
    if (ra.left !== rb.left) return ra.left - rb.left;
    if (ra.right !== rb.right) return ra.right - rb.right;
    if (ra.bottom !== rb.bottom) return ra.bottom - rb.bottom;
  }
  const ia = `${a.bundleName}|${a.type}|${a.id}|${a.text}`;
  const ib = `${b.bundleName}|${b.type}|${b.id}|${b.text}`;
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** True when `node`'s centre lies inside `rect`. */
function inside(node: UiNode, rect: SelectorRect): boolean {
  const point = centre(node);
  if (point === undefined) return false;
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/** True when `node` satisfies `relation` with respect to `anchor`. */
function relates(
  node: UiNode,
  anchor: UiNode,
  relation: (typeof RELATIONS)[number],
): boolean {
  const a = centre(node);
  const b = centre(anchor);
  if (a === undefined || b === undefined) return false;
  switch (relation) {
    case 'above':
      return a.y < b.y;
    case 'below':
      return a.y > b.y;
    case 'leftOf':
      return a.x < b.x;
    case 'rightOf':
      return a.x > b.x;
  }
}

/**
 * Every node the selector matches, in document order with geometry tie-breaks.
 *
 * The input is the candidate set. `all` narrows it, `any` widens it within it,
 * and `not` is the complement **of its own candidate set** — `all: [text OK,
 * not id x]` reads "an OK node that is not x", not "everything that is not x".
 * Scoping the complement to the whole tree instead would make the second
 * reading the only possible one, and an author would have no way to say the
 * first.
 *
 * `relative` resolves its anchor to the **first** match in the same order, so
 * "the node below the OK button" has one meaning rather than "below some node
 * called OK". A node whose `bounds` never parsed satisfies no geometric
 * relation, which keeps a malformed dump from producing a match at (0,0).
 */
export function matchSelector(
  nodes: readonly UiNode[],
  selector: Selector,
): UiNode[] {
  switch (selector.kind) {
    case 'text': {
      const needle = selector.text.toLowerCase();
      return nodes.filter((node) => {
        const haystack = node.text.toLowerCase();
        return selector.exact === true ? haystack === needle : haystack.includes(needle);
      });
    }
    case 'id':
      return nodes.filter((node) => node.id === selector.id);
    case 'type':
      return nodes.filter((node) => node.type === selector.type);
    case 'clickable':
      return nodes.filter((node) => node.clickable && node.enabled);
    case 'all': {
      let candidates = [...nodes];
      for (const child of selector.of) candidates = matchSelector(candidates, child);
      return candidates;
    }
    case 'any': {
      const matched = new Set<UiNode>();
      for (const child of selector.of) {
        for (const node of matchSelector(nodes, child)) matched.add(node);
      }
      // Document order, not union order: two runs over the same tree agree.
      return nodes.filter((node) => matched.has(node));
    }
    case 'not': {
      const excluded = new Set(matchSelector(nodes, selector.of));
      return nodes.filter((node) => !excluded.has(node));
    }
    case 'index': {
      const matched = [...matchSelector(nodes, selector.of)].sort(comparePosition);
      const chosen = matched[selector.index];
      return chosen === undefined ? [] : [chosen];
    }
    case 'bounds':
      return matchSelector(nodes, selector.of).filter((node) =>
        inside(node, selector.within),
      );
    case 'relative': {
      const anchors = [...matchSelector(nodes, selector.to)].sort(comparePosition);
      const anchor = anchors[0];
      if (anchor === undefined) return [];
      return matchSelector(nodes, selector.of).filter((node) =>
        relates(node, anchor, selector.relation),
      );
    }
  }
}

/**
 * The one node a selector names.
 *
 * Zero and many are different refusals: the first is a wrong selector and the
 * second is an ambiguous one, and the fix for each is not the fix for the
 * other. `label` is the action's own name for the selector (`target`,
 * `scrollTo`, `area`) so the message says which one to look at.
 */
export function resolveSelector(
  nodes: readonly UiNode[],
  selector: Selector,
  label: string,
): UiNode {
  const matched = matchSelector(nodes, selector);
  if (matched.length === 0) {
    throw new OhosPerfError(
      `${label}: no node matched ${describe(selector)}` +
        ` (${nodes.length} nodes on screen)`,
      { code: 'SCENARIO_SELECTOR_NO_MATCH' },
    );
  }
  if (matched.length > 1) {
    throw new OhosPerfError(
      `${label}: ${matched.length} nodes matched ${describe(selector)};` +
        ' narrow it with index, bounds or a more specific selector',
      { code: 'SCENARIO_SELECTOR_AMBIGUOUS' },
    );
  }
  return matched[0]!;
}

/**
 * A selector as a short sentence, for an error message.
 *
 * Deliberately not JSON: the point of a refusal is to be readable next to the
 * scenario line that caused it, and `{"kind":"text","text":"OK"}` is not.
 */
export function describe(selector: Selector): string {
  switch (selector.kind) {
    case 'text':
      return selector.exact === true
        ? `text exactly ${JSON.stringify(selector.text)}`
        : `text containing ${JSON.stringify(selector.text)}`;
    case 'id':
      return `id ${JSON.stringify(selector.id)}`;
    case 'type':
      return `type ${JSON.stringify(selector.type)}`;
    case 'clickable':
      return 'a clickable node';
    case 'all':
      return `all of [${selector.of.map(describe).join(' and ')}]`;
    case 'any':
      return `any of [${selector.of.map(describe).join(' or ')}]`;
    case 'not':
      return `not ${describe(selector.of)}`;
    case 'index':
      return `#${selector.index} of [${describe(selector.of)}]`;
    case 'bounds':
      return `[${describe(selector.of)}] within` +
        ` (${selector.within.left},${selector.within.top})-` +
        `(${selector.within.right},${selector.within.bottom})`;
    case 'relative':
      return `[${describe(selector.of)}] ${selector.relation} [${describe(selector.to)}]`;
  }
}
