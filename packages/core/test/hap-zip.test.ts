import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isZip, openZip } from '../src/hap/zip';
import { crc32 } from '../src/hap/crc';

/**
 * A real ZIP writer for the tests.
 *
 * The reader is exercised against the format, not against itself: these
 * helpers write local headers, a central directory and an EOCD exactly as a
 * packaging tool does, so a reader bug shows up as a failed read rather than
 * as two halves of one mistake agreeing.
 */

interface TestEntry {
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

function buildZip(entries: TestEntry[], opts: { omitEocd?: boolean } = {}): Uint8Array {
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

describe('openZip', () => {
  it('reads a stored entry byte for byte', () => {
    const data = encoder.encode('stored payload');
    const archive = openZip(buildZip([{ name: 'a.txt', data, method: 0 }]));
    expect(archive.entries).toHaveLength(1);
    expect(archive.read(archive.entries[0]!)).toEqual(data);
  });

  it('reads a deflated entry byte for byte', () => {
    const data = encoder.encode('x'.repeat(5000));
    const archive = openZip(buildZip([{ name: 'big.txt', data, method: 8 }]));
    expect(new TextDecoder().decode(archive.read(archive.entries[0]!))).toBe('x'.repeat(5000));
  });

  it('keeps the central-directory order and reports sizes and CRC', () => {
    const archive = openZip(buildZip([
      { name: 'b.txt', data: encoder.encode('bb') },
      { name: 'a.txt', data: encoder.encode('aa') },
    ]));
    expect(archive.entries.map((entry) => entry.name)).toEqual(['b.txt', 'a.txt']);
    expect(archive.entries[0]).toMatchObject({ size: 2, method: 8 });
    expect(archive.entries[0]!.crc32).toBe(crc32(encoder.encode('bb')));
  });

  it('omits directory entries', () => {
    const archive = openZip(buildZip([
      { name: 'dir/', data: new Uint8Array(0), method: 0 },
      { name: 'dir/file.txt', data: encoder.encode('hi') },
    ]));
    expect(archive.entries.map((entry) => entry.name)).toEqual(['dir/file.txt']);
  });

  it('recognises a ZIP and rejects a PNG', () => {
    expect(isZip(buildZip([{ name: 'a', data: encoder.encode('a') }]))).toBe(true);
    expect(isZip(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isZip(new Uint8Array(0))).toBe(false);
  });

  it('refuses a file with no end-of-central-directory record', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a') }], { omitEocd: true });
    expect(() => openZip(bytes)).toThrow(expect.objectContaining({ code: 'HAP_NOT_ZIP' }));
  });

  it('refuses a payload whose CRC disagrees, naming the entry', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('payload'), corrupt: true }]);
    const archive = openZip(bytes);
    expect(() => archive.read(archive.entries[0]!)).toThrow(
      expect.objectContaining({ code: 'HAP_CRC_MISMATCH' }),
    );
    expect(() => archive.read(archive.entries[0]!)).toThrow(/a\.txt/);
  });

  it('refuses an unsupported compression method, naming it', () => {
    // Method 12 is bzip2: readable by some tools, not by this one.
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a'), method: 12 }]);
    expect(() => openZip(bytes)).toThrow(expect.objectContaining({ code: 'HAP_UNSUPPORTED_METHOD' }));
    expect(() => openZip(bytes)).toThrow(/12/);
  });

  it('refuses an encrypted entry, naming it', () => {
    const bytes = buildZip([{ name: 'secret.txt', data: encoder.encode('a'), encrypted: true }]);
    expect(() => openZip(bytes)).toThrow(expect.objectContaining({ code: 'HAP_ENCRYPTED_ENTRY' }));
    expect(() => openZip(bytes)).toThrow(/secret\.txt/);
  });

  it('refuses a ZIP64 archive rather than half-reading it', () => {
    const bytes = buildZip([{ name: 'huge.bin', data: encoder.encode('a'), sizeOverride: 0xffffffff }]);
    expect(() => openZip(bytes)).toThrow(expect.objectContaining({ code: 'HAP_ZIP64_UNSUPPORTED' }));
  });

  it('refuses an entry name that would escape a directory', () => {
    for (const name of ['../evil.txt', 'a/../../evil.txt', 'C:/evil.txt']) {
      const bytes = buildZip([{ name, data: encoder.encode('a') }]);
      expect(() => openZip(bytes), name).toThrow(
        expect.objectContaining({ code: 'HAP_UNSAFE_PATH' }),
      );
    }
  });
});

/**
 * A malformed archive must be refused with a `HAP_*` code, never a bare
 * `RangeError` from a `DataView` read past the end. Each case below points a
 * header field at the far side of the file, so a reader without bounds checks
 * throws from inside `DataView` instead of naming the problem.
 */
describe('openZip — malformed offsets', () => {
  const isTyped = (bytes: Uint8Array): unknown => {
    try {
      openZip(bytes);
      return undefined;
    } catch (err) {
      return err;
    }
  };

  it('refuses a central directory whose offset lies past the end', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a') }]);
    const eocd = bytes.length - 22;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(eocd + 16, bytes.length + 10, true);
    const err = isTyped(bytes);
    expect(err).toMatchObject({ code: 'HAP_NOT_ZIP' });
    expect((err as Error).message).toContain('central directory');
  });

  it('refuses a local header offset that lies past the end', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a') }]);
    const central = findCentralOffset(bytes);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(central + 42, bytes.length + 10, true);
    const err = isTyped(bytes);
    expect(err).toMatchObject({ code: 'HAP_NOT_ZIP' });
    expect((err as Error).message).toContain('local header');
  });

  it('refuses an entry whose declared name runs past the archive', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a') }]);
    const central = findCentralOffset(bytes);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(central + 28, 0xffff, true);
    const err = isTyped(bytes);
    expect(err).toMatchObject({ code: 'HAP_NOT_ZIP' });
  });

  it('refuses an entry whose compressed data runs past the archive', () => {
    const bytes = buildZip([{ name: 'a.txt', data: encoder.encode('a') }]);
    const central = findCentralOffset(bytes);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(central + 20, bytes.length, true);
    const err = isTyped(bytes);
    expect(err).toMatchObject({ code: 'HAP_NOT_ZIP' });
    expect((err as Error).message).toContain('truncated');
  });
});

/** The offset of the first central-directory header, found from the EOCD. */
function findCentralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.length - 22 + 16, true);
}
