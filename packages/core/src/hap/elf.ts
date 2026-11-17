/**
 * A reader for the ELF headers, sections and symbols of an OHOS native binary.
 *
 * This exists for HapRay parity row 27. HapRay's `opt-detector` answers "what
 * optimization level was this built at, and was LTO on?" by feeding raw
 * `.text` bytes to a ~2 GB LSTM and a 551-feature SVM and printing the guess
 * as a percentage. An ELF records much of that directly — LTO leaves
 * `lto_priv.*` symbols and `.gnu.lto_*` sections, `-O0` leaves debug
 * sections, and the instruction mix is a fact about the bytes — so the
 * analyzer built on this reader reports what the file says and labels the
 * parts that are inference.
 *
 * What is here is deliberately narrow: the section header table, the two
 * symbol tables, and a decoder for the AArch64 instruction classes whose
 * density differs across optimization levels. There is no program-header
 * walk, no relocation processing, no dynamic-section parsing and no
 * disassembly — nothing this reader does not have a caller for.
 *
 * ## Refusals
 *
 * Every read is bounds-checked against the buffer, because a `.so` shipped
 * inside an app is attacker-controlled input as far as this package is
 * concerned. A bad magic, a short header, an unsupported class and a section
 * table pointing past the end are typed refusals naming the field, not bare
 * `RangeError`s from a `DataView`.
 */

import { OhosPerfError } from '../errors';

/** `e_machine` for AArch64, the only machine an OHOS app ships. */
export const EM_AARCH64 = 183;

const SHT_SYMTAB = 2;
const SHT_NOBITS = 8;
const SHT_DYNSYM = 11;

/** One section header, as much of it as a caller here needs. */
export interface ElfSection {
  readonly name: string;
  readonly type: number;
  readonly flags: number;
  /** Offset of the payload in the file. */
  readonly offset: number;
  /** Declared size. A `NOBITS` section declares one but occupies no bytes. */
  readonly size: number;
  /** Entry size for a table section (`sh_entsize`), else 0. */
  readonly entrySize: number;
}

/** One symbol, with the binding and type decoded from `st_info`. */
export interface ElfSymbol {
  readonly name: string;
  readonly bind: 'local' | 'global' | 'weak' | 'other';
  readonly type: 'notype' | 'func' | 'object' | 'section' | 'file' | 'other';
  readonly size: number;
  /** Section index the symbol belongs to; 0 for undefined, 0xfff1 for absolute. */
  readonly sectionIndex: number;
}

export interface ElfFile {
  readonly bits: 32 | 64;
  readonly endian: 'little' | 'big';
  readonly machine: number;
  /** `e_type`: 1 relocatable, 2 executable, 3 shared object, 4 core. */
  readonly type: number;
  readonly sections: readonly ElfSection[];
  readonly symbols: readonly ElfSymbol[];
  /** The section with this name, or `undefined`. */
  readonly section: (name: string) => ElfSection | undefined;
  /** The payload of a section; empty for `NOBITS` and for a missing section. */
  readonly bytesOf: (name: string) => Uint8Array;
}

function fail(message: string, cause?: unknown): never {
  throw new OhosPerfError(message, { code: 'ELF_INVALID', ...(cause === undefined ? {} : { cause }) });
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Read a `uintN` at `at`, refusing a read past `end`.
 *
 * A `DataView` throws a `RangeError` whose message says nothing about which
 * field was being read; every field goes through here so a truncated file
 * names the offset instead.
 */
function field(
  dv: DataView, at: number, size: number, what: string,
): number {
  if (at < 0 || at + size > dv.byteLength) {
    fail(`ELF is truncated: ${what} at offset ${at} runs past the ${dv.byteLength}-byte file`);
  }
  if (size === 1) return dv.getUint8(at);
  if (size === 2) return dv.getUint16(at, true);
  if (size === 4) return dv.getUint32(at, true);
  // A 64-bit field is returned as a JS number; a value above 2^53 would lose
  // precision, but no offset or size in a real binary comes close, and this
  // reader only uses these as offsets and counts.
  return dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 2 ** 32;
}

function readString(table: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= table.length) return '';
  const end = table.indexOf(0, offset);
  return new TextDecoder('utf-8').decode(
    table.subarray(offset, end === -1 ? table.length : end),
  );
}

function bindOf(info: number): ElfSymbol['bind'] {
  const bind = info >> 4;
  if (bind === 0) return 'local';
  if (bind === 1) return 'global';
  if (bind === 2) return 'weak';
  return 'other';
}

function typeOf(info: number): ElfSymbol['type'] {
  const type = info & 0xf;
  if (type === 0) return 'notype';
  if (type === 1) return 'object';
  if (type === 2) return 'func';
  if (type === 3) return 'section';
  if (type === 4) return 'file';
  return 'other';
}

/** The symbol table's `sh_link` target: its string table. */
function symbolTableOf(
  dv: DataView, sections: readonly ElfSection[], links: readonly number[],
  bytes: Uint8Array, index: number,
): ElfSymbol[] {
  const section = sections[index]!;
  const link = links[index]!;
  const strings = link >= 0 && link < sections.length
    ? bytes.subarray(sections[link]!.offset, sections[link]!.offset + sections[link]!.size)
    : new Uint8Array(0);
  const entrySize = section.entrySize === 0 ? 24 : section.entrySize;
  const count = Math.floor(section.size / entrySize);
  const symbols: ElfSymbol[] = [];
  for (let at = 0; at < count; at += 1) {
    const base = section.offset + at * entrySize;
    // Index 0 is the reserved null symbol by specification, and is skipped
    // unconditionally rather than by its name: a file that puts a name there
    // is malformed, and counting the entry would invent a function.
    if (at === 0) continue;
    const nameOffset = field(dv, base, 4, 'st_name');
    const info = field(dv, base + 4, 1, 'st_info');
    const sectionIndex = field(dv, base + 6, 2, 'st_shndx');
    const size = field(dv, base + 16, 8, 'st_size');
    const name = readString(strings, nameOffset);
    symbols.push({ name, bind: bindOf(info), type: typeOf(info), size, sectionIndex });
  }
  return symbols;
}

/**
 * Read an ELF's headers, sections and symbols.
 *
 * Only 64-bit little-endian is decoded. The class and endianness are read
 * first and refused by name, so a 32-bit or big-endian file gets a message
 * saying which shape was unsupported rather than a nonsensical section table.
 */
export function readElf(bytes: Uint8Array): ElfFile {
  if (bytes.length < 4) {
    fail(`ELF is truncated: ${bytes.length} bytes is shorter than the 4-byte magic`);
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    fail('not an ELF file: the first four bytes are not \\x7fELF');
  }
  if (bytes.length < 16) {
    fail(`ELF is truncated: ${bytes.length} bytes is shorter than the 16-byte ident`);
  }
  const bits = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : 0;
  if (bits === 0) {
    fail(`unsupported ELF class ${String(bytes[4])}: only 32-bit and 64-bit are defined`);
  }
  const endian = bytes[5] === 1 ? 'little' : bytes[5] === 2 ? 'big' : undefined;
  if (endian === undefined) {
    fail(`unsupported ELF data encoding ${String(bytes[5])}: only little and big endian are defined`);
  }
  if (bits !== 64 || endian !== 'little') {
    fail(`unsupported ELF: ${String(bits)}-bit ${endian}-endian; OHOS ships 64-bit little-endian`);
  }

  const headerSize = 64;
  if (bytes.length < headerSize) {
    fail(`ELF is truncated: ${bytes.length} bytes is shorter than the ${headerSize}-byte header`);
  }
  const dv = view(bytes);
  const machine = field(dv, 18, 2, 'e_machine');
  const type = field(dv, 16, 2, 'e_type');
  const shoff = field(dv, 40, 8, 'e_shoff');
  const shentsize = field(dv, 58, 2, 'e_shentsize');
  const shnum = field(dv, 60, 2, 'e_shnum');
  const shstrndx = field(dv, 62, 2, 'e_shstrndx');

  if (shnum === 0) {
    // A file with no section headers is legal (fully stripped, program
    // headers only) and has no `.text` for this reader to describe.
    return {
      bits: 64, endian, machine, type,
      sections: [], symbols: [],
      section: () => undefined,
      bytesOf: () => new Uint8Array(0),
    };
  }
  if (shentsize !== 64) {
    fail(`unsupported section header size ${shentsize}: a 64-bit ELF uses 64`);
  }
  if (shoff + shnum * shentsize > bytes.length) {
    fail(
      `ELF is truncated: the section header table at offset ${shoff} with ${shnum} entries` +
        ` runs past the ${bytes.length}-byte file`,
    );
  }
  if (shstrndx >= shnum) {
    fail(`e_shstrndx ${shstrndx} names a section beyond the ${shnum} the file declares`);
  }

  const raw: Array<{ nameOffset: number; type: number; flags: number; offset: number; size: number; link: number; entrySize: number }> = [];
  const links: number[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const at = shoff + index * shentsize;
    raw.push({
      nameOffset: field(dv, at, 4, `section[${index}].sh_name`),
      type: field(dv, at + 4, 4, `section[${index}].sh_type`),
      flags: field(dv, at + 8, 8, `section[${index}].sh_flags`),
      offset: field(dv, at + 24, 8, `section[${index}].sh_offset`),
      size: field(dv, at + 32, 8, `section[${index}].sh_size`),
      link: field(dv, at + 40, 4, `section[${index}].sh_link`),
      entrySize: field(dv, at + 56, 8, `section[${index}].sh_entsize`),
    });
    links.push(raw[index]!.link);
  }

  // Every non-NOBITS payload must lie inside the file. A section header that
  // points past the end is a truncated download or a crafted file, and reading
  // it would either throw an opaque RangeError or return zeroes.
  for (const [index, section] of raw.entries()) {
    if (section.type === SHT_NOBITS || section.type === 0) continue;
    if (section.offset + section.size > bytes.length) {
      fail(
        `ELF is truncated: section ${index} at offset ${section.offset} with size` +
          ` ${section.size} runs past the ${bytes.length}-byte file`,
      );
    }
  }

  const nameTable = raw[shstrndx]!;
  const strings = bytes.subarray(nameTable.offset, nameTable.offset + nameTable.size);
  const sections: ElfSection[] = raw.map((section) => ({
    name: readString(strings, section.nameOffset),
    type: section.type,
    flags: section.flags,
    offset: section.offset,
    size: section.size,
    entrySize: section.entrySize,
  }));

  const symbols: ElfSymbol[] = [];
  for (const [index, section] of sections.entries()) {
    if (section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) continue;
    symbols.push(...symbolTableOf(dv, sections, links, bytes, index));
  }

  const byName = new Map(sections.map((section) => [section.name, section]));
  return {
    bits: 64,
    endian,
    machine,
    type,
    sections,
    symbols,
    section: (name) => byName.get(name),
    bytesOf: (name) => {
      const section = byName.get(name);
      if (section === undefined || section.type === SHT_NOBITS) return new Uint8Array(0);
      return bytes.subarray(section.offset, section.offset + section.size);
    },
  };
}

/** The instruction classes whose density differs across optimization levels. */
export type InstructionClass =
  | 'ret' | 'blr' | 'br' | 'bl' | 'b' | 'bcond' | 'cbz' | 'tbz'
  | 'adrp' | 'adr' | 'ldr' | 'str' | 'add' | 'vector' | 'other';

/** Per-class instruction counts over a `.text` payload. */
export type InstructionCounts = Record<InstructionClass, number> & { total: number };

/**
 * Classify one AArch64 instruction word.
 *
 * The masks are the ARM ARM's fixed-field encodings for the classes whose
 * frequency a compiler changes: `ret`/`blr`/`br` (branch-register), `bl`/`b`
 * (immediate branch), `b.cond`, `cbz`/`cbnz`, `tbz`/`tbnz`, `adrp`/`adr`, and
 * the SIMD group. `other` covers everything else, which is most arithmetic.
 *
 * The order matters: `br`/`blr`/`ret` share a mask and are separated by their
 * `opc` field, and `b`/`bl` share a mask separated by bit 31.
 */
export function classifyInstruction(word: number): InstructionClass {
  // Every mask result is converted with `>>> 0`: a JavaScript bitwise AND
  // yields a signed int32, so comparing it against a literal above 2^31 (all
  // the branch encodings are) would fail on a value that looks identical.
  const masked = (mask: number): number => ((word & mask) >>> 0);
  // Branch-register group: 1101011 0x00 11111 000000 Rn 000000.
  if (masked(0xfffffc1f) === 0xd65f0000) return 'ret';
  if (masked(0xfffffc1f) === 0xd63f0000) return 'blr';
  if (masked(0xfffffc1f) === 0xd61f0000) return 'br';
  // Unconditional branch immediate: op 00101 imm26.
  if (masked(0xfc000000) === 0x94000000) return 'bl';
  if (masked(0xfc000000) === 0x14000000) return 'b';
  // Conditional branch: 0101010 0 imm19 0 cond.
  if (masked(0xff000010) === 0x54000000) return 'bcond';
  // Compare and branch: sf 011010 0/1 imm19 Rt.
  if (masked(0x7e000000) === 0x34000000) return 'cbz';
  // Test and branch: b5 011011 0/1 b40 imm14 Rt.
  if (masked(0x7e000000) === 0x36000000) return 'tbz';
  // PC-relative addressing: adrp / adr.
  if (masked(0x9f000000) === 0x90000000) return 'adrp';
  if (masked(0x9f000000) === 0x10000000) return 'adr';
  // Load/store unsigned immediate: size 111 0 01 opc imm12 Rn Rt.
  if (masked(0x3b000000) === 0x39000000) {
    return masked(0x00400000) === 0 ? 'str' : 'ldr';
  }
  // Add/subtract immediate: sf 0 0 100010 sh imm12 Rn Rd.
  if (masked(0x1f000000) === 0x11000000) return 'add';
  // Advanced SIMD three-same: 0Q U 01110 size 1 Rm opcode Rn Rd.
  if (masked(0x0a000000) === 0x0a000000) return 'vector';
  return 'other';
}

/**
 * Count instruction classes over a payload.
 *
 * A trailing partial word is not an instruction and is not counted; a section
 * whose size is not a multiple of four is legal padding.
 */
export function countInstructions(payload: Uint8Array): InstructionCounts {
  const counts: InstructionCounts = {
    total: 0, ret: 0, blr: 0, br: 0, bl: 0, b: 0, bcond: 0, cbz: 0, tbz: 0,
    adrp: 0, adr: 0, ldr: 0, str: 0, add: 0, vector: 0, other: 0,
  };
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const words = Math.floor(payload.length / 4);
  for (let index = 0; index < words; index += 1) {
    const cls = classifyInstruction(dv.getUint32(index * 4, true));
    counts[cls] += 1;
    counts.total += 1;
  }
  return counts;
}
