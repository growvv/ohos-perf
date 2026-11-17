/**
 * A real ELF writer for tests of the ELF reader.
 *
 * The reader is exercised against the format, not against itself: this writes
 * a section header table, a string table and a symbol table the way a linker
 * does, so a reader bug shows up as a failed read rather than as two halves of
 * one mistake agreeing. It can also emit the malformed shapes the reader must
 * refuse (a bad magic, a truncated header, an out-of-range section offset).
 *
 * Only the 64-bit little-endian shape is written: that is what an OHOS arm64
 * `.so` is, and the reader's 32-bit and big-endian paths are covered by
 * mutating a written header rather than by a second writer.
 */

export const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;

/** AArch64, the only machine an OHOS app ships. */
export const EM_AARCH64 = 183;

export const SHT_NULL = 0;
export const SHT_PROGBITS = 1;
export const SHT_SYMTAB = 2;
export const SHT_STRTAB = 3;
export const SHT_NOTE = 7;
export const SHT_NOBITS = 8;
export const SHT_DYNSYM = 11;

export const SHF_WRITE = 0x1;
export const SHF_ALLOC = 0x2;
export const SHF_EXECINSTR = 0x4;

export const STB_LOCAL = 0;
export const STB_GLOBAL = 1;
export const STB_WEAK = 2;

export const STT_NOTYPE = 0;
export const STT_FUNC = 2;

/** One symbol to write into a `.symtab`/`.dynsym` the writer builds. */
export interface TestSymbol {
  name: string;
  /** `STB_*` binding. */
  bind: number;
  /** `STT_*` type. */
  type: number;
  size?: number;
  /** Index of the section the symbol belongs to; 1 is the first real section. */
  shndx?: number;
}

/** One section. `symbols` builds a symbol table; `data` is used otherwise. */
export interface TestSection {
  name: string;
  type?: number;
  flags?: number;
  data?: Uint8Array;
  /** Build a symbol table from these instead of writing `data`. */
  symbols?: TestSymbol[];
  /** Name of the section `sh_link` points at (a symbol table's string table). */
  linkTo?: string;
  /** Overrides the recorded size without changing the payload. */
  sizeOverride?: number;
  /** Overrides the recorded offset, for a reader that must refuse it. */
  offsetOverride?: number;
}

export interface ElfOptions {
  machine?: number;
  /** `e_type`: 3 is ET_DYN, what a `.so` is. */
  type?: number;
  /** Emit a section header table whose `e_shoff` lies past the end. */
  badSectionOffset?: boolean;
  /** Truncate the output to this many bytes. */
  truncateTo?: number;
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

function u64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % 2 ** 32, true);
  view.setUint32(at + 4, Math.floor(value / 2 ** 32), true);
}

/**
 * Write one ELF64 little-endian file.
 *
 * `.shstrtab` is appended automatically (named `shstrtab`), and every
 * `.symtab`/`.dynsym` gets a matching `.strtab`-style string table built from
 * its symbols' names unless one is supplied through `linkTo`.
 */
export function makeElf64(sections: TestSection[], opts: ElfOptions = {}): Uint8Array {
  const encoder = new TextEncoder();

  // Build the string table for section names: byte 0 is the empty name.
  const shstr = new Uint8Array(1024);
  let shstrLen = 1;
  const nameOffsets: number[] = [];
  for (const section of sections) {
    nameOffsets.push(shstrLen);
    const bytes = encoder.encode(section.name);
    shstr.set(bytes, shstrLen);
    shstrLen += bytes.length + 1;
  }
  const shstrtabNameOffset = shstrLen;
  shstr.set(encoder.encode('shstrtab'), shstrLen);
  shstrLen += 'shstrtab'.length + 1;

  // Lay out section payloads after the ELF header.
  const blobs: Array<{ data: Uint8Array; name: number; type: number; flags: number; link: number }> = [];
  let cursor = 64;

  // Null section, required at index 0.
  blobs.push({ data: new Uint8Array(0), name: 0, type: SHT_NULL, flags: 0, link: 0 });

  for (const [index, section] of sections.entries()) {
    let payload: Uint8Array;
    let type = section.type ?? (section.symbols === undefined ? SHT_PROGBITS : SHT_SYMTAB);
    if (section.symbols !== undefined) {
      // The writer builds `.strtab` + the symbol table as two sections: a
      // caller that asks for symbols gets the pair, because a symbol table
      // whose `sh_link` points nowhere is not a symbol table.
      const strtab = new Uint8Array(4096);
      let strLen = 1;
      const encoded = section.symbols.map((symbol) => {
        const at = strLen;
        const bytes = encoder.encode(symbol.name);
        strtab.set(bytes, strLen);
        strLen += bytes.length + 1;
        return at;
      });
      const symtab = new Uint8Array(24 * (section.symbols.length + 1));
      const sv = new DataView(symtab.buffer);
      section.symbols.forEach((symbol, at) => {
        const base = (at + 1) * 24;
        sv.setUint32(base, encoded[at]!, true);
        sv.setUint8(base + 4, (symbol.bind << 4) | symbol.type);
        sv.setUint16(base + 6, symbol.shndx ?? index + 1, true);
        u64(sv, base + 8, 0);
        u64(sv, base + 16, symbol.size ?? 0);
      });
      // The string table goes immediately before the symbol table so the
      // table's `sh_link` is simply the previous index; the string table
      // itself is unnamed, which no reader needs.
      const strtabIndex = blobs.length;
      blobs.push({
        data: strtab.subarray(0, strLen), name: 0,
        type: SHT_STRTAB, flags: 0, link: 0,
      });
      blobs.push({
        data: symtab, name: nameOffsets[index]!,
        type, flags: 0, link: strtabIndex,
      });
      continue;
    }
    payload = section.data ?? new Uint8Array(0);
    if (type === SHT_NOBITS) payload = new Uint8Array(0);
    blobs.push({
      data: payload, name: nameOffsets[index]!,
      type, flags: section.flags ?? 0, link: 0,
    });
  }

  // Append the section-name string table as the last real section.
  blobs.push({
    data: shstr.subarray(0, shstrLen), name: shstrtabNameOffset,
    type: SHT_STRTAB, flags: 0, link: 0,
  });

  const offsets: number[] = [];
  for (const blob of blobs) {
    cursor = align(cursor, 8);
    offsets.push(cursor);
    cursor += blob.data.length;
  }
  const shoff = align(cursor, 8);
  const shnum = blobs.length;
  const total = shoff + shnum * 64;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(ELF_MAGIC, 0);
  out[4] = 2; // ELFCLASS64
  out[5] = 1; // ELFDATA2LSB
  out[6] = 1; // EV_CURRENT
  view.setUint16(16, opts.type ?? 3, true);
  view.setUint16(18, opts.machine ?? EM_AARCH64, true);
  view.setUint32(20, 1, true);
  u64(view, 24, 0); // e_entry
  u64(view, 32, 0); // e_phoff
  u64(view, 40, opts.badSectionOffset === true ? total + 4096 : shoff);
  view.setUint32(48, 0, true);
  view.setUint16(52, 64, true); // e_ehsize
  view.setUint16(54, 0, true); // e_phentsize
  view.setUint16(56, 0, true); // e_phnum
  view.setUint16(58, 64, true); // e_shentsize
  view.setUint16(60, shnum, true);
  view.setUint16(62, shnum - 1, true); // e_shstrndx

  blobs.forEach((blob, index) => {
    out.set(blob.data, offsets[index]!);
  });

  // Overrides are keyed by the caller's section index; a symbol section
  // expands into two written sections, so the caller's overrides are matched
  // by name against the written blobs rather than by position.
  const overrides = new Map<number, TestSection>();
  for (const section of sections) {
    overrides.set(blobs.findIndex((blob) => blob.name === nameOffsets[sections.indexOf(section)]), section);
  }
  for (let index = 0; index < shnum; index += 1) {
    const at = shoff + index * 64;
    const blob = blobs[index]!;
    const override = overrides.get(index);
    view.setUint32(at, blob.name, true);
    view.setUint32(at + 4, blob.type, true);
    u64(view, at + 8, blob.flags);
    u64(view, at + 16, 0); // sh_addr
    u64(view, at + 24, override?.offsetOverride ?? offsets[index]!);
    u64(view, at + 32, override?.sizeOverride ?? blob.data.length);
    view.setUint32(at + 40, blob.link, true);
    view.setUint32(at + 44, 0, true);
    u64(view, at + 48, 1); // sh_addralign
    u64(view, at + 56, blob.type === SHT_SYMTAB || blob.type === SHT_DYNSYM ? 24 : 0);
  }

  return opts.truncateTo === undefined ? out : out.subarray(0, opts.truncateTo);
}

/** A little-endian AArch64 instruction word. */
export function insn(word: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, word >>> 0, true);
  return bytes;
}

/** Concatenate instruction words into a `.text` payload. */
export function text(...words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  words.forEach((word, index) => {
    new DataView(out.buffer).setUint32(index * 4, word >>> 0, true);
  });
  return out;
}

// The opcode words the tests use. Written out rather than encoded, so a test
// reads as the instruction it is testing.
export const OP = {
  ret: 0xd65f03c0,
  blr: 0xd63f0100,
  br: 0xd61f0220,
  bl: 0x94000123,
  b: 0x14000123,
  bcond: 0x54000060,
  cbz: 0x34000060,
  tbz: 0x36000060,
  adrp: 0x90000000,
  adr: 0x10000000,
  ldr: 0xf9400020,
  str: 0xf9000020,
  add: 0x91000420,
  /** `add v0.4s, v1.4s, v2.4s` — a SIMD add. */
  vector: 0x4e228420,
  nop: 0xd503201f,
} as const;
