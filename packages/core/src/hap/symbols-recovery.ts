/**
 * Symbol recovery (HapRay parity row 28).
 *
 * HapRay's `symbol_recovery` tool answers "which function is
 * `libquick.so+0xc8a7c`?" by shelling out to radare2: `aflj` for the function
 * list, `afij` for boundaries, `pdfj` for disassembly, a decompiler plugin for
 * pseudo-C, then an LLM prompt built from the strings and call sites. Its own
 * documentation records the shape of the heuristic it is built on — a function
 * over 100 KB is "unreasonable, skip", and a function that cannot be found
 * gets a default size of 2000 bytes. Nothing in the tool measures whether the
 * name it prints is right.
 *
 * An ELF already answers the first half exactly. Every `STT_FUNC` symbol
 * carries an address (`st_value`) and a size (`st_size`), so "which function
 * contains this offset" is a lookup over sorted symbols — not a disassembly,
 * not a boundary heuristic, and not a guess when the lookup misses.
 *
 * The second half — naming a function whose symbol was stripped — is what the
 * model is for. What HapRay has no answer for is whether the model is any
 * good: it never compares a recovered name to a known one. This module adds
 * that. {@link measureNaming} holds out names the file *does* record, asks the
 * model to infer them from the same evidence it would have on a stripped file,
 * and reports the accuracy — so a run says "this model named 12 of 20 held-out
 * functions correctly" rather than "these are the names".
 */

import { OhosPerfError } from '../errors';
import { countInstructions, readElf, type ElfFile, type ElfSymbol, type InstructionCounts } from './elf';

/** One function body, as the symbols describe it. */
export interface FunctionRange {
  readonly name: string;
  /** Address of the first byte, from `st_value`. */
  readonly start: number;
  /** Address one past the last byte (`start + st_size`). */
  readonly end: number;
  readonly size: number;
  readonly bind: ElfSymbol['bind'];
}

/** A `libfoo.so+0xoffset` reference, split into its two halves. */
export interface AddressRef {
  readonly library: string;
  readonly offset: number;
}

/** A recovered name, and what it was recovered from. */
export interface RecoveredSymbol {
  readonly address: string;
  readonly offset: number;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /**
   * `recorded` when the ELF's own symbol table named it. There is no
   * `inferred` yet: inference is the model's job and its result is a
   * {@link NamingCase}, not a recovered symbol.
   */
  readonly basis: 'recorded';
}

/** An address this module could not locate, with the reason. */
export interface UnresolvedAddress {
  readonly address: string;
  readonly reason: string;
}

export interface RecoveryResult {
  readonly recovered: readonly RecoveredSymbol[];
  readonly unresolved: readonly UnresolvedAddress[];
}

const ADDRESS_FORM = /^(.+)\+0x([0-9a-fA-F]+)$/;

/**
 * Split a `libfoo.so+0x1cce24` reference.
 *
 * `undefined` for anything else: a resolved symbol is a name, and treating it
 * as an address would put a name in the library column and invent an offset.
 */
export function addressOfOffset(symbol: string): AddressRef | undefined {
  const match = ADDRESS_FORM.exec(symbol);
  if (match === null) return undefined;
  const offset = Number.parseInt(match[2]!, 16);
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
  return { library: match[1]!, offset };
}

/**
 * The function ranges an ELF records, sorted by start address.
 *
 * A zero-size symbol is dropped: it marks a boundary (an alias, or a label the
 * compiler emitted) and has no extent, so treating it as a function would
 * claim every address after it.
 */
export function symbolIndex(elf: ElfFile): FunctionRange[] {
  return elf.symbols
    .filter((symbol) => symbol.type === 'func' && symbol.size > 0 && symbol.name !== '')
    .map((symbol) => ({
      name: symbol.name,
      start: symbol.value,
      end: symbol.value + symbol.size,
      size: symbol.size,
      bind: symbol.bind,
    }))
    .sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The function containing `offset`, or `undefined`.
 *
 * The size a symbol records is authoritative: a function can be followed by
 * padding or by another section, and extending it to the next symbol would
 * claim bytes that are not its body.
 */
export function functionAt(
  index: readonly FunctionRange[],
  offset: number,
): FunctionRange | undefined {
  for (const range of index) {
    if (range.start > offset) return undefined;
    if (offset >= range.start && offset < range.end) return range;
  }
  return undefined;
}

/**
 * Name every unresolved address the ELF can locate.
 *
 * Addresses are processed in sorted order so the same input in a different
 * order produces the same document — the determinism rule the rest of this
 * package follows.
 */
export function recoverSymbols(
  bytes: Uint8Array,
  unresolved: readonly string[],
): RecoveryResult {
  const elf = readElf(bytes);
  const index = symbolIndex(elf);
  const stripped = index.length === 0;

  const recovered: RecoveredSymbol[] = [];
  const missed: UnresolvedAddress[] = [];

  for (const address of [...unresolved].sort()) {
    const ref = addressOfOffset(address);
    if (ref === undefined) {
      missed.push({ address, reason: 'not an address of the form lib.so+0xoffset' });
      continue;
    }
    if (stripped) {
      missed.push({
        address,
        reason: 'the file has no symbol table (it is stripped), so no function boundary is recorded',
      });
      continue;
    }
    const found = functionAt(index, ref.offset);
    if (found === undefined) {
      missed.push({ address, reason: `no function recorded at ${address}` });
      continue;
    }
    recovered.push({
      address,
      offset: ref.offset,
      name: found.name,
      start: found.start,
      end: found.end,
      basis: 'recorded',
    });
  }

  return { recovered, unresolved: missed };
}

/** One held-out function, and what the model answered for it. */
export interface NamingCase {
  readonly truth: string;
  readonly answer: string;
  readonly correct: boolean;
  readonly start: number;
  readonly size: number;
}

export interface NamingReport {
  /** Functions the model was asked to name. */
  readonly heldOut: number;
  readonly correct: number;
  /** `correct / heldOut`, or `undefined` when nothing was held out. */
  readonly accuracy: number | undefined;
  readonly cases: readonly NamingCase[];
}

/** What the model is given about one function it must name. */
export interface NamingQuestion {
  /** The name being held out — the model must not see this. */
  readonly truth: string;
  readonly start: number;
  readonly size: number;
  readonly bind: ElfSymbol['bind'];
  /**
   * The function's own bytes, so the model has evidence rather than a prompt
   * asking it to guess. HapRay gets this from radare2's disassembly; here it
   * is the `.text` slice the symbol points at.
   */
  readonly body: Uint8Array;
  /** The instruction classes in the body, which is what a reader sees first. */
  readonly counts: InstructionCounts;
}

/** The model, as this module needs it: one function in, one name out. */
export type NamingAnswer = (question: NamingQuestion) => Promise<string>;

/** A placeholder a tool prints when it has no name; not a name to score. */
const PLACEHOLDER = /^(?:fcn|sym|sub|loc|unk|fun)[._][0-9a-f]+$/i;

/**
 * Reduce a name to what it means, so formatting does not score as a mistake.
 *
 * `sym.parseExpression`, `parseExpression(int)` and `_Z12parseExpressionv`
 * are the same function. Counting them wrong would measure a model's
 * punctuation habits rather than its understanding.
 */
export function normaliseName(name: string): string {
  let text = name.trim();
  // A tool's prefix: `sym.`, `sym.imp.`, `fcn.`, and radare2's own `fcn.000…`.
  text = text.replace(/^(?:sym\.(?:imp\.)?|fcn\.)/i, '');
  // A trailing signature or argument list.
  text = text.replace(/\(.*\)$/, '');
  // A trailing return-type annotation some models add.
  text = text.replace(/\s*->.*$/, '');
  // A leading `_` or `_Z`-style mangling prefix; the digits are the length.
  text = text.replace(/^_Z\d+/, '');
  text = text.replace(/^_+/, '');
  return text.toLowerCase();
}

/** A recorded symbol whose name is a real name rather than a placeholder. */
function isNameable(symbol: ElfSymbol): boolean {
  if (symbol.type !== 'func' || symbol.size === 0) return false;
  if (symbol.name === '') return false;
  if (PLACEHOLDER.test(symbol.name)) return false;
  return true;
}

/**
 * Measure how well a model names functions whose names are known.
 *
 * Every nameable function is held out in turn: the model is asked for a name
 * from the same evidence it would have on a stripped file, and its answer is
 * compared to the truth. The result is an accuracy over a stated number of
 * cases — the number HapRay's tool never reports, which is what makes its
 * output impossible to trust or to compare between models.
 *
 * A file with nothing to hold out reports `accuracy: undefined` rather than
 * zero: 0% over zero cases reads as a broken model when the truth is that
 * there was nothing to measure.
 */
export async function measureNaming(
  bytes: Uint8Array,
  answer: NamingAnswer,
): Promise<NamingReport> {
  const elf = readElf(bytes);
  const held = elf.symbols
    .filter(isNameable)
    .map((symbol) => ({
      truth: symbol.name,
      start: symbol.value,
      size: symbol.size,
      bind: symbol.bind,
    }))
    .sort((a, b) => a.start - b.start || (a.truth < b.truth ? -1 : a.truth > b.truth ? 1 : 0));

  // The bytes a symbol points at, from the section it belongs to. A shared
  // object's `st_value` is the file offset, so the slice is direct; a symbol
  // that points outside `.text` gets an empty body rather than a wrong one.
  const text = elf.bytesOf('.text');
  const textStart = elf.section('.text')?.offset ?? 0;
  const bodyOf = (start: number, size: number): Uint8Array => {
    const from = start - textStart;
    if (from < 0 || from + size > text.length) return new Uint8Array(0);
    return text.subarray(from, from + size);
  };

  const cases: NamingCase[] = [];
  for (const held_out of held) {
    const body = bodyOf(held_out.start, held_out.size);
    const question: NamingQuestion = {
      ...held_out,
      body,
      counts: countInstructions(body),
    };
    let reply: string;
    try {
      reply = await answer(question);
    } catch (err) {
      throw new OhosPerfError(
        `naming ${question.truth} failed: ${(err as Error).message}`,
        { code: 'AGENT_NAMING_FAILED', cause: err },
      );
    }
    cases.push({
      truth: question.truth,
      answer: reply,
      correct: normaliseName(reply) === normaliseName(question.truth),
      start: question.start,
      size: question.size,
    });
  }

  const correct = cases.filter((entry) => entry.correct).length;
  return {
    heldOut: cases.length,
    correct,
    accuracy: cases.length === 0 ? undefined : correct / cases.length,
    cases,
  };
}
