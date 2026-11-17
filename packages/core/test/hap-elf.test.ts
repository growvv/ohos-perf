import { describe, it, expect } from 'vitest';
import {
  EM_AARCH64,
  makeElf64,
  OP,
  SHT_NOTE,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_EXECINSTR,
  STB_GLOBAL,
  STB_LOCAL,
  STB_WEAK,
  STT_FUNC,
  text,
  insn,
} from './helpers/elf-writer';
import {
  classifyInstruction,
  countInstructions,
  readElf,
} from '../src/hap/elf';

/*
 * The ELF reader (HapRay parity row 27).
 *
 * HapRay's `opt-detector` answers "what optimization level was this built at,
 * and was LTO on?" by feeding raw `.text` bytes to a ~2 GB LSTM and a
 * 551-feature SVM, then reporting the guess as a percentage. An ELF answers
 * much of it directly: LTO leaves `lto_priv.*`/`.gnu.lto_*` symbols and a
 * `ThinLTO` string, `-O0` leaves debug info and `.comment` compiler strings,
 * and the instruction mix (branch density, vector use, call/return balance) is
 * a real measurement rather than an inference from a byte histogram.
 *
 * So this reader reports what the file records. Nothing here claims to know
 * the exact `-O` flag — that is not in the binary — and the analyzer says so.
 */

const textSection = (data: Uint8Array) => ({
  name: '.text',
  type: SHT_PROGBITS,
  flags: SHF_ALLOC | SHF_EXECINSTR,
  data,
});

describe('readElf — header', () => {
  it('reads the class, endianness, machine and type of an arm64 shared object', () => {
    const elf = readElf(makeElf64([textSection(text(OP.ret))]));
    expect(elf.bits).toBe(64);
    expect(elf.endian).toBe('little');
    expect(elf.machine).toBe(EM_AARCH64);
    expect(elf.type).toBe(3);
  });

  it('refuses a file that is not an ELF rather than reading garbage', () => {
    const notElf = new Uint8Array(64);
    notElf.set([0x4d, 0x5a], 0); // "MZ", a PE header
    expect(() => readElf(notElf)).toThrow(/not an ELF/i);
  });

  it('refuses a header that is shorter than the ELF header', () => {
    // A four-byte magic alone cannot be read; saying "not an ELF" would hide
    // the difference between "wrong file" and "truncated file".
    const magicOnly = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    expect(() => readElf(magicOnly)).toThrow(/truncated/i);
  });

  it('refuses a section table that points past the end of the file', () => {
    const elf = makeElf64([textSection(text(OP.ret))], { badSectionOffset: true });
    expect(() => readElf(elf)).toThrow(/section header/i);
  });

  it('refuses an unsupported ELF class instead of assuming 64-bit', () => {
    const bytes = makeElf64([textSection(text(OP.ret))]);
    bytes[4] = 9;
    expect(() => readElf(bytes)).toThrow(/class/i);
  });
});

describe('readElf — sections', () => {
  it('names every section and finds .text by name', () => {
    const elf = readElf(makeElf64([
      { name: '.note.gnu.build-id', type: SHT_NOTE, data: new Uint8Array(16) },
      textSection(text(OP.ret, OP.bl)),
      { name: '.rodata', data: new Uint8Array(8) },
    ]));
    expect(elf.sections.map((section) => section.name)).toContain('.text');
    expect(elf.section('.text')?.size).toBe(8);
  });

  it('returns undefined for a section the file does not have', () => {
    const elf = readElf(makeElf64([textSection(text(OP.ret))]));
    expect(elf.section('.comment')).toBeUndefined();
  });

  it('reads the bytes of a section', () => {
    const elf = readElf(makeElf64([textSection(text(OP.ret, OP.bl))]));
    expect(elf.bytesOf('.text')).toEqual(text(OP.ret, OP.bl));
  });

  it('reports a NOBITS section as zero bytes rather than reading past the data', () => {
    // `.bss` occupies no file space; a reader that returned its declared size
    // would read whatever follows in the file.
    const elf = readElf(makeElf64([
      { name: '.bss', type: 8, flags: SHF_ALLOC, sizeOverride: 4096 },
      textSection(text(OP.ret)),
    ]));
    expect(elf.section('.bss')?.size).toBe(4096);
    expect(elf.bytesOf('.bss')).toHaveLength(0);
  });
});

describe('readElf — symbols', () => {
  it('reads function symbols with their binding and size', () => {
    const elf = readElf(makeElf64([
      textSection(text(OP.ret)),
      {
        name: '.symtab',
        symbols: [
          { name: 'main', bind: STB_GLOBAL, type: STT_FUNC, size: 128 },
          { name: 'helper', bind: STB_LOCAL, type: STT_FUNC, size: 32 },
          { name: 'exported', bind: STB_WEAK, type: STT_FUNC, size: 8 },
        ],
      },
    ]));
    const byName = new Map(elf.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('main')).toMatchObject({ bind: 'global', type: 'func', size: 128 });
    expect(byName.get('helper')).toMatchObject({ bind: 'local' });
    expect(byName.get('exported')).toMatchObject({ bind: 'weak' });
  });

  it('drops the reserved empty symbol every symbol table starts with', () => {
    const elf = readElf(makeElf64([
      textSection(text(OP.ret)),
      { name: '.symtab', symbols: [{ name: 'only', bind: STB_GLOBAL, type: STT_FUNC }] },
    ]));
    expect(elf.symbols.map((symbol) => symbol.name)).toEqual(['only']);
  });

  it('skips the reserved null symbol even when a file gives it a name', () => {
    // The entry at index 0 is reserved by specification. A malformed file that
    // names it would otherwise contribute a function that does not exist.
    const elf = readElf(makeElf64([
      textSection(text(OP.ret)),
      { name: '.symtab', symbols: [{ name: 'phantom', bind: STB_GLOBAL, type: STT_FUNC }] },
    ]));
    expect(elf.symbols.map((symbol) => symbol.name)).not.toContain('');
    expect(elf.symbols.map((symbol) => symbol.name)).toEqual(['phantom']);
  });

  it('reports no symbols rather than failing when the file is stripped', () => {
    const elf = readElf(makeElf64([textSection(text(OP.ret))]));
    expect(elf.symbols).toEqual([]);
  });
});

describe('classifyInstruction — AArch64 opcodes', () => {
  it('recognises the return, indirect-branch and call encodings', () => {
    expect(classifyInstruction(OP.ret)).toBe('ret');
    expect(classifyInstruction(OP.blr)).toBe('blr');
    expect(classifyInstruction(OP.br)).toBe('br');
    expect(classifyInstruction(OP.bl)).toBe('bl');
    expect(classifyInstruction(OP.b)).toBe('b');
  });

  it('recognises conditional branches, compare-and-branch and test-and-branch', () => {
    expect(classifyInstruction(OP.bcond)).toBe('bcond');
    expect(classifyInstruction(OP.cbz)).toBe('cbz');
    expect(classifyInstruction(OP.tbz)).toBe('tbz');
  });

  it('recognises the vector and adrp/ldr encodings the feature table counts', () => {
    expect(classifyInstruction(OP.vector)).toBe('vector');
    expect(classifyInstruction(OP.adrp)).toBe('adrp');
    expect(classifyInstruction(OP.adr)).toBe('adr');
    expect(classifyInstruction(OP.ldr)).toBe('ldr');
    expect(classifyInstruction(OP.add)).toBe('add');
  });

  it('calls everything else other, including a nop', () => {
    expect(classifyInstruction(OP.nop)).toBe('other');
  });

  it('does not mistake a vector instruction for a branch', () => {
    // The mask boundaries are where a classifier goes wrong: `0x4e228420` has
    // the top byte of a `b.cond` pattern in the wrong place, and a loose mask
    // would count SIMD code as control flow.
    expect(classifyInstruction(0x4e228420)).not.toBe('bcond');
  });
});

describe('countInstructions', () => {
  it('counts each class over a .text payload', () => {
    const counts = countInstructions(text(
      OP.ret, OP.bl, OP.bl, OP.bcond, OP.vector, OP.nop, OP.nop, OP.nop,
    ));
    expect(counts.total).toBe(8);
    expect(counts.ret).toBe(1);
    expect(counts.bl).toBe(2);
    expect(counts.bcond).toBe(1);
    expect(counts.vector).toBe(1);
    expect(counts.other).toBe(3);
  });

  it('ignores a trailing partial word rather than reading past the payload', () => {
    // A section whose size is not a multiple of four is legal (padding); the
    // last partial word is not an instruction and must not be counted.
    const payload = new Uint8Array([...insn(OP.ret), 0xd6]);
    expect(countInstructions(payload).total).toBe(1);
  });

  it('returns all zeroes for an empty payload', () => {
    expect(countInstructions(new Uint8Array(0))).toEqual({
      total: 0, ret: 0, blr: 0, br: 0, bl: 0, b: 0, bcond: 0, cbz: 0, tbz: 0,
      adrp: 0, adr: 0, ldr: 0, str: 0, add: 0, vector: 0, other: 0,
    });
  });
});
