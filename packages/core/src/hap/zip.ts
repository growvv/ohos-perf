import { inflateRawSync } from 'node:zlib';
import { OhosPerfError } from '../errors';
import { crc32 } from './crc';

/*
 * A ZIP reader for HAP/HSP packages.
 *
 * Only what a package needs: the central directory, stored and deflated
 * entries, and a CRC check on every read. There is no writer, no ZIP64, no
 * encryption and no extraction to disk — a package is read into memory so a
 * hostile entry name cannot escape anywhere. Each refusal names its code, so a
 * caller can tell "not a ZIP" from "a corrupted entry".
 */

/** One non-directory entry, as the central directory records it. */
export interface ZipEntry {
  /** The name exactly as stored; forward slashes. */
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly method: number;
  /** Where the entry's payload starts in the archive. */
  readonly dataOffset: number;
}

export interface ZipArchive {
  /** Non-directory entries, in central-directory order. */
  readonly entries: readonly ZipEntry[];
  /** Inflated bytes, CRC-checked. Throws on a mismatch or a bad stream. */
  read(entry: ZipEntry): Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const ZIP_COMMENT_MAX = 0xffff;

function fail(code: string, message: string): never {
  throw new OhosPerfError(message, { code });
}

function u16(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);
}

function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}

/**
 * Refuse a read that would run past `end`.
 *
 * A `DataView` read past the end throws a bare `RangeError`, which tells a
 * caller nothing about the archive it came from. Every header field is read
 * through this check first, so a malformed offset is a `HAP_NOT_ZIP` naming
 * the block instead.
 */
function need(bytes: Uint8Array, at: number, length: number, end: number, what: string): void {
  if (at < 0 || length < 0 || at + length > end) {
    fail('HAP_NOT_ZIP', `${what} lies outside the archive`);
  }
}

/** True when the bytes start with a local file header. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === LOCAL_SIGNATURE;
}

/** Find the end-of-central-directory record by scanning back from the end. */
function findEocd(bytes: Uint8Array): number {
  const lowest = Math.max(0, bytes.length - ZIP_COMMENT_MAX - 22);
  for (let at = bytes.length - 22; at >= lowest; at--) {
    if (u32(bytes, at) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/**
 * A name that is absolute, carries a drive letter, or climbs with `..` is not
 * something this reader will describe as a normal package file.
 */
function assertSafeName(name: string): void {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    fail('HAP_UNSAFE_PATH', `archive entry ${JSON.stringify(name)} is an absolute path`);
  }
  if (normalized.split('/').includes('..')) {
    fail('HAP_UNSAFE_PATH', `archive entry ${JSON.stringify(name)} climbs out of the archive`);
  }
}

/** Read the central directory and return an archive over `bytes`. */
export function openZip(bytes: Uint8Array): ZipArchive {
  const eocd = findEocd(bytes);
  if (eocd === -1) {
    fail('HAP_NOT_ZIP', 'not a ZIP archive: no end-of-central-directory record');
  }

  const count = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) {
    fail('HAP_ZIP64_UNSUPPORTED', 'ZIP64 archives are not supported');
  }
  if (centralOffset + centralSize > bytes.length) {
    fail('HAP_NOT_ZIP', 'central directory lies outside the archive');
  }

  const entries: ZipEntry[] = [];
  let at = centralOffset;
  for (let index = 0; index < count; index++) {
    // The fixed header is 46 bytes; every field below is read only after the
    // header and the name it declares are known to fit.
    need(bytes, at, 46, bytes.length, `central directory entry ${index}`);
    if (u32(bytes, at) !== CENTRAL_SIGNATURE) {
      fail('HAP_NOT_ZIP', `central directory entry ${index} has no header`);
    }
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    need(bytes, at + 46, nameLength, bytes.length, `central directory entry ${index} name`);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (size === ZIP64_SENTINEL || compressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      fail('HAP_ZIP64_UNSUPPORTED', `archive entry ${JSON.stringify(name)} needs ZIP64`);
    }
    assertSafeName(name);
    if ((flags & 0x0001) !== 0) {
      fail('HAP_ENCRYPTED_ENTRY', `archive entry ${JSON.stringify(name)} is encrypted`);
    }
    if (method !== 0 && method !== 8) {
      fail(
        'HAP_UNSUPPORTED_METHOD',
        `archive entry ${JSON.stringify(name)} uses compression method ${method}; only stored (0) and deflate (8) are supported`,
      );
    }
    if (name.endsWith('/')) continue; // A directory has nothing to measure.

    need(bytes, localOffset, 30, bytes.length, `archive entry ${JSON.stringify(name)} local header`);
    if (u32(bytes, localOffset) !== LOCAL_SIGNATURE) {
      fail('HAP_NOT_ZIP', `archive entry ${JSON.stringify(name)} has no local header`);
    }
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) {
      fail('HAP_NOT_ZIP', `archive entry ${JSON.stringify(name)} is truncated`);
    }

    entries.push({ name, size, compressedSize, crc32: crc, method, dataOffset });
  }

  return {
    entries,
    read(entry: ZipEntry): Uint8Array {
      const payload = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
      let out: Uint8Array;
      if (entry.method === 0) {
        out = payload;
      } else {
        try {
          out = new Uint8Array(inflateRawSync(Buffer.from(payload)));
        } catch (err) {
          // A short or corrupt stream is a corrupt entry, not a shorter file:
          // padding it would produce a plausible wrong inventory.
          throw new OhosPerfError(
            `archive entry ${JSON.stringify(entry.name)} has a corrupt deflate stream`,
            { cause: err, code: 'HAP_CRC_MISMATCH' },
          );
        }
      }
      const actual = crc32(out);
      if (actual !== entry.crc32) {
        fail(
          'HAP_CRC_MISMATCH',
          `archive entry ${JSON.stringify(entry.name)} fails its CRC check: ` +
            `header ${entry.crc32.toString(16)}, data ${actual.toString(16)}`,
        );
      }
      return out;
    },
  };
}
