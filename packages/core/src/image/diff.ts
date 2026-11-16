import { OhosPerfError } from '../errors';
import type { RgbaImage } from './png';

/** An axis-aligned rectangle in screenshot pixels. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The result of comparing two screenshots.
 *
 * `hamming`/`similarity` answer "is the structure the same" (a 64-bit gradient
 * hash is insensitive to small colour shifts); `changedRatio` answers "how much
 * of the picture differs". They can disagree — a solid colour change moves one
 * and not the other — so both are reported and neither is presented as *the*
 * answer.
 */
export interface ImageComparison {
  readonly dhashA: string;
  readonly dhashB: string;
  /** 0..64, the bit distance between the two dHashes. */
  readonly hamming: number;
  /** `1 - hamming/64`. */
  readonly similarity: number;
  /** Fraction of compared pixels whose channels differ by more than `tolerance`. */
  readonly changedRatio: number;
  /** The per-channel threshold actually applied (0..255). */
  readonly tolerance: number;
  /** The downscaled size the pixel comparison ran at. */
  readonly comparedWidth: number;
  readonly comparedHeight: number;
}

/** Default per-channel difference that counts as a change. */
const DEFAULT_TOLERANCE = 8;

/** The pixel comparison never runs wider than this, whatever the capture size. */
const MAX_COMPARED_WIDTH = 256;

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/** Rec. 601 luma, rounded: the greyscale a gradient hash sees. */
function luma(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * Box-downscale to an exact target size.
 *
 * Each destination pixel averages the source pixels it covers. The averaging is
 * integer arithmetic over an explicit rectangle, not a sampling of one source
 * pixel, so a downscale cannot miss a one-pixel line — which matters because
 * the pixel diff is what a caller trusts to say "nothing changed".
 */
function boxResize(
  image: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor((ty * image.height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor((tx * image.width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / targetWidth));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * image.width + x) * 4;
          r += image.data[at]; g += image.data[at + 1];
          b += image.data[at + 2]; a += image.data[at + 3];
          n += 1;
        }
      }
      const at = (ty * targetWidth + tx) * 4;
      out[at] = Math.round(r / n);
      out[at + 1] = Math.round(g / n);
      out[at + 2] = Math.round(b / n);
      out[at + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Greyscale of a resized buffer, as one byte per pixel. */
function greyscale(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const grey = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const at = i * 4;
    grey[i] = luma(data[at], data[at + 1], data[at + 2]);
  }
  return grey;
}

/**
 * A 64-bit difference hash, as 16 hex characters.
 *
 * The image is box-averaged down to 9×8 greyscale and each row's 8 horizontal
 * gradients become 8 bits (`right > left`). Two identical pictures hash the
 * same; a uniform picture hashes to all zeros whatever its colour, because
 * every gradient is zero — a property worth knowing before reading a distance
 * of 0 as "visually identical".
 */
export function dhash(image: RgbaImage): string {
  const resized = boxResize(image, HASH_WIDTH, HASH_HEIGHT);
  const grey = greyscale(resized, HASH_WIDTH, HASH_HEIGHT);
  let hex = '';
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    let byte = 0;
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      if (grey[y * HASH_WIDTH + x + 1] > grey[y * HASH_WIDTH + x]) byte |= 1 << (7 - x);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Count the differing bits of two equal-length hex hashes. */
function hamming(a: string, b: string): number {
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

/**
 * Compare two screenshots.
 *
 * Refuses different dimensions: `bounds` from the UI tree and the pixels here
 * are in the same coordinate space, so a cross-resolution comparison would
 * silently compare different regions. Normalising sizes is a different feature
 * with its own honesty problem (layout differences would read as pixel
 * differences), and it is deliberately absent.
 */
export function compareImages(
  a: RgbaImage,
  b: RgbaImage,
  opts: { tolerance?: number } = {},
): ImageComparison {
  if (a.width !== b.width || a.height !== b.height) {
    throw new OhosPerfError(
      `cannot compare screenshots of different sizes: ${a.width}x${a.height}` +
        ` and ${b.width}x${b.height}; bounds and pixels must share one space`,
      { code: 'UI_SIZE_MISMATCH' },
    );
  }
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new OhosPerfError(
      `tolerance must be an integer in 0..255 (got ${String(opts.tolerance)})`,
      { code: 'UI_BAD_TOLERANCE' },
    );
  }

  const scale = a.width > MAX_COMPARED_WIDTH ? MAX_COMPARED_WIDTH / a.width : 1;
  const comparedWidth = Math.max(1, Math.round(a.width * scale));
  const comparedHeight = Math.max(1, Math.round(a.height * scale));
  const left = boxResize(a, comparedWidth, comparedHeight);
  const right = boxResize(b, comparedWidth, comparedHeight);

  let changed = 0;
  for (let i = 0; i < comparedWidth * comparedHeight; i += 1) {
    const at = i * 4;
    // Alpha is compared too: a transparent-to-opaque change is a visible one.
    if (
      Math.abs(left[at] - right[at]) > tolerance ||
      Math.abs(left[at + 1] - right[at + 1]) > tolerance ||
      Math.abs(left[at + 2] - right[at + 2]) > tolerance ||
      Math.abs(left[at + 3] - right[at + 3]) > tolerance
    ) {
      changed += 1;
    }
  }

  const dhashA = dhash(a);
  const dhashB = dhash(b);
  const distance = hamming(dhashA, dhashB);
  return {
    dhashA,
    dhashB,
    hamming: distance,
    similarity: 1 - distance / 64,
    changedRatio: changed / (comparedWidth * comparedHeight),
    tolerance,
    comparedWidth,
    comparedHeight,
  };
}

/**
 * Draw a 1 px red rectangle on each region's edges, returning a new image.
 *
 * The rectangle marks the *edges*, not the fill: a filled block would hide the
 * very pixels the caller is being shown. Regions are clipped to the image, so
 * a node whose bounds run past the screen still marks its visible part.
 */
export function markRegions(image: RgbaImage, regions: readonly Rect[]): RgbaImage {
  const data = new Uint8Array(image.data);
  const set = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const at = (y * image.width + x) * 4;
    data[at] = 255; data[at + 1] = 0; data[at + 2] = 0; data[at + 3] = 255;
  };
  for (const region of regions) {
    const left = Math.max(0, Math.min(region.left, region.right));
    const right = Math.min(image.width - 1, Math.max(region.left, region.right));
    const top = Math.max(0, Math.min(region.top, region.bottom));
    const bottom = Math.min(image.height - 1, Math.max(region.top, region.bottom));
    if (right < 0 || bottom < 0 || left > image.width - 1 || top > image.height - 1) continue;
    for (let x = left; x <= right; x += 1) {
      set(x, top);
      set(x, bottom);
    }
    for (let y = top; y <= bottom; y += 1) {
      set(left, y);
      set(right, y);
    }
  }
  return { width: image.width, height: image.height, data };
}
