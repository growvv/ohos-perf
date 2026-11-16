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
