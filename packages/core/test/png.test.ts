import { describe, it, expect } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { decodePng, encodePng, type RgbaImage } from '../src/image/png';

/** Build a minimal PNG from raw scanlines, for one colour type. */
function png(opts: {
  width: number; height: number; colorType: number; bitDepth?: number;
  interlace?: number; rows: Uint8Array;
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
    // 3x1 RGBA, encoded with filter 1 (Sub): each byte minus the byte one
    // pixel to its left. Decodes to (10,0,0,255) (15,0,0,255) (20,0,0,255).
    const rows = new Uint8Array([1, 10, 0, 0, 255, 5, 0, 0, 0, 5, 0, 0, 0]);
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
