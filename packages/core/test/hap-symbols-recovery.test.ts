import { describe, it, expect } from 'vitest';
import {
  makeElf64,
  OP,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_EXECINSTR,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FUNC,
  text,
} from './helpers/elf-writer';
import { readElf } from '../src/hap/elf';
import {
  addressOfOffset,
  functionAt,
  measureNaming,
  recoverSymbols,
  symbolIndex,
  type NamingAnswer,
} from '../src/hap/symbols-recovery';

/*
 * Symbol recovery (HapRay parity row 28).
 *
 * HapRay's `symbol_recovery` answers "which function is `libquick.so+0xc8a7c`?"
 * by shelling out to radare2 (`aflj` for the function list, `afij` for
 * boundaries, `pdfj` for disassembly, a decompiler for pseudo-C), building an
 * LLM prompt from the strings and callers, and printing whatever name the
 * model answers. Nothing measures whether the name is right, and its own docs
 * record the heuristic boundary case: a function over 100 KB is "unreasonable,
 * skip", and a function it cannot find gets a default size of 2000 bytes.
 *
 * This does not ship a disassembler. An ELF records the function boundaries
 * itself in `.symtab`/`.dynsym` — every `STT_FUNC` symbol has an address and a
 * size — so the containing function is a lookup, not a heuristic. When the
 * file is stripped there are no boundaries to read, and that is reported as
 * `unknown` rather than guessed at 2000 bytes.
 *
 * The part HapRay has no answer for is the one this adds: when a file has
 * names, some can be held out, inferred from their own bytes, and compared to
 * the truth. That is the accuracy of the inference, measured rather than
 * asserted.
 */

const textSection = (data: Uint8Array) => ({
  name: '.text',
  type: SHT_PROGBITS,
  flags: SHF_ALLOC | SHF_EXECINSTR,
  data,
});

/** A `.text` of `count` instructions, all one opcode. */
function body(word: number, count: number): Uint8Array {
  return text(...Array.from({ length: count }, () => word));
}

/**
 * A library whose three functions sit back to back at 0, 64 and 96.
 *
 * `st_value` is the address the symbol records, which for a shared object is
 * the offset a `libfoo.so+0xoffset` reference names — the same number space
 * `recoverSymbols` looks an address up in.
 */
function library(): Uint8Array {
  return makeElf64([
    textSection(body(OP.add, 64)),
    {
      name: '.symtab',
      symbols: [
        { name: 'parseExpression', bind: STB_GLOBAL, type: STT_FUNC, size: 64, value: 0 },
        { name: 'emitError', bind: STB_LOCAL, type: STT_FUNC, size: 32, value: 64 },
        { name: 'main', bind: STB_GLOBAL, type: STT_FUNC, size: 48, value: 96 },
      ],
    },
  ]);
}

describe('addressOfOffset — the perf.db form', () => {
  it('splits `libquick.so+0xc8a7c` into a library and an offset', () => {
    expect(addressOfOffset('libquick.so+0xc8a7c')).toEqual({
      library: 'libquick.so', offset: 0xc8a7c,
    });
  });

  it('accepts a path before the library name', () => {
    expect(addressOfOffset('/data/app/lib/arm64/libx.so+0x10'))
      .toEqual({ library: '/data/app/lib/arm64/libx.so', offset: 16 });
  });

  it('returns undefined for a name that is not an address', () => {
    // A resolved symbol is a name, not an address; treating it as one would
    // put `+0x` in the library column and invent an offset.
    expect(addressOfOffset('parseExpression')).toBeUndefined();
    expect(addressOfOffset('std::vector<int>::push_back()')).toBeUndefined();
    expect(addressOfOffset('')).toBeUndefined();
  });

  it('refuses an offset that does not parse as hex', () => {
    expect(addressOfOffset('libx.so+0xzz')).toBeUndefined();
  });
});

/** The parsed file, which is what `symbolIndex` takes: it is pure over an ELF. */
const indexOf = (bytes: Uint8Array) => symbolIndex(readElf(bytes));

describe('symbolIndex and functionAt', () => {
  it('finds the function containing an offset, from the symbols the ELF records', () => {
    // The whole point of the row: this is a lookup, not a heuristic. HapRay
    // runs `aflj`/`afij` for it and defaults to 2000 bytes when it misses.
    const index = indexOf(library());
    const found = functionAt(index, 0x20);
    expect(found?.name).toBe('parseExpression');
    expect(found?.start).toBe(0);
    expect(found?.end).toBe(64);
  });

  it('finds the function whose start is exactly the offset', () => {
    const index = indexOf(library());
    expect(functionAt(index, 64)?.name).toBe('emitError');
  });

  it('does not return a function for an offset in its last byte, which belongs to it', () => {
    const index = indexOf(library());
    expect(functionAt(index, 63)?.name).toBe('parseExpression');
  });

  it('returns undefined for an offset past every function, rather than the nearest one', () => {
    // Returning the closest preceding function would attribute an address in
    // a data blob to whatever code happened to precede it.
    const index = indexOf(library());
    expect(functionAt(index, 0x1000)).toBeUndefined();
  });

  it('ignores a zero-size function, which marks a boundary and not a body', () => {
    // A symbol with `st_size` 0 has no extent; treating it as a function would
    // swallow every address after it.
    const elf = makeElf64([
      textSection(body(OP.add, 64)),
      {
        name: '.symtab',
        symbols: [
          { name: 'boundary_only', bind: STB_GLOBAL, type: STT_FUNC, size: 0, value: 0 },
          { name: 'real', bind: STB_GLOBAL, type: STT_FUNC, size: 32, value: 32 },
        ],
      },
    ]);
    const index = indexOf(elf);
    expect(index.map((entry) => entry.name)).toEqual(['real']);
    expect(functionAt(index, 0)).toBeUndefined();
  });

  it('orders functions by start so a lookup is a scan over sorted data', () => {
    const elf = makeElf64([
      textSection(body(OP.add, 128)),
      {
        name: '.symtab',
        symbols: [
          { name: 'third', bind: STB_GLOBAL, type: STT_FUNC, size: 16, value: 96 },
          { name: 'first', bind: STB_GLOBAL, type: STT_FUNC, size: 16, value: 0 },
          { name: 'second', bind: STB_GLOBAL, type: STT_FUNC, size: 16, value: 32 },
        ],
      },
    ]);
    expect(indexOf(elf).map((entry) => entry.name)).toEqual(['first', 'second', 'third']);
  });

  it('reports no functions for a stripped file rather than inventing boundaries', () => {
    const stripped = makeElf64([textSection(body(OP.add, 64))]);
    expect(indexOf(stripped)).toEqual([]);
    expect(functionAt([], 0x10)).toBeUndefined();
  });

  it('reports the size the symbol recorded, not the distance to the next one', () => {
    // A function can be followed by padding. Extending it to the next symbol
    // would claim the padding as its body.
    const elf = makeElf64([
      textSection(body(OP.add, 128)),
      {
        name: '.symtab',
        symbols: [
          { name: 'a', bind: STB_GLOBAL, type: STT_FUNC, size: 16, value: 0 },
          { name: 'b', bind: STB_GLOBAL, type: STT_FUNC, size: 16, value: 64 },
        ],
      },
    ]);
    expect(functionAt(indexOf(elf), 32)).toBeUndefined();
  });

  it('drops a function symbol with no name, which names nothing to recover', () => {
    // An unnamed `STT_FUNC` with a size is a linker artefact. Keeping it would
    // let `recoverSymbols` return an empty name as if it had recovered one.
    const elf = makeElf64([
      textSection(body(OP.add, 64)),
      {
        name: '.symtab',
        symbols: [
          { name: '', bind: STB_LOCAL, type: STT_FUNC, size: 32, value: 0 },
          { name: 'named', bind: STB_GLOBAL, type: STT_FUNC, size: 32, value: 32 },
        ],
      },
    ]);
    expect(indexOf(elf).map((entry) => entry.name)).toEqual(['named']);
  });
});

describe('recoverSymbols', () => {
  it('names every unresolved address it can locate', () => {
    const result = recoverSymbols(library(), [
      'libx.so+0x10',
      'libx.so+0x60',
      'libx.so+0xffff',
    ]);
    expect(result.recovered).toEqual([
      { address: 'libx.so+0x10', offset: 16, name: 'parseExpression', start: 0, end: 64, basis: 'recorded' },
      { address: 'libx.so+0x60', offset: 96, name: 'main', start: 96, end: 144, basis: 'recorded' },
    ]);
  });

  it('keeps the addresses it could not locate, and says why', () => {
    const result = recoverSymbols(library(), ['libx.so+0xffff', 'parseExpression']);
    expect(result.recovered).toEqual([]);
    expect(result.unresolved).toHaveLength(2);
    expect(result.unresolved[0]!.reason).toMatch(/no function/i);
    expect(result.unresolved[1]!.reason).toMatch(/not an address/i);
  });

  it('counts what it recovered and what it did not, so the ratio is checkable', () => {
    const result = recoverSymbols(library(), ['libx.so+0x10', 'libx.so+0xffff']);
    expect(result.recovered).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);
  });

  it('says a stripped file recovers nothing, rather than guessing boundaries', () => {
    const stripped = makeElf64([textSection(body(OP.add, 64))]);
    const result = recoverSymbols(stripped, ['libx.so+0x10']);
    expect(result.recovered).toEqual([]);
    expect(result.unresolved[0]!.reason).toMatch(/no symbol table|stripped/i);
  });

  it('returns the same order for the same input, whatever order it was given in', () => {
    const first = recoverSymbols(library(), ['libx.so+0x50', 'libx.so+0x10']);
    const second = recoverSymbols(library(), ['libx.so+0x10', 'libx.so+0x50']);
    expect(first.recovered).toEqual(second.recovered);
  });
});

describe('measureNaming — the accuracy HapRay never reports', () => {
  /** A model that names every function from a table the test supplies. */
  const answers = (table: Record<string, string>): NamingAnswer =>
    (question) => Promise.resolve(table[question.truth] ?? 'unknown');

  it('reports how many held-out names the model got right', async () => {
    const report = await measureNaming(
      library(),
      answers({ parseExpression: 'parseExpression', emitError: 'emitExpression', main: 'main' }),
    );
    expect(report.heldOut).toBe(3);
    expect(report.correct).toBe(2);
    expect(report.accuracy).toBeCloseTo(2 / 3, 5);
  });

  it('names the cases it got wrong, with the truth and the answer', async () => {
    // An accuracy number alone does not tell a reader whether the model is
    // confused about one family of names or inventing everything.
    const report = await measureNaming(library(), answers({ main: 'notMain' }));
    const wrong = report.cases.filter((entry) => !entry.correct);
    expect(wrong.map((entry) => entry.truth)).toContain('main');
    expect(wrong.find((entry) => entry.truth === 'main')?.answer).toBe('notMain');
  });

  it('compares names after normalising the noise a model adds', async () => {
    // A tool prefix, an argument list and a return annotation are the same
    // function; counting them wrong would measure formatting, not naming.
    // C++ demangling is deliberately out of scope — see normaliseName.
    const report = await measureNaming(
      library(),
      answers({
        parseExpression: 'sym.parseExpression',
        emitError: 'emitError(int)',
        main: 'main -> void',
      }),
    );
    expect(report.correct).toBe(3);
  });

  it('refuses to report accuracy over an empty hold-out rather than returning 0', async () => {
    // 0% over zero cases reads as "the model is useless"; the truth is that
    // there was nothing to measure.
    const stripped = makeElf64([textSection(body(OP.add, 64))]);
    const report = await measureNaming(stripped, answers({}));
    expect(report.heldOut).toBe(0);
    expect(report.accuracy).toBeUndefined();
  });

  it('does not hold out a symbol whose name is not a name', async () => {
    // `fcn.000c8a7c` is what a tool prints when it has no name. Scoring a
    // model on reproducing it would reward copying the placeholder.
    const elf = makeElf64([
      textSection(body(OP.add, 64)),
      {
        name: '.symtab',
        symbols: [
          { name: 'fcn.000c8a7c', bind: STB_LOCAL, type: STT_FUNC, size: 32, value: 0 },
          { name: 'real', bind: STB_GLOBAL, type: STT_FUNC, size: 32, value: 32 },
        ],
      },
    ]);
    const report = await measureNaming(elf, answers({ real: 'real' }));
    expect(report.cases.map((entry) => entry.truth)).toEqual(['real']);
  });

  it('reports a naming failure as one, naming the function it was on', async () => {
    // A model that dies mid-run must not leave a report that looks like a
    // low accuracy; the failure has to be distinguishable from a wrong answer.
    await expect(measureNaming(library(), async () => {
      throw new Error('endpoint timed out');
    })).rejects.toThrow(/endpoint timed out/);
  });
});
