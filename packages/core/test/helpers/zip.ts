/**
 * Test-only reader for the stored-ZIP container the XLSX writer produces.
 *
 * Only the shape the writer emits is supported: local file headers with method
 * 0 (stored), no data descriptors, no ZIP64. That is deliberate — the test
 * verifies the exact format contract in the spec, not general ZIP support.
 */
export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  let offset = 0;

  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    if (method !== 0) throw new Error(`entry at ${offset} uses method ${method}, expected 0`);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }

  if (entries.size === 0) throw new Error('no stored ZIP entries found');
  return entries;
}

/** Decode one entry as UTF-8 text, failing loudly when it is absent. */
export function entryText(entries: Map<string, Uint8Array>, name: string): string {
  const data = entries.get(name);
  if (data === undefined) throw new Error(`missing ZIP entry ${name}`);
  return new TextDecoder().decode(data);
}
