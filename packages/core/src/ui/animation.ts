import { dhash, type Rect } from '../image/diff';
import type { RgbaImage } from '../image/png';

/**
 * Animation labelling for a start/end capture pair (HapRay parity row 31).
 *
 * Ported from `ui_detector/image_comparator.py` and the label bands in
 * `analyze/ui_analyzer.py`: crop a region from both screenshots, compare their
 * dHashes, and call the region an animation when the similarity falls under
 * 85%. The bands are HapRay's — `major_change` under 50, `moderate_change`
 * under 70, `minor_change` under 85 — and are kept so a reader who knows
 * HapRay's numbers reads the same ones here.
 *
 * ## Why this is narrower than HapRay
 *
 * HapRay's label rests on pixels alone, and pixels alone are not evidence of
 * an animation. A blinking text cursor, a system clock in the status bar and a
 * video frame all move under a region the app never re-rendered; conversely a
 * node the tree added but the screen never painted is a rendering defect, not
 * an animation. So a region is labelled only when *both* the pixels and the
 * tree moved inside it, and each half is reported so the caller can see the
 * agreement rather than take the label on trust. A pixel-only movement is
 * returned separately — it is a real observation, just not this label.
 *
 * ## Resolution dependence
 *
 * The dHash is computed at a fixed 9×8 grid, so a region smaller than that
 * grid cannot express its own detail: two 3×3 regions hash identically
 * whatever they contain. Regions below {@link MIN_HASH_PIXELS} are therefore
 * not labelled, and say so in `unmeasured`.
 */

/** HapRay's similarity bands, as percentages. */
export const ANIMATION_BANDS = {
  major: 50,
  moderate: 70,
  minor: 85,
} as const;

/** A region smaller than this cannot fill the 9×8 hash grid. */
export const MIN_HASH_PIXELS = 9 * 8;

export type AnimationSeverity = 'major_change' | 'moderate_change' | 'minor_change';

/** How much the pixels inside one region moved between the two captures. */
export interface RegionPixelChange {
  readonly bounds: Rect;
  /** 0..1; 1 means the two hashes are identical. */
  readonly similarity: number;
  /** Fraction of the region's pixels whose channels differ by more than the tolerance. */
  readonly changedRatio: number;
  readonly dhashA: string;
  readonly dhashB: string;
}

/** A region both halves agree moved: an animation label. */
export interface AnimationLabel extends RegionPixelChange {
  readonly label: 'animation';
  readonly severity: AnimationSeverity;
  /** Tree differences whose bounds fall inside this region. */
  readonly treeChanges: number;
}

/** A region the pixels moved in while the tree did not. */
export interface PixelOnlyChange extends RegionPixelChange {
  readonly note: 'pixels changed, tree did not: not labelled an animation';
}

/** A region that was skipped, and why. */
export interface UnmeasuredRegion {
  readonly bounds: Rect;
  readonly reason: string;
}

export interface AnimationAnalysis {
  readonly animations: AnimationLabel[];
  readonly pixelOnly: PixelOnlyChange[];
  readonly unmeasured: UnmeasuredRegion[];
}

/**
 * HapRay's severity band for a similarity percentage.
 *
 * Returns `undefined` at or above the 85% band: HapRay calls that
 * `no_change`, and a label for no change is not an animation.
 */
export function animationSeverity(similarityPercent: number): AnimationSeverity | undefined {
  if (similarityPercent < ANIMATION_BANDS.major) return 'major_change';
  if (similarityPercent < ANIMATION_BANDS.moderate) return 'moderate_change';
  if (similarityPercent < ANIMATION_BANDS.minor) return 'minor_change';
  return undefined;
}

/**
 * Crop a region out of an image.
 *
 * `right` and `bottom` are exclusive, matching `bounds` as `uitest` writes it
 * (`[0,0][8,4]` on an 8×4 screen). A region is clipped to the image rather
 * than refused: a node whose bounds run past the screen still has a visible
 * part, and that part is what the capture can speak about.
 */
export function cropRegion(image: RgbaImage, rect: Rect): RgbaImage {
  const left = Math.max(0, Math.min(rect.left, rect.right));
  const right = Math.min(image.width, Math.max(rect.left, rect.right));
  const top = Math.max(0, Math.min(rect.top, rect.bottom));
  const bottom = Math.min(image.height, Math.max(rect.top, rect.bottom));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** The differing bits of two equal-length hex hashes. */
function hammingHex(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor !== 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Compare one region across the two captures, or `undefined` when too small. */
export function compareRegion(
  a: RgbaImage,
  b: RgbaImage,
  rect: Rect,
  tolerance: number,
): RegionPixelChange | undefined {
  const left = cropRegion(a, rect);
  const right = cropRegion(b, rect);
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  if (width * height < MIN_HASH_PIXELS) return undefined;

  const dhashA = dhash(left);
  const dhashB = dhash(right);
  let changed = 0;
  let compared = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * left.width + x) * 4;
      const bt = (y * right.width + x) * 4;
      compared += 1;
      if (
        Math.abs(left.data[at] - right.data[bt]) > tolerance ||
        Math.abs(left.data[at + 1] - right.data[bt + 1]) > tolerance ||
        Math.abs(left.data[at + 2] - right.data[bt + 2]) > tolerance ||
        Math.abs(left.data[at + 3] - right.data[bt + 3]) > tolerance
      ) {
        changed += 1;
      }
    }
  }
  return {
    bounds: rect,
    similarity: 1 - hammingHex(dhashA, dhashB) / 64,
    changedRatio: compared === 0 ? 0 : changed / compared,
    dhashA,
    dhashB,
  };
}

/**
 * Label the regions both halves agree moved.
 *
 * `treeRegions` are the bounds the tree diff reported, each with its count of
 * differences; `pixelOnlyBounds` is where to look when the tree reported
 * nothing at all — the whole screen, because there is no node to narrow it to.
 * A region whose pixels moved and whose tree did not is returned in
 * `pixelOnly`, never promoted.
 */
export function analyseAnimations(
  a: RgbaImage,
  b: RgbaImage,
  treeRegions: ReadonlyArray<{ bounds: Rect; changes: number }>,
  pixelOnlyBounds: Rect | undefined,
  tolerance: number,
): AnimationAnalysis {
  const animations: AnimationLabel[] = [];
  const pixelOnly: PixelOnlyChange[] = [];
  const unmeasured: UnmeasuredRegion[] = [];

  const consider = (
    bounds: Rect,
    treeChanges: number,
  ): void => {
    const pixels = compareRegion(a, b, bounds, tolerance);
    if (pixels === undefined) {
      unmeasured.push({
        bounds,
        reason:
          `the region is smaller than the ${MIN_HASH_PIXELS}-pixel dHash grid, ` +
          'so its pixels cannot be compared',
      });
      return;
    }
    // A region that did not change is not an animation and not a finding.
    if (pixels.changedRatio === 0) return;

    if (treeChanges === 0) {
      pixelOnly.push({
        ...pixels,
        note: 'pixels changed, tree did not: not labelled an animation',
      });
      return;
    }
    const severity = animationSeverity(pixels.similarity * 100);
    if (severity === undefined) return;
    animations.push({ ...pixels, label: 'animation', severity, treeChanges });
  };

  for (const region of treeRegions) consider(region.bounds, region.changes);
  if (treeRegions.length === 0 && pixelOnlyBounds !== undefined) {
    consider(pixelOnlyBounds, 0);
  }

  const order = (x: { bounds: Rect }, y: { bounds: Rect }): number =>
    x.bounds.top - y.bounds.top ||
    x.bounds.left - y.bounds.left ||
    x.bounds.bottom - y.bounds.bottom ||
    x.bounds.right - y.bounds.right;
  animations.sort(order);
  pixelOnly.sort(order);
  unmeasured.sort(order);

  return { animations, pixelOnly, unmeasured };
}
