import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { OhosPerfError } from '../errors';

/**
 * A decoded image: row-major RGBA, 4 bytes per pixel.
 *
 * Alpha is always present after decoding, whatever the source colour type was:
 * a grey or RGB PNG is expanded to opaque RGBA so every consumer (hashing, the
 * pixel diff, region marking) handles exactly one layout.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel, length = width*height*4. */
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for the colour types this decoder accepts. */
const CHANNELS: Readonly<Record<number, number>> = {
  0: 1, // greyscale
  2: 3, // RGB
  4: 2, // greyscale + alpha
  6: 4, // RGBA
};

function bad(code: string, message: string): OhosPerfError {
  return new OhosPerfError(message, { code });
}

/** Read one PNG chunk header at `offset`. */
function readChunk(bytes: Uint8Array, offset: number): {
  type: string; body: Uint8Array; next: number;
} {
  if (offset + 8 > bytes.length) {
    throw bad('PNG_TRUNCATED', `PNG is truncated at byte ${offset}: no chunk header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset);
  const type = String.fromCharCode(
    bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
  );
  const bodyStart = offset + 8;
  const bodyEnd = bodyStart + length;
  if (bodyEnd + 4 > bytes.length) {
    throw bad(
      'PNG_TRUNCATED',
      `PNG is truncated inside the ${type} chunk: it claims ${length} bytes,` +
        ` only ${bytes.length - bodyStart - 4} remain`,
    );
  }
  return { type, body: bytes.subarray(bodyStart, bodyEnd), next: bodyEnd + 4 };
}

/** Apply the PNG row filters in place over one decompressed scanline. */
function unfilter(
  filter: number,
  row: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
): void {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] ?? 0 : 0;
    switch (filter) {
      case 0:
        break;
      case 1:
        row[i] = (row[i] + left) & 0xff;
        break;
      case 2:
        row[i] = (row[i] + up) & 0xff;
        break;
      case 3:
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
        break;
      case 4: {
        // Paeth: pick whichever of left/up/up-left is closest to left+up-upLeft.
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[i] = (row[i] + predictor) & 0xff;
        break;
      }
      default:
        throw bad('PNG_BAD_FILTER', `unknown PNG row filter ${filter}`);
    }
  }
}

/** Expand one unfiltered scanline into RGBA. */
function expand(
  row: Uint8Array,
  colourType: number,
  width: number,
  out: Uint8Array,
  outOffset: number,
): void {
  for (let x = 0; x < width; x += 1) {
    const at = outOffset + x * 4;
    switch (colourType) {
      case 0: {
        const grey = row[x];
        out[at] = grey; out[at + 1] = grey; out[at + 2] = grey; out[at + 3] = 255;
        break;
      }
      case 2: {
        out[at] = row[x * 3]; out[at + 1] = row[x * 3 + 1];
        out[at + 2] = row[x * 3 + 2]; out[at + 3] = 255;
        break;
      }
      case 4: {
        const grey = row[x * 2];
        out[at] = grey; out[at + 1] = grey; out[at + 2] = grey; out[at + 3] = row[x * 2 + 1];
        break;
      }
      case 6:
        out[at] = row[x * 4]; out[at + 1] = row[x * 4 + 1];
        out[at + 2] = row[x * 4 + 2]; out[at + 3] = row[x * 4 + 3];
        break;
      default:
        // Unreachable: the colour type was validated before decoding.
        throw bad('PNG_BAD_COLOR_TYPE', `unsupported PNG colour type ${colourType}`);
    }
  }
}

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA.
 *
 * Deliberately narrow: the device writes 8-bit RGB/RGBA and nothing else, so
 * palette, 16-bit and interlaced images are refused by name rather than
 * half-decoded into a plausible-looking wrong image. The five row filters are
 * all implemented, because those do appear in real encoders.
 *
 * A length mismatch after inflation is the truncated-transfer check: the
 * expected size is exactly `height * (1 + bytesPerPixel * width)`, and any
 * other length means the IDAT stream ended early (or was padded). Neither is
 * a picture, so both fail rather than being resized.
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw bad('PNG_BAD_SIGNATURE', 'not a PNG: the 8-byte signature does not match');
    }
  }

  let width: number | undefined;
  let height: number | undefined;
  let bitDepth: number | undefined;
  let colourType: number | undefined;
  let interlace: number | undefined;
  const idat: Uint8Array[] = [];
  let sawEnd = false;

  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    const chunk = readChunk(bytes, offset);
    offset = chunk.next;
    if (chunk.type === 'IHDR') {
      if (chunk.body.length !== 13) {
        throw bad('PNG_BAD_IHDR', `IHDR is ${chunk.body.length} bytes, expected 13`);
      }
      const view = new DataView(
        chunk.body.buffer, chunk.body.byteOffset, chunk.body.byteLength,
      );
      width = view.getUint32(0);
      height = view.getUint32(4);
      bitDepth = chunk.body[8];
      colourType = chunk.body[9];
      interlace = chunk.body[12];
    } else if (chunk.type === 'IDAT') {
      idat.push(chunk.body);
    } else if (chunk.type === 'IEND') {
      sawEnd = true;
      break;
    }
    // Every other chunk (sRGB, sBIT, tEXt, …) is ancillary and skipped.
  }

  if (width === undefined || height === undefined || bitDepth === undefined ||
      colourType === undefined || interlace === undefined) {
    throw bad('PNG_NO_IHDR', 'PNG has no IHDR chunk');
  }
  if (!sawEnd) throw bad('PNG_TRUNCATED', 'PNG has no IEND chunk');
  if (bitDepth !== 8) {
    throw bad('PNG_BAD_BIT_DEPTH', `unsupported PNG bit depth ${bitDepth}; only 8 is read`);
  }
  if (interlace !== 0) {
    throw bad('PNG_INTERLACED', 'interlaced PNG is not supported; re-capture without it');
  }
  const channels = CHANNELS[colourType];
  if (channels === undefined) {
    throw bad('PNG_BAD_COLOR_TYPE', `unsupported PNG colour type ${colourType}`);
  }
  if (width === 0 || height === 0) {
    throw bad('PNG_EMPTY', `PNG has no pixels (${width}x${height})`);
  }

  const rowBytes = channels * width;
  const expected = height * (1 + rowBytes);
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))));
  } catch (err) {
    throw bad(
      'PNG_TRUNCATED',
      `PNG image data is truncated or corrupt: ${(err as Error).message}`,
    );
  }
  if (raw.length !== expected) {
    throw bad(
      'PNG_TRUNCATED',
      `PNG image data is incomplete: inflated ${raw.length} bytes,` +
        ` expected ${expected} for ${width}x${height}`,
    );
  }

  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + rowBytes);
    const filter = raw[start];
    const row = raw.subarray(start + 1, start + 1 + rowBytes);
    unfilter(filter, row, previous, channels);
    expand(row, colourType, width, data, y * width * 4);
    previous = row;
  }
  return { width, height, data };
}

/** Build one PNG chunk: length, type, body, CRC over type+body. */
function chunk(type: string, body: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encode RGBA as an 8-bit RGBA PNG.
 *
 * No ancillary chunks are written — no `tIME`, no `tEXt` — so the bytes depend
 * only on the pixels. That is what lets a marked image be compared byte for
 * byte across runs (D5).
 */
export function encodePng(image: RgbaImage): Uint8Array {
  if (image.data.length !== image.width * image.height * 4) {
    throw bad(
      'PNG_BAD_PIXELS',
      `image data is ${image.data.length} bytes, expected` +
        ` ${image.width * image.height * 4} for ${image.width}x${image.height} RGBA`,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter 0 (None) on every row: the encoder's job is byte-stability, not
  // compression ratio, and a fixed filter keeps the output independent of the
  // pixel values' compressibility.
  const rowBytes = image.width * 4;
  const raw = Buffer.alloc(image.height * (1 + rowBytes));
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (1 + rowBytes)] = 0;
    Buffer.from(image.data.subarray(y * rowBytes, (y + 1) * rowBytes))
      .copy(raw, y * (1 + rowBytes) + 1);
  }

  return new Uint8Array(Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]));
}
