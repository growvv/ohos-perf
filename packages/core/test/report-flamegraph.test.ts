import { describe, it, expect } from 'vitest';
import {
  FLAMEGRAPH_FILES,
  renderFlamegraphSvg,
} from '../src/report/flamegraph-svg';
import { renderFlamegraphHtml } from '../src/report/flamegraph-html';
import type { FoldedStack } from '../src/query/perf';

/*
 * The offline flamegraph: a self-contained SVG derived from folded stacks, and
 * an HTML page that wraps it. Both must be byte-stable (D5) and free of any
 * external reference, so a report bundle opens with no network at all.
 */

const WIDTH = 1200;
const FRAME_HEIGHT = 18;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  title: string;
}

/** The exact rect shape the renderer emits, one per line. */
function rects(svg: string): Rect[] {
  const re = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)" fill="([^"]+)"><title>([\s\S]*?)<\/title><\/rect>/g;
  const out: Rect[] = [];
  for (const m of svg.matchAll(re)) {
    out.push({
      x: Number(m[1]),
      y: Number(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
      fill: m[5],
      title: m[6],
    });
  }
  return out;
}

function stack(path: string, samples: number): FoldedStack {
  const frames = path.split(';');
  return { stack: path, leaf: frames[frames.length - 1], samples };
}

describe('renderFlamegraphSvg', () => {
  it('draws one rectangle per distinct frame path, widths summing to the root', () => {
    const svg = renderFlamegraphSvg([stack('a;b', 3), stack('a;c', 2)]);
    const drawn = rects(svg);

    expect(drawn).toHaveLength(3);
    // Root `a` carries the whole 5 units, so it spans the full width.
    expect(drawn[0]).toMatchObject({ x: 0, y: 0, width: WIDTH, height: FRAME_HEIGHT });
    // Siblings are laid out left to right: `a;b` (3) then `a;c` (2).
    expect(drawn[1]).toMatchObject({ x: 0, y: FRAME_HEIGHT, width: WIDTH * 0.6 });
    expect(drawn[2]).toMatchObject({ x: WIDTH * 0.6, y: FRAME_HEIGHT, width: WIDTH * 0.4 });
    expect(drawn[1].width + drawn[2].width).toBeCloseTo(WIDTH, 6);
  });

  it('gives every rectangle a title naming the frame, its weight and its share', () => {
    const drawn = rects(renderFlamegraphSvg([stack('a;b', 3), stack('a;c', 2)]));
    expect(drawn.map((r) => r.title)).toEqual([
      'a (5 samples, 100%)',
      'a;b (3 samples, 60%)',
      'a;c (2 samples, 40%)',
    ]);
  });

  it('escapes markup in a frame name', () => {
    const svg = renderFlamegraphSvg([stack('<x>&"y"', 1)]);
    expect(svg).toContain('&lt;x&gt;&amp;&quot;y&quot;');
    expect(svg).not.toContain('<x>');
    expect(rects(svg)[0].title).toContain('&lt;x&gt;&amp;&quot;y&quot;');
  });

  it('references nothing external: no script, no link, no fetch', () => {
    const svg = renderFlamegraphSvg([stack('a;b', 1)]);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('href=');
    // The SVG namespace is a declaration, not a fetch.
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('gives a lone stack the full width', () => {
    const drawn = rects(renderFlamegraphSvg([stack('only', 1)]));
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ x: 0, y: 0, width: WIDTH });
  });

  it('lays a deep stack out downward without negative or repeated rows', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `f${i}`).join(';');
    const drawn = rects(renderFlamegraphSvg([stack(deep, 1)]));

    expect(drawn).toHaveLength(40);
    expect(drawn.every((r) => r.y >= 0)).toBe(true);
    expect(drawn.map((r) => r.y)).toEqual(
      Array.from({ length: 40 }, (_, i) => i * FRAME_HEIGHT),
    );
  });

  it('truncates a long label but keeps the full path in the title', () => {
    const long = 'f'.repeat(80);
    const svg = renderFlamegraphSvg([stack(long, 1)]);
    // The drawn label is 60 characters with an ellipsis; the title is whole.
    expect(svg).toContain(`>${'f'.repeat(59)}…</text>`);
    expect(rects(svg)[0].title).toContain(long);
  });

  it('is byte-identical across two calls', () => {
    const stacks = [stack('a;b', 3), stack('a;c', 2)];
    expect(renderFlamegraphSvg(stacks)).toBe(renderFlamegraphSvg(stacks));
  });

  it('renders a valid empty document with no NaN when there is nothing to draw', () => {
    const svg = renderFlamegraphSvg([]);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('No stacks to draw.');
    expect(svg).not.toContain('NaN');
    expect(rects(svg)).toEqual([]);
  });

  it('pins the two artifact names', () => {
    expect(FLAMEGRAPH_FILES).toEqual(['flamegraph.svg', 'flamegraph.html']);
  });
});

describe('renderFlamegraphHtml', () => {
  const window = { startNs: 0, endNs: 5_000_000_000 };

  it('states the unresolved share and the capture symbol state', () => {
    const html = renderFlamegraphHtml({
      stacks: [stack('a;b', 3)],
      app: 'com.demo',
      window,
      unresolvedShare: 9.43,
      symbolized: true,
    });
    expect(html).toContain('com.demo');
    expect(html).toContain('9.43%');
    expect(html).toContain('Symbols were resolved from the capture');
  });

  it('says symbolization was not requested rather than implying it happened', () => {
    const html = renderFlamegraphHtml({
      stacks: [stack('a', 1)],
      app: 'com.demo',
      window,
      unresolvedShare: null,
      symbolized: false,
    });
    expect(html).toContain('Symbolization was not requested');
    expect(html).not.toContain('Symbols were resolved');
  });

  it('says the capture symbol state is unknown when it was not recorded', () => {
    const html = renderFlamegraphHtml({
      stacks: [stack('a', 1)],
      app: 'com.demo',
      window,
      unresolvedShare: 0,
      symbolized: null,
    });
    expect(html).toContain('unknown');
    expect(html).not.toContain('Symbolization was not requested');
    expect(html).not.toContain('Symbols were resolved');
  });

  it('says the window is the whole capture when the trace records no span', () => {
    // A hand-built or truncated scene has no `trace_range`; `report` passes
    // `0 … MAX_SAFE_INTEGER` as its marker for that. Printed as numbers the
    // header would claim a 285-year window, which no reader should have to
    // decode.
    const html = renderFlamegraphHtml({
      stacks: [stack('a', 1)],
      app: 'com.demo',
      window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
      unresolvedShare: 0,
      symbolized: true,
    });
    expect(html).toContain('whole capture');
    expect(html).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it('embeds the SVG inline and escapes the app name', () => {
    const html = renderFlamegraphHtml({
      stacks: [stack('a', 1)],
      app: '<b>&</b>',
      window,
      unresolvedShare: 0,
      symbolized: true,
    });
    expect(html).toContain('<svg');
    expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(html).not.toContain('<b>&</b>');
  });

  it('is byte-identical across two calls', () => {
    const input = {
      stacks: [stack('a;b', 3), stack('a;c', 2)],
      app: 'com.demo',
      window,
      unresolvedShare: 40,
      symbolized: true,
    };
    expect(renderFlamegraphHtml(input)).toBe(renderFlamegraphHtml(input));
  });
});
