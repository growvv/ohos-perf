import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OhosPerfError } from '../errors';
import { compareImages, markRegions, type ImageComparison, type Rect } from '../image/diff';
import { analyseAnimations, type AnimationAnalysis } from './animation';
import { decodePng, encodePng, type RgbaImage } from '../image/png';
import { createSceneLayout } from '../ingest/scene';
import { readSceneMetadata } from '../ingest/metadata';
import { readUiTree } from '../query/ui';
import { diffTrees, type UiTreeDiff, type UiTreeDifference } from './diff';
import { renderUiDiffHtml } from '../report/ui-html';

/** What one side of the comparison contained, as the page and JSON report it. */
export interface UiDiffSide {
  readonly dir: string;
  /** `scene.json`'s capture start, copied as an input; absent without metadata. */
  readonly startedAtMs?: number;
  readonly screenshot: { readonly width: number; readonly height: number } | null;
  readonly tree: { readonly nodes: number } | null;
}

/**
 * The result of comparing two captured scenes.
 *
 * `image` and `tree` are `null` only when neither side has that artifact — a
 * comparison of two tree-only captures has no image, and saying so in
 * `degraded` is more useful than failing. A missing artifact on *one* side is
 * an error, because a missing screen is not an unchanged screen.
 */
export interface UiDiff {
  readonly schemaVersion: 1;
  readonly a: UiDiffSide;
  readonly b: UiDiffSide;
  readonly image: ImageComparison | null;
  readonly tree: UiTreeDiff | null;
  readonly regions: Rect[];
  /**
   * Regions both the pixels and the tree agree moved between the two captures
   * (HapRay parity row 31). Empty for a tree-only comparison, which has no
   * pixels to compare.
   */
  readonly animations: AnimationAnalysis['animations'];
  /**
   * Regions whose pixels moved while the tree did not: a cursor blink, a video
   * frame, a system clock. Reported, never labelled an animation.
   */
  readonly pixelOnly: AnimationAnalysis['pixelOnly'];
  /** Regions too small for the dHash grid to say anything about. */
  readonly unmeasuredRegions: AnimationAnalysis['unmeasured'];
  readonly degraded: string[];
}

/** Where `compareSceneDirs` writes its artifacts. */
export interface UiCompareOptions {
  /** Output directory for the four files. */
  readonly outDir: string;
  /** Per-channel pixel tolerance, 0..255; defaults to the image diff's 8. */
  readonly tolerance?: number;
}

const FILES = {
  json: 'ui-diff.json',
  html: 'ui-diff.html',
  markedA: 'ui-diff-marked-a.png',
  markedB: 'ui-diff-marked-b.png',
} as const;

function missing(side: 'a' | 'b', artifact: string, dir: string): OhosPerfError {
  return new OhosPerfError(
    `side ${side} (${dir}) has no ${artifact}; a comparison needs both sides to ` +
      'carry it, and a missing capture is not an unchanged one',
    { code: 'UI_MISSING_ARTIFACT' },
  );
}

function readImage(path: string): RgbaImage {
  try {
    return decodePng(new Uint8Array(readFileSync(path)));
  } catch (err) {
    throw new OhosPerfError(
      `${path} is not a readable PNG: ${(err as Error).message}`,
      { code: 'UI_BAD_SCREENSHOT', cause: err },
    );
  }
}

/** Every difference's rect, deduplicated and sorted, so the marks are stable. */
function collectRegions(tree: UiTreeDiff | null): Rect[] {
  if (tree === null) return [];
  const all: UiTreeDifference[] = [...tree.added, ...tree.removed, ...tree.changed];
  const seen = new Set<string>();
  const regions: Rect[] = [];
  for (const difference of all) {
    if (difference.bounds === undefined) continue;
    const rect = difference.bounds;
    const key = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    regions.push(rect);
  }
  regions.sort(
    (x, y) =>
      x.top - y.top || x.left - y.left || x.bottom - y.bottom || x.right - y.right,
  );
  return regions;
}

/** The same regions, with how many tree differences each one holds. */
function regionCounts(tree: UiTreeDiff): Array<{ bounds: Rect; changes: number }> {
  const counts = new Map<string, { bounds: Rect; changes: number }>();
  const all: UiTreeDifference[] = [...tree.added, ...tree.removed, ...tree.changed];
  for (const difference of all) {
    if (difference.bounds === undefined) continue;
    const rect = difference.bounds;
    const key = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
    const found = counts.get(key);
    if (found === undefined) counts.set(key, { bounds: rect, changes: 1 });
    else found.changes += 1;
  }
  return [...counts.values()];
}

/** Read one side's screenshot and tree, enforcing the one-sided-missing rule. */
function readSide(
  dir: string,
  side: 'a' | 'b',
): { image: RgbaImage | undefined; nodes: ReturnType<typeof readUiTree> } {
  const layout = createSceneLayout(dir);
  const hasImage = existsSync(layout.screenshotFile);
  const hasTree = existsSync(layout.uiFile);
  return {
    image: hasImage ? readImage(layout.screenshotFile) : undefined,
    nodes: hasTree ? readUiTree(layout.uiFile, { full: true }) : undefined,
  };
}

/**
 * Compare two scene directories by UI tree and screenshot.
 *
 * Both sides are read before anything is written, so a failure leaves no
 * half-written bundle. `ui-diff.json` carries no clock of its own — the two
 * `capture.startedAtMs` values are copied from each side's `scene.json` — so
 * two runs over the same inputs are byte-identical (D5), as are the marked
 * PNGs, whose encoder writes no ancillary chunks.
 */
export async function compareSceneDirs(
  a: string,
  b: string,
  opts: UiCompareOptions,
): Promise<UiDiff> {
  const dirA = resolve(a);
  const dirB = resolve(b);
  const left = readSide(dirA, 'a');
  const right = readSide(dirB, 'b');

  const degraded: string[] = [];

  let image: ImageComparison | null = null;
  if (left.image === undefined && right.image === undefined) {
    degraded.push('no screenshot.png on either side');
  } else if (left.image === undefined) {
    throw missing('a', 'screenshot.png', dirA);
  } else if (right.image === undefined) {
    throw missing('b', 'screenshot.png', dirB);
  } else {
    image = compareImages(left.image, right.image,
      opts.tolerance === undefined ? {} : { tolerance: opts.tolerance });
  }

  let tree: UiTreeDiff | null = null;
  if (left.nodes === undefined && right.nodes === undefined) {
    degraded.push('no ui.json on either side');
  } else if (left.nodes === undefined) {
    throw missing('a', 'ui.json', dirA);
  } else if (right.nodes === undefined) {
    throw missing('b', 'ui.json', dirB);
  } else {
    tree = diffTrees(left.nodes, right.nodes);
  }

  const side = (
    dir: string,
    image: RgbaImage | undefined,
    nodes: readonly unknown[] | undefined,
  ): UiDiffSide => {
    const startedAtMs = readSceneMetadata(createSceneLayout(dir))?.capture?.startedAtMs;
    return {
      dir,
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      screenshot: image === undefined ? null : { width: image.width, height: image.height },
      tree: nodes === undefined ? null : { nodes: nodes.length },
    };
  };

  const regions = collectRegions(tree);
  // Animation labelling needs both halves: pixels to say the screen moved and
  // a tree diff to say the app rendered it. A tree-only comparison reports
  // nothing rather than labelling from a diff alone.
  const animations: AnimationAnalysis =
    left.image === undefined || right.image === undefined || tree === null
      ? { animations: [], pixelOnly: [], unmeasured: [] }
      : analyseAnimations(
          left.image,
          right.image,
          regionCounts(tree),
          { left: 0, top: 0, right: left.image.width, bottom: left.image.height },
          opts.tolerance ?? 8,
        );
  const diff: UiDiff = {
    schemaVersion: 1,
    a: side(dirA, left.image, left.nodes),
    b: side(dirB, right.image, right.nodes),
    image,
    tree,
    regions,
    animations: animations.animations,
    pixelOnly: animations.pixelOnly,
    unmeasuredRegions: animations.unmeasured,
    degraded,
  };

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, FILES.json), `${JSON.stringify(diff, null, 2)}\n`);
  writeFileSync(join(outDir, FILES.html), renderUiDiffHtml(diff));
  // The marked images exist only when there was something to compare; a
  // tree-only comparison has no pixels to mark, and a page pointing at a
  // missing file would be a broken image.
  if (left.image !== undefined) {
    writeFileSync(
      join(outDir, FILES.markedA),
      encodePng(markRegions(left.image, regions)),
    );
  }
  if (right.image !== undefined) {
    writeFileSync(
      join(outDir, FILES.markedB),
      encodePng(markRegions(right.image, regions)),
    );
  }

  return diff;
}

/** The artifact file names, for a caller reporting what was written. */
export const UI_DIFF_FILES: readonly string[] = [
  FILES.json, FILES.html, FILES.markedA, FILES.markedB,
];
