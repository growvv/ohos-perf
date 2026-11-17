import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/hap/crc';

/**
 * A real ZIP writer for tests of the HAP reader.
 *
 * The reader is exercised against the format, not against itself: this writes
 * local headers, a central directory and an EOCD the way a packaging tool
 * does, so a reader bug shows up as a failed read rather than as two halves
 * of one mistake agreeing. It can also emit the malformed shapes the reader
 * must refuse (a corrupt payload, an encrypted entry, a ZIP64 sentinel).
 */

export interface TestEntry {
  name: string;
  data?: Uint8Array;
  /** Overrides the stored method; the payload is still deflated when 8. */
  method?: number;
  /** Flips a payload byte after the CRC was computed. */
  corrupt?: boolean;
  /** Sets the encrypted bit in the local and central headers. */
  encrypted?: boolean;
  /** Overrides the recorded uncompressed size (ZIP64 sentinel). */
  sizeOverride?: number;
}

const encoder = new TextEncoder();

export function makeZip(entries: TestEntry[], opts: { omitEocd?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(raw))) : raw;
    const name = encoder.encode(entry.name);
    const crc = crc32(raw);
    const flags = entry.encrypted === true ? 0x0001 : 0;

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    if (entry.corrupt === true) local[30 + name.length]! ^= 0xff;
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.sizeOverride ?? raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, ...(opts.omitEocd === true ? [] : [eocd])];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}
