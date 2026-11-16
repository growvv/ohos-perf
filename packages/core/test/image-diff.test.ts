import { describe, it, expect } from 'vitest';
import { compareImages, dhash, markRegions, type Rect } from '../src/image/diff';
import type { RgbaImage } from '../src/image/png';

/** A width×height image whose pixel is chosen by a callback. */
function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = (y * width + x) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = a;
    }
  }
  return { width, height, data };
}

const black = image(9, 8, () => [0, 0, 0, 255]);
const white = image(9, 8, () => [255, 255, 255, 255]);
/** Left half black, right half white: a hard vertical edge. */
const half = image(9, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

describe('dhash', () => {
  it('returns 16 hex characters', () => {
    expect(dhash(black)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('has distance 0 for identical images', () => {
    expect(compareImages(half, half).hamming).toBe(0);
    expect(compareImages(half, half).similarity).toBe(1);
  });

  it('hashes two uniform images alike, because every gradient is zero', () => {
    expect(dhash(black)).toBe(dhash(white));
  });

  it('reports a full distance for a mirrored gradient', () => {
    const left = image(9, 8, (x) => [x * 30, x * 30, x * 30, 255]);
    const right = image(9, 8, (x) => [255 - x * 30, 255 - x * 30, 255 - x * 30, 255]);
    expect(compareImages(left, right).hamming).toBe(64);
    expect(compareImages(left, right).similarity).toBe(0);
  });

  it('is symmetric', () => {
    const a = compareImages(half, black);
    const b = compareImages(black, half);
    expect(a.hamming).toBe(b.hamming);
    expect(a.changedRatio).toBe(b.changedRatio);
  });
});

describe('compareImages', () => {
  it('reports zero changed pixels for identical images', () => {
    expect(compareImages(half, half).changedRatio).toBe(0);
  });

  it('reports the changed ratio for a known one-pixel edit', () => {
    const edited: RgbaImage = {
      width: half.width,
      height: half.height,
      data: new Uint8Array(half.data),
    };
    // Flip the top-left pixel to white; everything else is untouched.
    edited.data[0] = 255; edited.data[1] = 255; edited.data[2] = 255;
    const result = compareImages(half, edited);
    expect(result.changedRatio).toBeCloseTo(1 / 72, 6);
  });

  it('treats a change inside the tolerance as unchanged', () => {
    const near = image(9, 8, () => [4, 4, 4, 255]);
    expect(compareImages(black, near, { tolerance: 8 }).changedRatio).toBe(0);
  });

  it('reports the tolerance it used', () => {
    expect(compareImages(half, half).tolerance).toBe(8);
    expect(compareImages(half, half, { tolerance: 3 }).tolerance).toBe(3);
  });

  it('refuses images of different sizes', () => {
    expect(() => compareImages(half, image(10, 8, () => [0, 0, 0, 255])))
      .toThrow(/9x8.*10x8|10x8.*9x8/);
  });

  it('compares large images through the same bounded downscale', () => {
    const big = image(1024, 768, (x) => (x < 512 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const bigMirror = image(1024, 768, (x) => (x < 512 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const result = compareImages(big, bigMirror);
    expect(result.comparedWidth).toBeLessThanOrEqual(256);
    expect(result.changedRatio).toBe(1);
  });
});

describe('markRegions', () => {
  const base = image(20, 10, () => [10, 20, 30, 255]);

  it('draws a red rectangle on every edge of the region', () => {
    const regions: Rect[] = [{ left: 2, top: 3, right: 8, bottom: 7 }];
    const marked = markRegions(base, regions);
    const at = (x: number, y: number): number[] =>
      [...marked.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 3)];
    expect(at(2, 3)).toEqual([255, 0, 0]);
    expect(at(8, 7)).toEqual([255, 0, 0]);
    expect(at(5, 3)).toEqual([255, 0, 0]);
    expect(at(5, 5)).toEqual([10, 20, 30]); // interior untouched
  });

  it('clips a region that runs past the image edge', () => {
    const marked = markRegions(base, [{ left: 18, top: 8, right: 99, bottom: 99 }]);
    expect(marked.width).toBe(20);
    expect([...marked.data.slice((8 * 20 + 19) * 4, (8 * 20 + 19) * 4 + 3)])
      .toEqual([255, 0, 0]);
  });

  it('does not mutate its input', () => {
    markRegions(base, [{ left: 0, top: 0, right: 19, bottom: 9 }]);
    expect([...base.data.slice(0, 3)]).toEqual([10, 20, 30]);
  });
});
