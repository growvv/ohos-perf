import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSceneDirs } from '../src/ui/compare';
import { encodePng, type RgbaImage } from '../src/image/png';
import { OhosPerfError } from '../src/errors';

const IMAGE: RgbaImage = {
  width: 8,
  height: 4,
  data: new Uint8Array(8 * 4 * 4).fill(120),
};

/** One `uitest dumpLayout` document with the given leaf labels. */
function tree(labels: string[]): unknown {
  return {
    attributes: { type: 'root', bundleName: 'com.demo', bounds: '[0,0][8,4]' },
    children: labels.map((text, index) => ({
      attributes: {
        type: 'Text', bundleName: 'com.demo', text, id: `id-${text}`,
        bounds: `[0,${index}][8,${index + 1}]`, clickable: 'false',
        enabled: 'true', scrollable: 'false',
      },
      children: [],
    })),
  };
}

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'ohosperf-ui-compare-'));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A scene directory with a screenshot, a tree, and (optionally) scene.json. */
function scene(
  name: string,
  opts: { image?: RgbaImage; labels?: string[]; startedAtMs?: number } = {},
): string {
  const dir = join(parent, name);
  const image = opts.image ?? IMAGE;
  const labels = opts.labels ?? ['a'];
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'screenshot.png'), encodePng(image));
  writeFileSync(join(dir, 'ui.json'), JSON.stringify(tree(labels)));
  writeFileSync(join(dir, 'scene.json'), JSON.stringify({
    version: 1,
    app: { packageName: 'com.demo', processNames: ['com.demo'] },
    pids: [], deviceId: 't1',
    capture: {
      startedAtMs: opts.startedAtMs ?? 1000, durationMs: 10,
      collectors: ['hitrace', 'screenshot', 'uitest'],
      screenshot: { width: image.width, height: image.height, bytes: 1 },
      uitest: { nodes: labels.length + 1 },
    },
  }));
  return dir;
}

const out = (): string => join(parent, 'out');

describe('compareSceneDirs', () => {
  it('reports zero differences for identical scenes', async () => {
    const a = scene('a');
    const b = scene('b');
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.schemaVersion).toBe(1);
    expect(diff.tree).toEqual({ added: [], removed: [], changed: [], unchanged: 2 });
    expect(diff.image?.hamming).toBe(0);
    expect(diff.image?.changedRatio).toBe(0);
    expect(diff.regions).toEqual([]);
    expect(diff.degraded).toEqual([]);
  });

  it('writes the four output files', async () => {
    const a = scene('a');
    const b = scene('b');
    await compareSceneDirs(a, b, { outDir: out() });

    for (const name of [
      'ui-diff.json', 'ui-diff.html', 'ui-diff-marked-a.png', 'ui-diff-marked-b.png',
    ]) {
      expect(existsSync(join(out(), name)), name).toBe(true);
    }
  });

  it('reports one inserted node as one added difference', async () => {
    const a = scene('a', { labels: ['one', 'three'] });
    const b = scene('b', { labels: ['one', 'two', 'three'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.tree?.added).toHaveLength(1);
    expect(diff.tree?.added[0]).toMatchObject({ change: 'added', type: 'Text' });
    expect(diff.tree?.added[0].identity).toContain('"two"');
    expect(diff.tree?.removed).toEqual([]);
    expect(diff.tree?.changed).toEqual([]);
    // `three` was not shifted into a difference.
    expect(diff.tree?.unchanged).toBe(3);
  });

  it('collects the changed node bounds as regions', async () => {
    const a = scene('a', { labels: ['one'] });
    const b = scene('b', { labels: ['one', 'two'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.regions).toEqual([{ left: 0, top: 1, right: 8, bottom: 2 }]);
  });

  it('marks the regions on both written images', async () => {
    const a = scene('a', { labels: ['one'] });
    const b = scene('b', { labels: ['one', 'two'] });
    await compareSceneDirs(a, b, { outDir: out() });

    // The marked PNGs differ from the plain one: a red edge was drawn.
    const plain = readFileSync(join(a, 'screenshot.png'));
    const marked = readFileSync(join(out(), 'ui-diff-marked-a.png'));
    expect(marked.equals(plain)).toBe(false);
  });

  it('refuses two screenshots of different sizes', async () => {
    const a = scene('a');
    const b = scene('b', {
      image: { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(120) },
    });
    const err = await compareSceneDirs(a, b, { outDir: out() }).catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UI_SIZE_MISMATCH');
    expect((err as OhosPerfError).message).toMatch(/8x4/);
    expect((err as OhosPerfError).message).toMatch(/4x4/);
  });

  it('names the side and the artifact when only one scene has it', async () => {
    const a = scene('a');
    const b = join(parent, 'no-shot');
    // A scene with a tree but no screenshot.
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'ui.json'), JSON.stringify(tree(['a'])));

    const err = await compareSceneDirs(a, b, { outDir: out() }).catch((e: unknown) => e);
    expect((err as OhosPerfError).code).toBe('UI_MISSING_ARTIFACT');
    expect((err as OhosPerfError).message).toMatch(/screenshot\.png/);
    expect((err as OhosPerfError).message).toMatch(/b/);
  });

  it('degrades an artifact neither side has instead of failing', async () => {
    const a = scene('a');
    const b = scene('b');
    rmSync(join(a, 'screenshot.png'));
    rmSync(join(b, 'screenshot.png'));
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.image).toBeNull();
    expect(diff.degraded).toEqual(['no screenshot.png on either side']);
    expect(diff.tree).not.toBeNull();
  });

  it('compares tree-only scenes and says the image is absent', async () => {
    const a = scene('a');
    const b = scene('b');
    rmSync(join(a, 'ui.json'));
    rmSync(join(b, 'ui.json'));
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.tree).toBeNull();
    expect(diff.degraded).toContain('no ui.json on either side');
    expect(diff.image).not.toBeNull();
  });

  it('is byte-identical across two runs over the same inputs', async () => {
    const a = scene('a', { labels: ['one', 'three'] });
    const b = scene('b', { labels: ['one', 'two', 'three'] });
    const first = await compareSceneDirs(a, b, { outDir: join(parent, 'out1') });
    const second = await compareSceneDirs(a, b, { outDir: join(parent, 'out2') });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(readFileSync(join(parent, 'out1', 'ui-diff.json')))
      .toEqual(readFileSync(join(parent, 'out2', 'ui-diff.json')));
    expect(readFileSync(join(parent, 'out1', 'ui-diff-marked-a.png')))
      .toEqual(readFileSync(join(parent, 'out2', 'ui-diff-marked-a.png')));
  });

  it('copies each side\'s capture time from its own scene.json', async () => {
    const a = scene('a', { startedAtMs: 111 });
    const b = scene('b', { startedAtMs: 222 });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.a).toMatchObject({ dir: a, startedAtMs: 111, screenshot: { width: 8, height: 4 } });
    expect(diff.b).toMatchObject({ dir: b, startedAtMs: 222, tree: { nodes: 2 } });
  });

  it('writes an HTML page with no script and the marked image', async () => {
    const a = scene('a', { labels: ['one'] });
    const b = scene('b', { labels: ['one', 'two'] });
    await compareSceneDirs(a, b, { outDir: out() });
    const html = readFileSync(join(out(), 'ui-diff.html'), 'utf8');

    expect(html).toContain('<img src="ui-diff-marked-a.png"');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('ui-diff-marked-b.png');
    expect(html).toContain('added');
    expect(html).toContain('two');
    // The tolerance is stated in the page, not only in the docs.
    expect(html).toContain('8');
  });
});

describe('animation labels (parity row 31)', () => {
  /*
   * HapRay's `UIAnalyzer` labels a UI region as animating when the start and
   * end captures of that region differ: it crops the region from both
   * screenshots, compares dHashes, and calls anything under 85% similar an
   * animation (`major_change` < 50, `moderate_change` < 70, `minor_change`
   * < 85).
   *
   * This package had the tree diff and the image diff but emitted no label,
   * because a bare dHash threshold on a whole region is a claim the pixels
   * often do not support: two captures of the same static screen with a
   * blinking caret read as an animation. So the label here requires both
   * halves to agree — the region's pixels changed *and* the tree reports a
   * change inside it — and it names the agreement in the result. A region the
   * pixels moved in but the tree did not is reported separately rather than
   * silently promoted to an animation.
   *
   * The fixture is 16×12 with two 6-row leaves. The lower leaf's texture
   * changes from flat grey to a checkerboard, which the dHash reads as a 66%
   * match — inside HapRay's `moderate_change` band. A gradient fixture was
   * tried first and is wrong for two reasons worth recording: a dHash reads a
   * *horizontal* gradient, so horizontal bands are uniform along the axis it
   * samples and every band hashes identically; and a four-column stripe moves
   * only 8 of 64 bits, an 87.5% match that is above HapRay's 85% threshold, so
   * it is correctly not an animation. A region also has to be at least the 9×8
   * hash grid (72 px), which is why the leaves are 6 rows and not 4.
   */

  const W = 16;
  const H = 12;

  /** Flat grey, or grey with a checkerboard over the lower half. */
  function texture(checker: boolean): RgbaImage {
    const data = new Uint8Array(W * H * 4).fill(150);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (!checker || y < H / 2) continue;
        if (((x >> 1) + (y >> 1)) % 2 !== 0) continue;
        const at = (y * W + x) * 4;
        data[at] = 0; data[at + 1] = 0; data[at + 2] = 0; data[at + 3] = 255;
      }
    }
    return { width: W, height: H, data };
  }

  /** A 16×12 tree whose leaves are two 6-row halves. */
  function halfTree(labels: string[]): unknown {
    return {
      attributes: { type: 'root', bundleName: 'com.demo', bounds: `[0,0][${W},${H}]` },
      children: labels.map((text, index) => ({
        attributes: {
          type: 'Text', bundleName: 'com.demo', text, id: `id-${index}`,
          bounds: `[0,${index * 6}][${W},${(index + 1) * 6}]`, clickable: 'false',
          enabled: 'true', scrollable: 'false',
        },
        children: [],
      })),
    };
  }

  /** A 16×12 scene: a texture, two labels, and the screenshot's dimensions. */
  function halfScene(
    name: string,
    opts: { checker: boolean; labels: string[]; screenshot?: boolean },
  ): string {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    const image = texture(opts.checker);
    if (opts.screenshot !== false) {
      writeFileSync(join(dir, 'screenshot.png'), encodePng(image));
    }
    writeFileSync(join(dir, 'ui.json'), JSON.stringify(halfTree(opts.labels)));
    writeFileSync(join(dir, 'scene.json'), JSON.stringify({
      version: 1,
      app: { packageName: 'com.demo', processNames: ['com.demo'] },
      pids: [], deviceId: 't1',
      capture: {
        startedAtMs: 1000, durationMs: 10,
        collectors: ['hitrace', 'screenshot', 'uitest'],
        screenshot: { width: W, height: H, bytes: 1 },
        uitest: { nodes: opts.labels.length + 1 },
      },
    }));
    return dir;
  }

  /** The lower half's bounds: the leaf both fixtures change. */
  const LOWER = { left: 0, top: 6, right: W, bottom: 12 };

  it('labels a region whose pixels and tree both changed as an animation', async () => {
    // The lower half's text changed (a tree difference with those bounds) and
    // its pixels moved (a checkerboard appeared).
    const a = halfScene('a', { checker: false, labels: ['one', 'two'] });
    const b = halfScene('b', { checker: true, labels: ['one', 'TWO'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.animations).toHaveLength(1);
    expect(diff.animations[0].bounds).toEqual(LOWER);
    expect(diff.animations[0].label).toBe('animation');
    expect(diff.animations[0].treeChanges).toBeGreaterThan(0);
    expect(diff.animations[0].similarity).toBeLessThan(1);
  });

  it('classifies the animation severity from the pixel similarity', async () => {
    const a = halfScene('a', { checker: false, labels: ['one', 'two'] });
    const b = halfScene('b', { checker: true, labels: ['one', 'TWO'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });
    expect(['major_change', 'moderate_change', 'minor_change']).toContain(
      diff.animations[0].severity,
    );
  });

  it('does not label a pixel change the tree did not see', async () => {
    // The pixels moved but the tree is identical: a cursor blink, a video
    // frame, a system clock. Calling that an animation would be a claim about
    // the app's rendering that the tree contradicts.
    const a = halfScene('a', { checker: false, labels: ['one', 'two'] });
    const b = halfScene('b', { checker: true, labels: ['one', 'two'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.animations).toEqual([]);
    expect(diff.pixelOnly).toHaveLength(1);
    expect(diff.pixelOnly[0].bounds).toEqual({ left: 0, top: 0, right: W, bottom: H });
    expect(diff.pixelOnly[0].note).toContain('not labelled');
  });

  it('does not label a tree change the pixels did not see', async () => {
    // Identical screenshots, a node's text changed: the tree changed but the
    // screen did not, which is a rendering defect rather than an animation.
    const a = halfScene('a', { checker: false, labels: ['one', 'two'] });
    const b = halfScene('b', { checker: false, labels: ['one', 'TWO'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });

    expect(diff.animations).toEqual([]);
    expect(diff.pixelOnly).toEqual([]);
  });

  it('reports no animations when the two captures are identical', async () => {
    const a = halfScene('a', { checker: true, labels: ['one', 'two'] });
    const b = halfScene('b', { checker: true, labels: ['one', 'two'] });
    const diff = await compareSceneDirs(a, b, { outDir: out() });
    expect(diff.animations).toEqual([]);
    expect(diff.pixelOnly).toEqual([]);
  });

  it('reports no animations when there are no screenshots to compare', async () => {
    // A tree-only comparison has no pixels, so it cannot claim an animation.
    const a = halfScene('a', { checker: false, labels: ['one', 'two'], screenshot: false });
    const b = halfScene('b', { checker: false, labels: ['one', 'TWO'], screenshot: false });
    const diff = await compareSceneDirs(a, b, { outDir: out() });
    expect(diff.animations).toEqual([]);
    expect(diff.pixelOnly).toEqual([]);
  });
});
