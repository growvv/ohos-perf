import { describe, it, expect } from 'vitest';
import { makeZip } from './helpers/hap-zip-writer';
import {
  insn,
  makeElf64,
  OP,
  SHT_NOTE,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_EXECINSTR,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FUNC,
  text,
} from './helpers/elf-writer';
import {
  analyzeBinaries,
  classifyOptimization,
  extractBinaries,
  inspectBinary,
  optimizationSection,
  type BinaryInput,
} from '../src/hap/optimization';

/*
 * The optimization detector (HapRay parity row 27).
 *
 * HapRay's `opt-detector` runs a ~2 GB TensorFlow LSTM over raw `.text` bytes
 * to guess O0–O3, then a 551-feature SVM to guess LTO, and prints both as
 * percentages. Its own source records the cost: at the threshold it ships,
 * "low optimization" binaries are misreported 16.7% of the time.
 *
 * An ELF records several of those answers directly. LTO leaves `lto_priv.*`
 * symbols and `.gnu.lto_*` sections; a `-g` build leaves `.debug_info`; and a
 * build that recorded its flags leaves them in `.comment`. Those are exact.
 * What is not recorded — the `-O` level of a stripped, flag-free binary — is
 * inferred from the instruction mix and labelled `proxy`, with the signals
 * that produced the verdict named so a reader can disagree with it.
 */

const textSection = (data: Uint8Array) => ({
  name: '.text',
  type: SHT_PROGBITS,
  flags: SHF_ALLOC | SHF_EXECINSTR,
  data,
});

const symtab = (symbols: Array<{ name: string; bind: number; size?: number }>) => ({
  name: '.symtab',
  symbols: symbols.map((symbol) => ({
    name: symbol.name, bind: symbol.bind, type: STT_FUNC, size: symbol.size ?? 16,
  })),
});

/** A `.text` payload of `count` copies of one instruction. */
function repeat(word: number, count: number): Uint8Array {
  return text(...Array.from({ length: count }, () => word));
}

/** A binary with the given sections, as the analyzer takes it. */
function input(name: string, sections: Parameters<typeof makeElf64>[0], opts = {}): BinaryInput {
  return { path: name, bytes: makeElf64(sections, opts) };
}

describe('inspectBinary — what the ELF records', () => {
  it('measures the instruction mix of a .text section', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret, OP.bl, OP.bl, OP.bcond, OP.vector, OP.vector, OP.nop, OP.nop)),
    ]));
    expect(facts.instructions.total).toBe(8);
    expect(facts.instructions.vector).toBe(2);
    expect(facts.textBytes).toBe(32);
  });

  it('reports the machine and size of the file', () => {
    const facts = inspectBinary(input('libx.so', [textSection(text(OP.ret))]));
    expect(facts.machine).toBe(183);
    expect(facts.size).toBeGreaterThan(64);
  });

  it('finds LTO from lto_priv symbols', () => {
    // GCC/clang emit `lto_priv.<hash>` symbols for symbols that survived
    // link-time optimization with local visibility. The marker is the
    // compiler's own bookkeeping, so its presence is evidence, not inference.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      symtab([
        { name: 'main', bind: STB_GLOBAL },
        { name: 'lto_priv.0.abc123', bind: STB_LOCAL },
      ]),
    ]));
    expect(facts.lto).toBe('present');
    expect(facts.ltoMarkers).toContain('lto_priv.0.abc123');
  });

  it('finds LTO from a .gnu.lto section', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      { name: '.gnu.lto_.opts', type: SHT_NOTE, data: new Uint8Array(8) },
    ]));
    expect(facts.lto).toBe('present');
    expect(facts.ltoMarkers).toContain('.gnu.lto_.opts');
  });

  it('reports LTO absent when nothing marks it, rather than unknown', () => {
    // "absent" is a claim about the file: the reader looked at every symbol
    // and section name and none matched. HapRay cannot say this at all — its
    // SVM always returns a probability.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      symtab([{ name: 'main', bind: STB_GLOBAL }]),
    ]));
    expect(facts.lto).toBe('absent');
    expect(facts.ltoMarkers).toEqual([]);
  });

  it('reports LTO unknown when the file is stripped and has no sections to read', () => {
    // A stripped binary carries no symbol table, so "no marker found" is not
    // evidence of absence. The distinction is the point of this field.
    const stripped = makeElf64([textSection(text(OP.ret))]);
    // Rewrite the section count to zero, as a fully stripped file has.
    new DataView(stripped.buffer).setUint16(60, 0, true);
    const facts = inspectBinary({ path: 'libx.so', bytes: stripped });
    expect(facts.lto).toBe('unknown');
  });

  it('detects debug sections', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      { name: '.debug_info', type: SHT_PROGBITS, data: new Uint8Array(16) },
      { name: '.debug_line', type: SHT_PROGBITS, data: new Uint8Array(16) },
    ]));
    expect(facts.debug).toBe(true);
    expect(facts.debugSections).toEqual(['.debug_info', '.debug_line']);
  });

  it('reads the compiler strings a build recorded in .comment', () => {
    const comment = new TextEncoder().encode('clang version 15.0.4\0-linker-option -O2\0');
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      { name: '.comment', type: SHT_PROGBITS, data: comment },
    ]));
    expect(facts.compiler).toEqual(['clang version 15.0.4', '-linker-option -O2']);
    expect(facts.recordedFlags).toEqual(['-O2']);
  });

  it('counts function symbols by binding', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(OP.ret)),
      symtab([
        { name: 'a', bind: STB_GLOBAL },
        { name: 'b', bind: STB_GLOBAL },
        { name: 'c', bind: STB_LOCAL },
      ]),
    ]));
    expect(facts.symbols).toMatchObject({ functions: 3, global: 2, local: 1 });
  });

  it('reports a stripped binary as having no symbols', () => {
    const facts = inspectBinary(input('libx.so', [textSection(text(OP.ret))]));
    expect(facts.symbols.functions).toBe(0);
    expect(facts.stripped).toBe(true);
  });

  it('refuses a file that is not an ELF, naming the path', () => {
    expect(() => inspectBinary({ path: 'libx.so', bytes: new Uint8Array(64) }))
      .toThrow(/libx\.so/);
  });
});

describe('classifyOptimization', () => {
  it('takes the level from a recorded flag rather than inferring it', () => {
    // The exact answer, when the build left it behind: no model needed.
    const facts = inspectBinary(input('libx.so', [
      textSection(repeat(OP.nop, 100)),
      { name: '.comment', type: SHT_PROGBITS, data: new TextEncoder().encode('GCC: (OHOS) -O3\0') },
    ]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'high', basis: 'recorded' });
  });

  it('maps each recorded flag to its level', () => {
    const withFlag = (flag: string) => inspectBinary(input('libx.so', [
      textSection(repeat(OP.nop, 100)),
      { name: '.comment', type: SHT_PROGBITS, data: new TextEncoder().encode(`cc ${flag}\0`) },
    ]));
    expect(classifyOptimization(withFlag('-O0'))).toMatchObject({ level: 'unoptimized', basis: 'recorded' });
    expect(classifyOptimization(withFlag('-O1'))).toMatchObject({ level: 'low', basis: 'recorded' });
    expect(classifyOptimization(withFlag('-O2'))).toMatchObject({ level: 'medium', basis: 'recorded' });
    expect(classifyOptimization(withFlag('-O3'))).toMatchObject({ level: 'high', basis: 'recorded' });
    expect(classifyOptimization(withFlag('-Os'))).toMatchObject({ level: 'medium', basis: 'recorded' });
  });

  it('infers high from a vectorised instruction mix, naming the signal', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 40 }, () => OP.vector), ...Array.from({ length: 60 }, () => OP.add))),
    ]));
    const verdict = classifyOptimization(facts);
    expect(verdict).toMatchObject({ level: 'high', basis: 'inferred' });
    expect(verdict.signals).toContain('vector_density');
  });

  it('infers unoptimized from a debug build with no vector code', () => {
    // A `-g` build that never vectorises is the shape of an unoptimized
    // build: debug sections are the compiler being told to keep everything,
    // and the absence of SIMD says it kept the scalar form too.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 100 }, () => OP.ldr))),
      { name: '.debug_info', type: SHT_PROGBITS, data: new Uint8Array(16) },
    ]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'unoptimized', basis: 'inferred' });
  });

  it('reads a mix between the two densities as medium, not high', () => {
    // 5% SIMD: above the "no vector code" floor and below the "vectorised"
    // ceiling. Without this band a mutation that promoted every non-empty mix
    // to high passed, because no fixture sat between the thresholds.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 5 }, () => OP.vector), ...Array.from({ length: 95 }, () => OP.add))),
    ]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'medium', basis: 'inferred' });
  });

  it('calls a real release library high, matching HapRay on the same file', () => {
    // `libflutter.so` from HapRay's own test resources measures 23.5% SIMD.
    // HapRay's opt-detector reports it as "High Optimization (O3 dominant)" and
    // "No LTO" at score 0.489. This pins the thresholds to that measurement so
    // a recalibration that started calling real release builds "medium" would
    // fail here rather than in a user's report.
    const facts = inspectBinary(input('libflutter.so', [
      textSection(text(...Array.from({ length: 2352 }, () => OP.vector), ...Array.from({ length: 7648 }, () => OP.add))),
      { name: '.rodata', type: SHT_PROGBITS, data: new Uint8Array(16) },
      // The real file is not stripped: it carries a `.dynsym`, which is what
      // makes "no LTO marker found" a claim of absence rather than ignorance.
      { name: '.dynsym', type: 11, symbols: [{ name: 'flutter_main', bind: STB_GLOBAL }] },
    ]));
    expect(facts.instructions.total).toBe(10_000);
    expect(facts.lto).toBe('absent');
    expect(classifyOptimization(facts)).toMatchObject({ level: 'high', basis: 'inferred' });
  });

  it('says unknown rather than guessing when there is no code to measure', () => {
    // A `.so` with an empty `.text` gives no signal; a guess here would be
    // exactly the behaviour this row exists to replace.
    const facts = inspectBinary(input('libx.so', [textSection(new Uint8Array(0))]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'unknown' });
    expect(classifyOptimization(facts).signals).toEqual([]);
  });

  it('calls a debug build that vectorises high, not unoptimized', () => {
    // A `-g -O2` release build keeps `.debug_info` and still auto-vectorizes.
    // Debug sections alone do not mean unoptimized; the vector check runs
    // first for exactly this case.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 30 }, () => OP.vector), ...Array.from({ length: 70 }, () => OP.add))),
      { name: '.debug_info', type: SHT_PROGBITS, data: new Uint8Array(16) },
    ]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'high', basis: 'inferred' });
  });

  it('lets a recorded flag beat the instruction mix', () => {
    // The mix says "high" (heavy SIMD) and the flag says -O0. The flag wins:
    // it is the compiler's own statement, and a hand-written SIMD kernel at
    // -O0 must not be reported as optimised.
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 40 }, () => OP.vector), ...Array.from({ length: 60 }, () => OP.add))),
      { name: '.comment', type: SHT_PROGBITS, data: new TextEncoder().encode('cc -O0\0') },
    ]));
    expect(classifyOptimization(facts)).toMatchObject({ level: 'unoptimized', basis: 'recorded' });
  });

  it('reports LTO alongside the level without letting it decide the level', () => {
    const facts = inspectBinary(input('libx.so', [
      textSection(text(...Array.from({ length: 100 }, () => OP.add))),
      symtab([{ name: 'lto_priv.0.x', bind: STB_LOCAL }]),
    ]));
    const verdict = classifyOptimization(facts);
    expect(facts.lto).toBe('present');
    expect(verdict.level).toBe('low');
    expect(verdict.signals).not.toContain('lto');
  });
});

describe('extractBinaries — from a package or a list', () => {
  it('reads the arm64 libraries out of a HAP, skipping other files', () => {
    const lib = makeElf64([textSection(text(OP.ret))]);
    const bytes = makeZip([
      { name: 'module.json', data: new TextEncoder().encode('{}') },
      { name: 'libs/arm64/liba.so', data: lib, method: 0 },
      { name: 'libs/arm64/libb.so.1', data: lib, method: 0 },
      { name: 'libs/x86_64/libc.so', data: lib, method: 0 },
      { name: 'ets/modules.abc', data: new TextEncoder().encode('abc') },
    ]);
    const inputs = extractBinaries({ path: 'demo.hap', bytes });
    expect(inputs.map((entry) => entry.path)).toEqual([
      'libs/arm64/liba.so',
      'libs/arm64/libb.so.1',
    ]);
  });

  it('skips an arm64 entry that is not a shared object, even if it is an ELF', () => {
    // `libs/arm64/` can hold an ELF that is not a library (an executable, a
    // test binary). The extension check is what keeps it out; the magic check
    // alone would let it through, which is why this fixture is a real ELF
    // under a name that does not end in `.so`.
    const lib = makeElf64([textSection(text(OP.ret))]);
    const bytes = makeZip([
      { name: 'libs/arm64/liba.so', data: lib, method: 0 },
      { name: 'libs/arm64/helper', data: lib, method: 0 },
    ]);
    expect(extractBinaries({ path: 'demo.hap', bytes }).map((entry) => entry.path))
      .toEqual(['libs/arm64/liba.so']);
  });

  it('takes a bare .so as one binary', () => {
    const lib = makeElf64([textSection(text(OP.ret))]);
    expect(extractBinaries({ path: 'libx.so', bytes: lib })).toHaveLength(1);
  });

  it('names a package with no arm64 libraries instead of returning an empty report', () => {
    const bytes = makeZip([{ name: 'module.json', data: new TextEncoder().encode('{}') }]);
    expect(() => extractBinaries({ path: 'demo.hap', bytes }))
      .toThrow(/no arm64 libraries/i);
  });

  it('refuses a .a archive by name rather than misreading it', () => {
    // HapRay supports `.a`, but an `ar` archive is a different container from
    // the ZIP and ELF this package reads. Saying so is better than returning
    // an empty result that reads like "no optimizations found".
    expect(() => extractBinaries({ path: 'libx.a', bytes: new Uint8Array(8) }))
      .toThrow(/\.a archive/i);
  });
});

describe('analyzeBinaries', () => {
  const lib = makeElf64([
    textSection(text(...Array.from({ length: 100 }, () => OP.add))),
    symtab([{ name: 'lto_priv.0.x', bind: STB_LOCAL }, { name: 'main', bind: STB_GLOBAL }]),
  ]);

  it('measures every binary and summarises them', () => {
    const analysis = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    expect(analysis.binaries).toHaveLength(1);
    expect(analysis.totals).toMatchObject({ binaries: 1, lto: 1, debug: 0 });
    expect(analysis.binaries[0]!.verdict.level).toBe('low');
  });

  it('emits metrics that say what they measure', () => {
    const analysis = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    const byId = new Map(analysis.metrics.map((entry) => [entry.id, entry]));
    expect(byId.get('binary.files.count')!.value).toBe(1);
    expect(byId.get('binary.lto.files.count')!.value).toBe(1);
    expect(byId.get('binary.instructions.count')!.value).toBe(100);
    // Instruction counts are facts about the bytes.
    expect(byId.get('binary.instructions.count')!.fidelity).toBe('exact');
    // The level is an inference from those facts, and says so. This fixture
    // is 100 plain `add`s with no SIMD, which reads as low.
    expect(byId.get('binary.low.optimization.files.count')!.value).toBe(1);
    expect(byId.get('binary.low.optimization.files.count')!.fidelity).toBe('proxy');
  });

  it('orders binaries by path, whatever order they were given in', () => {
    const other = makeElf64([textSection(repeat(OP.add, 50))]);
    const analysis = analyzeBinaries([
      { path: 'libs/arm64/z.so', bytes: lib },
      { path: 'libs/arm64/a.so', bytes: other },
    ], 'demo.hap');
    expect(analysis.binaries.map((binary) => binary.path))
      .toEqual(['libs/arm64/a.so', 'libs/arm64/z.so']);
    // The metrics aggregate over the sorted list, so their row count follows
    // it too: a report whose binaries are sorted but whose totals are not is
    // a document that disagrees with itself.
    expect(analysis.metrics.find((entry) => entry.id === 'binary.files.count')!.value).toBe(2);
  });

  it('orders metrics by id, so two runs compare field by field', () => {
    const analysis = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    const ids = analysis.metrics.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('is deterministic: the same bytes give the same document', () => {
    const first = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    const second = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('names the LTO files as evidence, with the marker that proved it', () => {
    const analysis = analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap');
    const lto = analysis.evidence.find((item) => item.signals['lto'] === 'present');
    expect(lto?.explain).toContain('libs/arm64/liba.so');
    expect(lto?.explain).toContain('lto_priv.0.x');
  });

  it('reports an unmeasured level as evidence rather than a silent zero', () => {
    // HapRay reports "N/A" in a spreadsheet cell. A reader of this report
    // should be told which binaries it could not judge and why.
    const empty = makeElf64([textSection(new Uint8Array(0))]);
    const analysis = analyzeBinaries([{ path: 'libs/arm64/libx.so', bytes: empty }], 'demo.hap');
    const note = analysis.evidence.find((item) => item.kind === 'no_data');
    expect(note?.explain).toMatch(/libx\.so/);
    expect(note?.explain).toMatch(/no instructions/i);
  });

  it('wraps itself as a report section', () => {
    const section = optimizationSection(analyzeBinaries([{ path: 'libs/arm64/liba.so', bytes: lib }], 'demo.hap'));
    expect(section.analyzerId).toBe('optimization');
    expect(section.status).toBe('measured');
  });
});
