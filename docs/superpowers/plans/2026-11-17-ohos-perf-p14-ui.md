# P14 UI Capture and Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a screenshot beside the existing UI tree, analyze both into reportable metrics, and compare two captures by identity and by pixel.

**Architecture:** A pure-TypeScript PNG codec (`src/image/png.ts`) and two comparators (`src/image/diff.ts`, `src/ui/diff.ts`) sit under a `UiAnalyzer` and a `ui-compare` command. The screenshot is a new collector artifact (`screenshot.png`) written by the existing `UitestCollector` path discipline, gated by a new `ui.capture` capability row.

**Tech Stack:** TypeScript ESM, `node:zlib` for inflate/deflate, `node:sqlite`-free, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-ohos-perf-p14-ui-design.md`

## Global Constraints

- Zero runtime dependencies in `@ohos-perf/core`. `node:zlib` and `node:fs` only.
- Determinism (D5): identical inputs produce byte-identical JSON, PNG and HTML. No `Date.now()` in any analyzer, comparator or encoder.
- Every analyzer metric carries `provenance` (`collector`, `table`, `rows`, `device`) and `fidelity`. A skipped analyzer emits `<id>.degraded` with a reason, never a zero.
- Every unknown-key or shape violation in a parsed document is a typed `OhosPerfError` with a code.
- Unknown collector artifacts are removed on a successful capture that did not request them; a failed capture restores the previous scene byte-for-byte.
- `packages/core/src/index.ts` is the public surface: a new exported value must be added to `packages/core/test/types.test.ts`'s `VALUE_EXPORTS`, and core must be rebuilt (`npm run build -w @ohos-perf/core`) before the CLI sees it.
- Unit suite command: `npm run test:unit`. Device: `npm run test:device` (serial).
- Typecheck: `npm run typecheck -w @ohos-perf/core` and `-w @ohos-perf/cli` (both include tests).

## Review Focus

- **A PNG that is not 8-bit, not RGB(A)/grey, or interlaced.** A decoder that silently mis-decodes produces a plausible wrong image and a wrong diff. It must refuse with the field that was unsupported.
- **A screenshot whose byte length disagrees with its header** (truncated transfer). `decodePng` must fail on a short IDAT stream rather than padding.
- **An inserted node at the start of a sibling list.** Index matching shifts every sibling; identity matching must report exactly one `added`.
- **Two screenshots of different sizes.** The diff must refuse, because `bounds` and pixels would be in different spaces.
- **A scene with a tree but no screenshot** (and the reverse). The analyzer must report the half it has as exact and the missing half as degraded — never zeros for both.

---

### Task 1: PNG decode and encode

**Files:**
- Create: `packages/core/src/image/png.ts`
- Test: `packages/core/test/png.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface RgbaImage {
    readonly width: number;
    readonly height: number;
    /** Row-major RGBA, 4 bytes per pixel, length = width*height*4. */
    readonly data: Uint8Array;
  }
  export function decodePng(bytes: Uint8Array): RgbaImage;
  export function encodePng(image: RgbaImage): Uint8Array;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/png.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, encodePng, type RgbaImage } from '../src/image/png';

/** Build a minimal PNG from raw scanlines, for one colour type. */
function png(opts: {
  width: number; height: number; colorType: number; bitDepth?: number;
  interlace?: number; rows: Uint8Array; extraChunks?: string[];
}): Uint8Array {
  const chunks: Buffer[] = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width, 0); ihdr.writeUInt32BE(opts.height, 4);
  ihdr[8] = opts.bitDepth ?? 8; ihdr[9] = opts.colorType; ihdr[10] = 0;
  ihdr[11] = 0; ihdr[12] = opts.interlace ?? 0;
  chunks.push(sig, chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', deflateSync(Buffer.from(opts.rows))));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

describe('decodePng', () => {
  it('decodes 8-bit RGBA (colour type 6)', () => {
    // 2x1: opaque red, half-alpha green.
    const rows = new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 128]);
    const img = decodePng(png({ width: 2, height: 1, colorType: 6, rows }));
    expect(img.width).toBe(2);
    expect(img.height).toBe(1);
    expect([...img.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
  });

  it('decodes 8-bit RGB (colour type 2) with opaque alpha', () => {
    const rows = new Uint8Array([0, 1, 2, 3, 4, 5, 6]);
    const img = decodePng(png({ width: 2, height: 1, colorType: 2, rows }));
    expect([...img.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });

  it('decodes 8-bit greyscale (colour type 0)', () => {
    const rows = new Uint8Array([0, 10, 200]);
    const img = decodePng(png({ width: 2, height: 1, colorType: 0, rows }));
    expect([...img.data]).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
  });

  it('decodes 8-bit greyscale+alpha (colour type 4)', () => {
    const rows = new Uint8Array([0, 10, 200]);
    const img = decodePng(png({ width: 1, height: 1, colorType: 4, rows }));
    expect([...img.data]).toEqual([10, 10, 10, 200]);
  });

  it('applies all five row filters', () => {
    // 3x1 RGBA, encoded with filter 1 (Sub): each byte minus the pixel to its left.
    const rows = new Uint8Array([1, 10, 0, 0, 255, 5, 255, 0, 0, 5, 0, 0, 0]);
    const img = decodePng(png({ width: 3, height: 1, colorType: 6, rows }));
    expect([...img.data]).toEqual([10, 0, 0, 255, 15, 0, 0, 255, 20, 0, 0, 255]);
  });

  it('refuses a palette image, naming the colour type', () => {
    expect(() => decodePng(png({ width: 1, height: 1, colorType: 3, rows: new Uint8Array([0, 0]) })))
      .toThrow(/colour type 3/);
  });

  it('refuses a 16-bit image, naming the bit depth', () => {
    expect(() => decodePng(png({ width: 1, height: 1, colorType: 0, bitDepth: 16, rows: new Uint8Array([0, 0, 0]) })))
      .toThrow(/bit depth 16/);
  });

  it('refuses an interlaced image', () => {
    expect(() => decodePng(png({ width: 1, height: 1, colorType: 0, interlace: 1, rows: new Uint8Array([0, 1]) })))
      .toThrow(/interlac/i);
  });

  it('refuses a bad signature', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/i);
  });

  it('refuses a truncated IDAT stream rather than padding it', () => {
    const full = png({ width: 2, height: 2, colorType: 6, rows: new Uint8Array(18) });
    // Cut the IDAT payload short: the zlib stream then ends mid-image.
    const cut = full.slice(0, full.length - 20);
    expect(() => decodePng(cut)).toThrow(/truncated|incomplete/i);
  });
});

describe('encodePng', () => {
  it('round-trips through decodePng', () => {
    const image: RgbaImage = {
      width: 2, height: 2,
      data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    };
    expect([...decodePng(encodePng(image)).data]).toEqual([...image.data]);
  });

  it('is byte-identical across calls (no timestamps)', () => {
    const image: RgbaImage = { width: 1, height: 1, data: new Uint8Array([9, 8, 7, 6]) };
    expect([...encodePng(image)]).toEqual([...encodePng(image)]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit packages/core/test/png.test.ts`
Expected: FAIL — `Failed to resolve import "../src/image/png"`.

- [ ] **Step 3: Implement `packages/core/src/image/png.ts`**

Signature as in Interfaces. Rules the tests pin:

- Verify the 8-byte signature; otherwise `OhosPerfError` code `PNG_BAD_SIGNATURE` with `signature` in the message.
- Parse chunks by walking length/type/body/CRC. `IHDR` must be first. Require `IEND`.
- Refuse `bitDepth !== 8` with code `PNG_BAD_BIT_DEPTH` naming the depth, `interlace !== 0` with `PNG_INTERLACED`, and a colour type outside `{0, 2, 4, 6}` with `PNG_BAD_COLOR_TYPE` naming the type.
- Concatenate every `IDAT` body, `inflateSync`, and walk scanlines: one filter byte, then `bytesPerPixel * width` data bytes. Apply filters 0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth exactly as the PNG spec defines them (Paeth uses `a + b - c` with the closest of the three).
- Expected decompressed length is `height * (1 + bytesPerPixel * width)`. Any other length is `PNG_TRUNCATED` naming both lengths — this is what catches a cut transfer.
- Expand to RGBA per colour type (grey replicated, RGB gets 255 alpha).
- `encodePng` writes IHDR (colour type 6, depth 8), a single IDAT with filter 0 rows, IEND — no ancillary chunks, so the bytes depend only on the pixels.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit packages/core/test/png.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/image/png.ts packages/core/test/png.test.ts
git commit -m "feat(core): decode and encode PNG without a native dependency"
```

---

### Task 2: dHash and pixel diff

**Files:**
- Create: `packages/core/src/image/diff.ts`
- Test: `packages/core/test/image-diff.test.ts`

**Interfaces:**
- Consumes: `RgbaImage` from Task 1.
- Produces:
  ```ts
  export interface ImageComparison {
    readonly dhashA: string;      // 16 hex chars
    readonly dhashB: string;
    readonly hamming: number;     // 0..64
    readonly similarity: number;  // 0..1, 1 - hamming/64
    readonly changedRatio: number;// 0..1, fraction of compared pixels over tolerance
    readonly tolerance: number;   // the per-channel threshold actually used
    readonly comparedWidth: number;
    readonly comparedHeight: number;
  }
  export function dhash(image: RgbaImage): string;
  export function compareImages(a: RgbaImage, b: RgbaImage, opts?: { tolerance?: number }): ImageComparison;
  export function markRegions(image: RgbaImage, regions: readonly Rect[]): RgbaImage;
  export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core/test/image-diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compareImages, dhash, markRegions, type Rect } from '../src/image/diff';
import type { RgbaImage } from '../src/image/png';

/** A width×height image whose pixel is chosen by a callback. */
function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
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

  it('has distance 0 for a uniform image and 0 for another uniform image', () => {
    // Every gradient is zero on a uniform image, so both hashes are all zeros.
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
    const edited = image(9, 8, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : half.data[(y * 9 + x) * 4] === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
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
    expect(() => compareImages(half, image(10, 8, () => [0, 0, 0, 255]))).toThrow(/9x8.*10x8|10x8.*9x8/);
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
    const at = (x: number, y: number): number[] => [...marked.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 3)];
    expect(at(2, 3)).toEqual([255, 0, 0]);
    expect(at(8, 7)).toEqual([255, 0, 0]);
    expect(at(5, 3)).toEqual([255, 0, 0]);
    expect(at(5, 5)).toEqual([10, 20, 30]); // interior untouched
  });

  it('clips a region that runs past the image edge', () => {
    const marked = markRegions(base, [{ left: 18, top: 8, right: 99, bottom: 99 }]);
    expect(marked.width).toBe(20);
    expect([...marked.data.slice((8 * 20 + 19) * 4, (8 * 20 + 19) * 4 + 3)]).toEqual([255, 0, 0]);
  });

  it('does not mutate its input', () => {
    markRegions(base, [{ left: 0, top: 0, right: 19, bottom: 9 }]);
    expect([...base.data.slice(0, 3)]).toEqual([10, 20, 30]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --project unit packages/core/test/image-diff.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `packages/core/src/image/diff.ts`**

- `dhash`: box-downscale to 9×8 in greyscale (`0.299r + 0.587g + 0.114b`, rounded), then for each of the 8 rows emit 8 bits: `grey[y][x+1] > grey[y][x]`. Pack row-major into 16 hex characters (high nibble first).
- `compareImages`: require equal dimensions (`UI_SIZE_MISMATCH`); downscale both to at most 256 px wide with the same box filter (integer arithmetic, `Math.round`), comparing `changed` when any channel differs by more than `tolerance` (default 8); `changedRatio = changed / (comparedWidth*comparedHeight)`.
- `markRegions`: copy, then draw a 1 px red rectangle on each edge, clipped to the image.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project unit packages/core/test/image-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/image/diff.ts packages/core/test/image-diff.test.ts
git commit -m "feat(core): compare screenshots by dHash and bounded pixel diff"
```

---

### Task 3: Identity-based tree comparison

**Files:**
- Create: `packages/core/src/ui/diff.ts`
- Modify: `packages/core/src/query/ui.ts` (add `boundsRect`, `attributes` to `UiNode`)
- Test: `packages/core/test/ui-tree-diff.test.ts`

**Interfaces:**
- Consumes: `UiNode` from `query/ui`.
- Produces:
  ```ts
  export interface UiTreeDifference {
    readonly change: 'added' | 'removed' | 'changed';
    readonly path: string;          // e.g. '0.2.1'
    readonly identity: string;
    readonly type: string;
    readonly bounds?: Rect;
    readonly attributes?: Array<{ name: string; before: string; after: string }>;
  }
  export interface UiTreeDiff {
    readonly added: UiTreeDifference[];
    readonly removed: UiTreeDifference[];
    readonly changed: UiTreeDifference[];
    readonly unchanged: number;
  }
  export const IGNORED_ATTRIBUTES: readonly string[];
  export const GEOMETRY_TOLERANCE_PX = 5;
  export function diffTrees(before: readonly UiNode[], after: readonly UiNode[]): UiTreeDiff;
  ```

- [ ] **Step 1: Extend `UiNode`**

Add two fields, both optional so existing readers compile:

```ts
/** Parsed `bounds` (`"[l,t][r,b]"`), or undefined when it did not parse. */
readonly boundsRect?: { left: number; top: number; right: number; bottom: number };
/** Every string attribute the dump carried, for the diff's attribute comparison. */
readonly attributes?: Readonly<Record<string, string>>;
```

`flattenUiTree` fills both. `boundsRect` parses `[l,t][r,b]` with a documented regex; anything else stays `undefined`. Run the existing `ui.get` tests afterwards to prove the new fields change nothing there.

- [ ] **Step 2: Write the failing tests**

`packages/core/test/ui-tree-diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { diffTrees } from '../src/ui/diff';
import { flattenUiTree, type UiNode } from '../src/query/ui';

/** Build a dumpLayout-shaped document from a compact spec. */
function tree(nodes: Array<{ type: string; text?: string; id?: string; bounds?: string; extra?: Record<string, string>; children?: unknown[] }>): unknown {
  return {
    attributes: { type: nodes[0].type },
    children: nodes[0].children ?? [],
  };
}

function node(spec: { type: string; text?: string; id?: string; bounds?: string; extra?: Record<string, string>; children?: unknown[] }): unknown {
  return {
    attributes: {
      type: spec.type, bundleName: 'com.a', abilityName: 'Main',
      text: spec.text ?? '', id: spec.id ?? '',
      bounds: spec.bounds ?? '[0,0][10,10]',
      clickable: 'false', enabled: 'true', scrollable: 'false',
      ...spec.extra,
    },
    children: spec.children ?? [],
  };
}

const flat = (doc: unknown): UiNode[] => flattenUiTree(doc);

describe('diffTrees', () => {
  it('reports nothing for identical trees', () => {
    const a = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'hi' })] }));
    const result = diffTrees(a, a);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toBe(2);
  });

  it('reports an inserted first child as one addition, not a cascade', () => {
    const before = flat(node({ type: 'Root', children: [
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'b' }),
    ] }));
    const after = flat(node({ type: 'Root', children: [
      node({ type: 'Text', text: 'new' }),
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'b' }),
    ] }));
    const result = diffTrees(before, after);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ change: 'added', type: 'Text' });
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('reports a removed node once', () => {
    const before = flat(node({ type: 'Root', children: [
      node({ type: 'Text', text: 'a' }),
      node({ type: 'Text', text: 'gone' }),
    ] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a' })] }));
    const result = diffTrees(before, after);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].attributes).toBeUndefined();
  });

  it('reports a changed attribute with both values', () => {
    const before = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', extra: { opacity: '1' } })] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', extra: { opacity: '0.5' } })] }));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].attributes).toEqual([
      { name: 'opacity', before: '1', after: '0.5' },
    ]);
  });

  it('ignores a geometry change under 5 px', () => {
    const before = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]' })] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[13,12][53,54]' })] }));
    expect(diffTrees(before, after).changed).toEqual([]);
  });

  it('reports a geometry change at or over 5 px with both rects', () => {
    const before = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]' })] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[16,10][50,50]' })] }));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].attributes).toEqual([
      { name: 'bounds', before: '[10,10][50,50]', after: '[16,10][50,50]' },
    ]);
  });

  it('ignores attributes on the documented list', () => {
    const before = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', extra: { rsNode: '1', frameProxy: 'x' } })] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', extra: { rsNode: '2', frameProxy: 'y' } })] }));
    expect(diffTrees(before, after).changed).toEqual([]);
  });

  it('pairs duplicate identities in document order', () => {
    const before = flat(node({ type: 'Root', children: [
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
    ] }));
    const after = flat(node({ type: 'Root', children: [
      node({ type: 'Text', text: 'x', extra: { opacity: '0' } }),
      node({ type: 'Text', text: 'x', extra: { opacity: '1' } }),
    ] }));
    const result = diffTrees(before, after);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].path).toBe('0.0');
  });

  it('carries the node bounds on a changed difference so an image region can be drawn', () => {
    const before = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]', extra: { opacity: '1' } })] }));
    const after = flat(node({ type: 'Root', children: [node({ type: 'Text', text: 'a', bounds: '[10,10][50,50]', extra: { opacity: '0' } })] }));
    expect(diffTrees(before, after).changed[0].bounds).toEqual({ left: 10, top: 10, right: 50, bottom: 50 });
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run --project unit packages/core/test/ui-tree-diff.test.ts`
Expected: FAIL — unresolved import `../src/ui/diff`.

- [ ] **Step 4: Implement `packages/core/src/ui/diff.ts`**

- Identity string: `bundleName|type|id|text` with empty `id`/`text` omitted, so a text change shows up as a changed attribute on a matched node only when `text` is *not* part of identity — which it is. Consequence: a text change is `removed`+`added`. Rule it deliberately and say so in the module doc: text is identity because a label is what the node *is*.
- Walk both trees recursively. For each parent, bucket children by identity, pair same-identity children in document order, and emit the leftovers as `added`/`removed`.
- For a pair, compare every attribute present in either, skipping `IGNORED_ATTRIBUTES`; `bounds` compares per edge with `GEOMETRY_TOLERANCE_PX` and is emitted as one difference carrying both strings.
- Sort each output array by `path` (plain lexicographic), so the result is deterministic.
- `unchanged` counts matched pairs with no differences.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run --project unit packages/core/test/ui-tree-diff.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ui/diff.ts packages/core/src/query/ui.ts packages/core/test/ui-tree-diff.test.ts
git commit -m "feat(core): compare UI trees by node identity, not by index"
```

---

### Task 4: Screenshot collector and capability row

**Files:**
- Create: `packages/core/src/collectors/screenshot.ts`
- Modify: `packages/core/src/device/capability.ts` (`ui.capture` row)
- Modify: `packages/core/src/device/device.ts` (`screenshot?: boolean`)
- Modify: `packages/core/src/ingest/scene.ts` (`screenshotFile`)
- Modify: `packages/core/src/ingest/metadata.ts` (`capture.screenshot`)
- Test: `packages/core/test/screenshot-collector.test.ts`

**Interfaces:**
- Consumes: `Hdc`, `SceneLayout`, `decodePng`.
- Produces:
  ```ts
  export class ScreenshotCollector implements Collector {
    readonly id = 'screenshot';
    readonly provides: CapabilityId[] = ['ui.capture'];
    collect(hdc: Hdc, target: string, opts: { timeoutMs?: number }, layout: SceneLayout): Promise<{ width: number; height: number; bytes: number }>;
  }
  export const DEVICE_SCREENSHOT_PATH = '/data/local/tmp/ohosperf_screen.png';
  ```
  `CollectOptions.screenshot?: boolean`; `SceneLayout.screenshotFile`; `SceneMetadata['capture']['screenshot']?: { width: number; height: number; bytes: number }`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/screenshot-collector.test.ts`: a fake `Hdc` whose `shell` answers `rm -f`, `uitest screenCap -p …` (with and without the `ScreenCap saved to` marker), and `ls -l` (with a size and with `No such file`); `recv` writes a real `encodePng` buffer to the local path. Assert: success returns `{width, height, bytes}` and writes `screenshot.png`; a missing marker throws `SCREENSHOT_FAILED` and leaves no local file; a zero size throws `SCREENSHOT_NO_OUTPUT`; a non-PNG payload throws `SCREENSHOT_BAD_PNG` and removes the local file. Then a capability test asserting `ui.capture` is available when `uitest` is present and carries a reason when it is not.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run --project unit packages/core/test/screenshot-collector.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement**

- Collector mirrors `UitestCollector`: remove the device path, `uitest screenCap -p <path>`, require the marker, `ls -l` and parse the size, `recv`, `decodePng` for the dimensions (a decode failure is `SCREENSHOT_BAD_PNG` and deletes the file).
- `ui.capture` row: `{ id: 'ui.capture', collector: 'uitest', binary: 'uitest' }` — the same gate as `ui.tree`, and the collector's marker check is what proves the command works.
- `Device.collect`: `opts.screenshot === true` requires `ui.capture`, runs the collector beside the others, remembers `screenshotFile` for the failure path, removes it when not requested on success, and writes `capture.screenshot` plus `'screenshot'` in `collectors`.
- `readSceneMetadata` validates `screenshot` as `{ width, height, bytes }` all safe non-negative integers.

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run --project unit packages/core/test/screenshot-collector.test.ts packages/core/test/scene-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/collectors/screenshot.ts packages/core/src/device packages/core/src/ingest packages/core/test/screenshot-collector.test.ts
git commit -m "feat(core): capture a screenshot beside the UI tree"
```

---

### Task 5: The `ui` analyzer

**Files:**
- Create: `packages/core/src/analyze/ui.ts`
- Modify: `packages/core/src/analyze/types.ts` (`ui?: UiNode[]`, `screenshot?: RgbaImage`)
- Modify: `packages/core/src/analyze/engine.ts` (register)
- Test: `packages/core/test/analyze-ui.test.ts`

**Interfaces:**
- Consumes: `UiNode[]`, `RgbaImage`, `dhash`.
- Produces: `export class UiAnalyzer implements Analyzer { readonly id = 'ui'; readonly requires: CapabilityId[] = []; }` with metrics `ui.nodes.count`, `ui.nodes.clickable`, `ui.nodes.text`, `ui.tree.depth.max`, `ui.screenshot.width`, `ui.screenshot.height`, `ui.screenshot.dhash`.

- [ ] **Step 1: Write the failing tests**

Cover: both artifacts present → every metric `exact`, provenance `collector: 'uitest'`, `table: 'ui.json'`; tree only → tree metrics exact and `ui.screenshot.width`/`height`/`dhash` degraded with `no screenshot in this scene`; screenshot only → image metrics exact and `ui.nodes.count` degraded; neither → one `ui.degraded` proxy plus a `no_data` evidence item naming both artifacts. Assert the metrics array is sorted by `id`.

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project unit packages/core/test/analyze-ui.test.ts`

- [ ] **Step 3: Implement** — read `ctx.ui` and `ctx.screenshot`; emit the exact/degraded split above; evidence: one `ui_tree` item with the node count and depth when a tree exists.

- [ ] **Step 4: Wire the context.** The CLI's analyze path reads `ui.json` when `declared('uitest')` (already does) and `screenshot.png` when `declared('screenshot')`, decoding it with `decodePng`. A decode failure yields a degraded image half with the decoder's message, never a crash.

- [ ] **Step 5: Run and confirm pass**, then rebuild core and run the full unit suite:
`npm run build -w @ohos-perf/core && npm run test:unit`

- [ ] **Step 6: Commit** — `feat(core): analyze the UI tree and screenshot`

---

### Task 6: `ui-compare` and the CLI surface

**Files:**
- Create: `packages/core/src/ui/compare.ts` (the `UiDiff` model and `compareScenes`)
- Create: `packages/core/src/report/ui-html.ts` (the self-contained diff page)
- Create: `packages/cli/src/commands.ts` addition + `packages/cli/src/program.ts` + `packages/cli/src/deps.ts`
- Modify: `packages/core/src/query/registry.ts` (`ui.tree`)
- Test: `packages/core/test/ui-compare.test.ts`, `packages/cli/test/ui-compare.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UiDiff {
    schemaVersion: 1;
    a: { dir: string; screenshot: { width: number; height: number } | null; tree: { nodes: number } | null };
    b: { ...same };
    image: ImageComparison | null;
    tree: UiTreeDiff | null;
    regions: Rect[];
    degraded: string[];
  }
  export function compareSceneDirs(a: string, b: string): Promise<UiDiff>;
  export function renderUiDiffHtml(diff: UiDiff): string;
  ```
- CLI: `ohos-perf ui-compare <a> <b> --out <dir> [--json]`.

- [ ] **Step 1: Write the failing tests.** `compareSceneDirs` on two temp scene dirs built with `encodePng` + a `ui.json`: identical → zero differences; one inserted node → one `added`; different sizes → `UI_SIZE_MISMATCH`; missing screenshot → `UI_MISSING_ARTIFACT` naming the side; determinism → two calls produce identical JSON. CLI tests: argument validation before any IO, exit 0 on a made comparison (including identical), exit 1 when it could not be made, `--json` shape, and the four files written.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement `compareScenes`** — read both `scene.json`s, `ui.json`s and `screenshot.png`s; decode; run `compareImages` and `diffTrees`; collect `regions` from the changed differences' `bounds`; write the four output files; `degraded` names an artifact only one side has, without failing the comparison.

- [ ] **Step 4: Implement `renderUiDiffHtml`** — no scripts, inline CSS, `<img src="ui-diff-marked-a.png">`, a table of differences with `change`, `path`, `type` and the attribute pairs, and the image numbers with the tolerance stated.

- [ ] **Step 5: Wire the CLI** — the `ui-compare` command, `deps.uiCompare`, the help list, and the `run` stub style the other commands use.

- [ ] **Step 6: Run and confirm pass**, then `npm run typecheck -w @ohos-perf/core && npm run typecheck -w @ohos-perf/cli && npm run test:unit`.

- [ ] **Step 7: Commit** — `feat(cli): compare two captures by UI tree and screenshot`

---

### Task 7: Report integration, device test, docs and release `0.9.0`

**Files:**
- Modify: `packages/core/src/report/model.ts` (`ui` section title), `packages/cli/src/commands.ts` (copy `assets/screenshot.png`)
- Create: `packages/core/test/ui-capture.device.test.ts`
- Modify: `README.md`, `site/index.html`, `skill/ohos-perf/SKILL.md`, `CHANGELOG.md`, the three manifests, `package-lock.json`
- Test: the unit suite and the device project

- [ ] **Step 1:** Report integration test: a scene with a screenshot renders `<img src="assets/screenshot.png">` and the file is copied; a scene without one renders the degraded reason and no `<img>`.
- [ ] **Step 2:** Device test: `collect --uitest --screenshot` on the attached device, assert `screenshot.png` decodes with the dimensions `scene.json` recorded, and that `analyze` reports `ui.nodes.count > 0`.
- [ ] **Step 3:** Docs — README `## UI capture and diff` plus `--screenshot`/`ui-compare` in the CLI list and roadmap P14 → `shipped in 0.9.0`; site P14 card and roadmap row; skill `## UI capture and diff`; CHANGELOG `## 0.9.0`.
- [ ] **Step 4:** Bump the three manifests and the cli→core pin to `0.9.0`, rebuild both packages, run the unit suite, both typechecks and the device project.
- [ ] **Step 5:** Commit, tag `v0.9.0`, push `master --tags`, create the GitHub release.

## Self-review notes

- Spec coverage: capture (Task 4), codec (Task 1), image diff (Task 2), tree diff (Task 3), analyzer (Task 5), `ui-compare` + queries + CLI (Task 6), report + docs + release (Task 7). The spec's `ui.diff` query is deliberately dropped in favour of reading `ui-diff.json` from the output directory: a query registry entry would have to locate a file outside the scene, which no other query does. Ruling recorded here rather than silently omitted.
