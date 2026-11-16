/**
 * Test-only reader for the stored-ZIP container the XLSX writer produces.
 *
 * Only the shape the writer emits is supported: local file headers with method
 * 0 (stored), no data descriptors, no ZIP64, no archive comment. That is
 * deliberate — the test verifies the exact format contract in the spec, not
 * general ZIP support.
 *
 * The reader validates everything a consumer would rely on: each local entry's
 * CRC and sizes, the central directory's agreement with the local entries, and
 * the end-of-central-directory record's counts and offsets. A determinism test
 * that merely compares two renders cannot catch a wrong CRC or a broken central
 * directory — both renders would be equally wrong and Excel would refuse the
 * file.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Independent CRC32 implementation, so a wrong seed in production cannot pass. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface LocalEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 22) throw new Error('ZIP too short for an EOCD record');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  const eocd = bytes.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error('missing EOCD signature');
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset + centralSize !== eocd) {
    throw new Error(
      `corrupted EOCD: central directory ${centralOffset}+${centralSize} ends at ` +
        `${centralOffset + centralSize}, EOCD starts at ${eocd}`,
    );
  }

  const locals: LocalEntry[] = [];
  let offset = 0;
  while (offset < centralOffset) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error(`missing local header signature at ${offset}`);
    }
    const method = view.getUint16(offset + 8, true);
    if (method !== 0) throw new Error(`entry at ${offset} uses method ${method}, expected 0`);
    const crc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    if (compressedSize !== uncompressedSize) {
      throw new Error(`stored entry ${name} has differing sizes`);
    }
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for entry ${name}`);
    locals.push({ name, data, crc, offset });
    offset = dataStart + compressedSize;
  }
  if (offset !== centralOffset) {
    throw new Error(`local entries end at ${offset}, central directory starts at ${centralOffset}`);
  }

  const entries = new Map(locals.map((local) => [local.name, local.data]));
  const centralNames: string[] = [];
  let cursor = centralOffset;
  while (cursor < eocd) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`missing central header signature at ${cursor}`);
    }
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    const local = locals.find((candidate) => candidate.name === name);
    if (local === undefined) throw new Error(`central entry ${name} has no local header`);
    if (localOffset !== local.offset) {
      throw new Error(`central entry ${name} points at ${localOffset}, local header at ${local.offset}`);
    }
    if (crc !== local.crc || compressedSize !== local.data.length || uncompressedSize !== local.data.length) {
      throw new Error(`central entry ${name} disagrees with its local header`);
    }
    centralNames.push(name);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== eocd) throw new Error(`central directory ends at ${cursor}, EOCD starts at ${eocd}`);
  if (centralNames.length !== entryCount || entries.size !== entryCount) {
    throw new Error(
      `EOCD declares ${entryCount} entries, central directory has ${centralNames.length}, ` +
        `local entries ${entries.size}`,
    );
  }

  return entries;
}

/** Decode one entry as UTF-8 text, failing loudly when it is absent. */
export function entryText(entries: Map<string, Uint8Array>, name: string): string {
  const data = entries.get(name);
  if (data === undefined) throw new Error(`missing ZIP entry ${name}`);
  return new TextDecoder().decode(data);
}
