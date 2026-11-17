import { escapeHtml } from './escape';
import { renderFlamegraphSvg } from './flamegraph-svg';
import type { FoldedStack } from '../query/perf';
import type { TimeRange } from '../types';

/*
 * The page around the drawing: what was measured, and what the names mean.
 *
 * Everything is inline, so the artifact opens from a folder with no server
 * and no network. The header exists because a flame graph of unsymbolized
 * addresses looks exactly like one of named frames; the symbol sentence is
 * what tells the two apart.
 */

/** Everything the page states around the drawing. */
export interface FlamegraphPageInput {
  readonly stacks: readonly FoldedStack[];
  readonly app: string;
  readonly window: TimeRange;
  /**
   * Unresolved leaf weight as a percentage of the window, or `null` when the
   * capture had no samples to measure it from.
   */
  readonly unresolvedShare: number | null;
  /**
   * Whether symbolization was requested for the capture: `true`, `false`, or
   * `null` when the scene did not record it.
   */
  readonly symbolized: boolean | null;
}

/**
 * The sentence that says where the names came from.
 *
 * A reader must be able to tell "these frames are named" from "these frames
 * were never symbolized", because the second view looks the same but means
 * something different. An unrecorded state says so instead of guessing.
 */
function symbolSentence(symbolized: boolean | null): string {
  if (symbolized === true) return 'Symbols were resolved from the capture.';
  if (symbolized === false) {
    return 'Symbolization was not requested, so frames show addresses only.';
  }
  return 'The capture does not record whether symbolization ran; frame names are unknown.';
}

/** The page's total weight: the sum the drawing's widths are scaled against. */
function totalWeight(stacks: readonly FoldedStack[]): number {
  let total = 0;
  for (const stack of stacks) {
    if (Number.isFinite(stack.samples) && stack.samples > 0) total += stack.samples;
  }
  return total;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.25rem 4rem; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1f24; background: #f6f7f9; }
main { max-width: 1240px; margin: 0 auto; }
h1 { margin: 0 0 .25rem; font-size: 1.75rem; letter-spacing: -.02em; }
.card { margin: 1.25rem 0; padding: 1rem 1.25rem; background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
dt { color: #5c636e; }
dd { margin: 0; font-variant-numeric: tabular-nums; }
svg { display: block; width: 100%; height: auto; }
`.trim();

/**
 * The page: a header card stating what was measured and what the names mean,
 * then the drawing inline. Everything is in this one file, so the artifact
 * opens from a folder with no server and no network.
 */
export function renderFlamegraphHtml(input: FlamegraphPageInput): string {
  const total = totalWeight(input.stacks);
  const share =
    input.unresolvedShare === null ? 'unknown' : `${input.unresolvedShare}%`;
  const svg = renderFlamegraphSvg(input.stacks);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Flame graph — ${escapeHtml(input.app)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Flame graph</h1>',
    '<section class="card">',
    '<dl>',
    `<dt>App</dt><dd>${escapeHtml(input.app)}</dd>`,
    `<dt>Window</dt><dd>${input.window.startNs} – ${input.window.endNs} ns</dd>`,
    `<dt>Stacks</dt><dd>${input.stacks.length}</dd>`,
    `<dt>Total weight</dt><dd>${total} samples</dd>`,
    `<dt>Unresolved leaf weight</dt><dd>${share}</dd>`,
    '</dl>',
    `<p>${symbolSentence(input.symbolized)}</p>`,
    '</section>',
    `<section class="card">${svg}</section>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
