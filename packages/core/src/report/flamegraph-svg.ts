import { escapeHtml } from './escape';
import type { FoldedStack } from '../query/perf';
import type { TimeRange } from '../types';

/*
 * A flame graph that survives without a browser extension, a CDN or a network.
 *
 * The page is written from folded stacks alone, so it can be produced offline
 * from a capture that has already been analysed. Layout is a plain recursion:
 * each frame's span starts where its previous sibling ends, and siblings are
 * ordered by descending weight so the heaviest path reads first and the same
 * input always produces the same bytes (D5).
 *
 * The artifact is deliberately inert: no script, no link, no fetch. The only
 * URL in the file is the SVG namespace declaration, which is a name, not a
 * request.
 */

/** Width of the drawing area in user units. */
const WIDTH = 1200;
/** Height of one frame row. */
const FRAME_HEIGHT = 18;
/** Padding above the first row and below the last. */
const PAD = 8;
/** Longest label drawn inside a rectangle; the full path lives in `<title>`. */
const LABEL_MAX = 60;

/**
 * Frame colours, chosen by depth alone.
 *
 * Colour is a function of depth and never of the name, so two runs of the same
 * capture cannot disagree on a fill, and a reader can tell rows apart without
 * reading a legend.
 */
const PALETTE = ['#d0614f', '#d9874f', '#d9a94f', '#c2b04f', '#8fae5a', '#5f9e7a'] as const;

/** The artifacts a report bundle carries for this view, in write order. */
export const FLAMEGRAPH_FILES: readonly ['flamegraph.svg', 'flamegraph.html'] =
  ['flamegraph.svg', 'flamegraph.html'];

interface Frame {
  /** Semicolon-joined path from the root; unique per rectangle. */
  readonly path: string;
  /** This frame's own name (the last path segment). */
  readonly name: string;
  readonly depth: number;
  readonly weight: number;
  readonly children: Frame[];
}

/**
 * Fold the stacks into a tree, summing each prefix.
 *
 * A stack contributes its weight to every prefix along it, so a frame's weight
 * is the weight of the samples that passed through it — the width a flame graph
 * is expected to show. Stacks with a non-positive or non-finite weight are
 * skipped: they would draw a zero-width rectangle and make the total ambiguous.
 */
function buildTree(stacks: readonly FoldedStack[]): { roots: Frame[]; total: number } {
  const weights = new Map<string, number>();
  let total = 0;

  for (const stack of stacks) {
    if (!Number.isFinite(stack.samples) || stack.samples <= 0) continue;
    if (stack.stack === '') continue;
    total += stack.samples;
    const frames = stack.stack.split(';');
    for (let depth = 1; depth <= frames.length; depth++) {
      const path = frames.slice(0, depth).join(';');
      weights.set(path, (weights.get(path) ?? 0) + stack.samples);
    }
  }

  const nodes = new Map<string, Frame>();
  for (const [path, weight] of weights) {
    const segments = path.split(';');
    nodes.set(path, {
      path,
      name: segments[segments.length - 1],
      depth: segments.length - 1,
      weight,
      children: [],
    });
  }

  const roots: Frame[] = [];
  for (const node of nodes.values()) {
    if (node.depth === 0) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(node.path.slice(0, node.path.lastIndexOf(';')));
    // A child can only exist if its parent does; the prefix was inserted first.
    if (parent !== undefined) parent.children.push(node);
  }

  sortSiblings(roots);
  for (const node of nodes.values()) sortSiblings(node.children);
  return { roots, total };
}

/** Heaviest first, then lexicographic so equal weights still have one order. */
function sortSiblings(frames: Frame[]): void {
  frames.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/**
 * `samples / total * 100`, rounded half-to-even at two decimals.
 *
 * Both inputs are event counts, so the ratio is computed in integers: no
 * floating-point tie can decide a displayed share. A zero total has no share,
 * which reads as `0`.
 */
function shareHundredths(samples: number, total: number): number {
  if (!Number.isFinite(samples) || !Number.isFinite(total) || total <= 0) return 0;
  const numerator = BigInt(Math.round(samples)) * 10_000n;
  const denominator = BigInt(Math.round(total));
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  let hundredths = quotient;
  if (doubled > denominator) hundredths = quotient + 1n;
  else if (doubled === denominator) hundredths = quotient % 2n === 0n ? quotient : quotient + 1n;
  return Number(hundredths) / 100;
}

/** A label short enough for a rectangle; the full name stays in the title. */
function label(name: string): string {
  return name.length <= LABEL_MAX ? name : `${name.slice(0, LABEL_MAX - 1)}…`;
}

/** One rectangle plus its label; `x` and `width` are in user units. */
function drawFrame(frame: Frame, x: number, width: number, total: number, out: string[]): void {
  const y = frame.depth * FRAME_HEIGHT;
  const fill = PALETTE[frame.depth % PALETTE.length];
  const share = shareHundredths(frame.weight, total);
  out.push(
    `<rect x="${round(x)}" y="${y}" width="${round(width)}" height="${FRAME_HEIGHT}" ` +
    `fill="${fill}"><title>${escapeHtml(frame.path)} ` +
    `(${frame.weight} samples, ${share}%)</title></rect>`,
  );

  const text = label(frame.name);
  if (text !== '' && width >= 24) {
    out.push(
      `<text x="${round(x + 4)}" y="${y + 13}" fill="#1c1f24" font-size="11" ` +
      `font-family="system-ui, sans-serif">${escapeHtml(text)}</text>`,
    );
  }
}

/**
 * Trim a computed coordinate to three decimals.
 *
 * Integer weights over an integer total almost never land on an integer pixel,
 * and a raw double would make two platforms disagree on the last digit. Three
 * decimals is finer than a device pixel at this width and keeps the document
 * byte-stable.
 */
function round(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

/** Lay out a subtree: children start at the parent's x and run right. */
function drawChildren(frame: Frame, x: number, width: number, total: number, out: string[]): void {
  let cursor = x;
  for (const child of frame.children) {
    const childWidth = width * (child.weight / frame.weight);
    drawFrame(child, cursor, childWidth, total, out);
    drawChildren(child, cursor, childWidth, total, out);
    cursor += childWidth;
  }
}

/**
 * Render folded stacks as a self-contained SVG document.
 *
 * An empty list still renders a valid document that says so, rather than a
 * zero-sized canvas a viewer would show as a blank rectangle.
 */
export function renderFlamegraphSvg(stacks: readonly FoldedStack[]): string {
  const { roots, total } = buildTree(stacks);
  const out: string[] = [];

  if (total <= 0) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${FRAME_HEIGHT + PAD * 2}" ` +
      `viewBox="0 0 ${WIDTH} ${FRAME_HEIGHT + PAD * 2}">` +
      `<rect x="0" y="0" width="${WIDTH}" height="${FRAME_HEIGHT + PAD * 2}" fill="#f6f7f9"/>` +
      `<text x="${PAD}" y="${PAD + 12}" fill="#5c636e" font-size="12" ` +
      `font-family="system-ui, sans-serif">No stacks to draw.</text>` +
      '</svg>'
    );
  }

  let cursor = 0;
  for (const root of roots) {
    const width = WIDTH * (root.weight / total);
    drawFrame(root, cursor, width, total, out);
    drawChildren(root, cursor, width, total, out);
    cursor += width;
  }

  const height = Math.max(...roots.map((root) => maxDepth(root))) * FRAME_HEIGHT + PAD * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
    `viewBox="0 0 ${WIDTH} ${height}">` +
    `<rect x="0" y="0" width="${WIDTH}" height="${height}" fill="#f6f7f9"/>` +
    out.join('') +
    '</svg>'
  );
}

/** The deepest row of a subtree, as a frame count. */
function maxDepth(frame: Frame): number {
  let deepest = frame.depth + 1;
  for (const child of frame.children) deepest = Math.max(deepest, maxDepth(child));
  return deepest;
}
