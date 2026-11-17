/**
 * Optimization-level and LTO detection for an OHOS native binary (HapRay
 * parity row 27).
 *
 * HapRay's `opt-detector` answers two questions — "which `-O` level was this
 * built at?" and "was LTO on?" — by feeding raw `.text` bytes to a ~2 GB
 * TensorFlow LSTM and a 551-feature SVM, then printing the guess as a
 * percentage. Its own source records the accuracy: at the threshold it ships,
 * low-optimization binaries are misreported 16.7% of the time, and the model
 * is AArch64-only.
 *
 * This does not ship that model. It reads the ELF instead, because the ELF
 * records several of the answers:
 *
 * - **LTO** leaves `lto_priv.*` symbols (GCC's own bookkeeping for a symbol
 *   that survived link-time optimization with local visibility) and
 *   `.gnu.lto_*` sections. Their presence is evidence; their absence from a
 *   file that still has a symbol table is evidence of absence. A stripped file
 *   with no symbol table is `unknown`, not `absent` — the markers may simply
 *   have been removed.
 * - **The `-O` level** is recorded in `.comment` when the toolchain writes it.
 *   That is the compiler's own statement, so it wins over any inference.
 * - **The instruction mix** is a fact about the bytes: SIMD density, branch
 *   density and call/return balance all shift with optimization. When nothing
 *   recorded the level, the mix produces a verdict labelled `inferred`, with
 *   the signals named so a reader can disagree with it.
 *
 * What is never done is presenting an inference as a measurement. The
 * `fidelity` on each metric says which it is.
 */

import { OhosPerfError } from '../errors';
import type { AnalyzerSection } from '../analyze/engine';
import { evidence, type Evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { TimeRange } from '../types';
import { countInstructions, EM_AARCH64, readElf, type InstructionCounts } from './elf';
import { isZip, openZip } from './zip';

/** One binary to inspect: its archive-relative path and its bytes. */
export interface BinaryInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** What the ELF itself records, before any judgement is applied. */
export interface BinaryFacts {
  readonly path: string;
  readonly size: number;
  readonly machine: number;
  /** Bytes of the `.text` section; 0 when the file has none. */
  readonly textBytes: number;
  readonly instructions: InstructionCounts;
  /**
   * `present` when an LTO marker was found, `absent` when a symbol table
   * exists and none was, `unknown` when there is no symbol table to search.
   */
  readonly lto: 'present' | 'absent' | 'unknown';
  /** The symbols and sections that proved LTO, in the order they were found. */
  readonly ltoMarkers: readonly string[];
  readonly debug: boolean;
  readonly debugSections: readonly string[];
  /** NUL-separated strings from `.comment`, in file order. */
  readonly compiler: readonly string[];
  /** `-O` flags the build recorded, in file order. */
  readonly recordedFlags: readonly string[];
  readonly symbols: {
    readonly functions: number;
    readonly global: number;
    readonly local: number;
    readonly weak: number;
  };
  /** True when no function symbol survived, so symbol-level LTO evidence is gone. */
  readonly stripped: boolean;
}

export type OptimizationLevel = 'unoptimized' | 'low' | 'medium' | 'high' | 'unknown';

/** How a level was decided: the compiler said so, or the mix was read. */
export type OptimizationBasis = 'recorded' | 'inferred' | 'none';

export interface OptimizationVerdict {
  readonly level: OptimizationLevel;
  readonly basis: OptimizationBasis;
  /** The signals that produced an `inferred` verdict; empty otherwise. */
  readonly signals: readonly string[];
}

/** One inspected binary, with the facts and the verdict kept apart. */
export interface BinaryReport {
  readonly path: string;
  readonly facts: BinaryFacts;
  readonly verdict: OptimizationVerdict;
}

export interface OptimizationAnalysis {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly binaries: readonly BinaryReport[];
  readonly totals: {
    readonly binaries: number;
    readonly lto: number;
    readonly debug: number;
    readonly stripped: number;
  };
  readonly metrics: Metric[];
  readonly evidence: Evidence[];
}

const OFFLINE_WINDOW: TimeRange = { startNs: 0, endNs: 0 };

/** A symbol name or section name that only LTO produces. */
const LTO_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^lto_priv\./, why: 'lto_priv symbol' },
  { pattern: /^\.gnu\.lto_/, why: '.gnu.lto section' },
  { pattern: /^\.gnu\.lto$/, why: '.gnu.lto section' },
  { pattern: /^lto_[0-9]+\.[0-9]+$/, why: 'lto_N.M symbol' },
];

/** Flags that state a level outright. `-Oz` and `-Ofast` fold into their peers. */
const RECORDED_FLAG = /^-(O[0-3s]|Oz|Ofast)$/;

const LEVEL_OF_FLAG: Readonly<Record<string, OptimizationLevel>> = {
  '-O0': 'unoptimized',
  '-O1': 'low',
  '-O2': 'medium',
  '-O3': 'high',
  '-Os': 'medium',
  '-Oz': 'medium',
  '-Ofast': 'high',
};

/**
 * Vector density at or above this reads as an optimized build.
 *
 * Calibrated against real release libraries rather than guessed: `-O0` does
 * not auto-vectorize at all, so any meaningful SIMD density means the compiler
 * was optimizing. Three unoptimized-looking candidates measured 15.7%, 20.4%
 * and 23.5% — HapRay's own detector calls the last of them "O3 dominant" — so
 * a 25% ceiling would have called every real release build "medium".
 */
const VECTOR_DENSITY_HIGH = 0.10;
/** At or below this the build kept the scalar form, which reads as unoptimized. */
const VECTOR_DENSITY_NONE = 0.02;

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** The strings of a `.comment` section, split on NUL and trimmed. */
function commentStrings(bytes: Uint8Array): string[] {
  return decode(bytes)
    .split('\u0000')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Inspect one ELF.
 *
 * A refusal names the binary, because a package holds many and "not an ELF"
 * alone would not say which one the caller has to look at.
 */
export function inspectBinary(input: BinaryInput): BinaryFacts {
  let elf;
  try {
    elf = readElf(input.bytes);
  } catch (err) {
    throw new OhosPerfError(
      `${input.path}: ${(err as Error).message}`,
      { code: 'ELF_INVALID', cause: err },
    );
  }

  const textSection = elf.section('.text');
  const textBytes = textSection?.size ?? 0;
  const instructions = countInstructions(elf.bytesOf('.text'));

  const symbolTablePresent = elf.sections.some(
    (section) => section.type === 2 || section.type === 11,
  );

  const ltoMarkers: string[] = [];
  for (const section of elf.sections) {
    if (LTO_PATTERNS.some((entry) => entry.pattern.test(section.name))) {
      ltoMarkers.push(section.name);
    }
  }
  for (const symbol of elf.symbols) {
    if (LTO_PATTERNS.some((entry) => entry.pattern.test(symbol.name))) {
      ltoMarkers.push(symbol.name);
    }
  }
  const lto: BinaryFacts['lto'] = ltoMarkers.length > 0
    ? 'present'
    : symbolTablePresent ? 'absent' : 'unknown';

  const debugSections = elf.sections
    .map((section) => section.name)
    .filter((name) => name.startsWith('.debug_') || name === '.zdebug_info');

  const commentSection = elf.section('.comment');
  const compiler = commentSection === undefined ? [] : commentStrings(elf.bytesOf('.comment'));
  const recordedFlags: string[] = [];
  for (const line of compiler) {
    for (const token of line.split(/\s+/)) {
      if (RECORDED_FLAG.test(token) && !recordedFlags.includes(token)) recordedFlags.push(token);
    }
  }

  const functions = elf.symbols.filter((symbol) => symbol.type === 'func');
  const countBind = (bind: string): number =>
    functions.filter((symbol) => symbol.bind === bind).length;

  return {
    path: input.path,
    size: input.bytes.length,
    machine: elf.machine,
    textBytes,
    instructions,
    lto,
    ltoMarkers,
    debug: debugSections.length > 0,
    debugSections,
    compiler,
    recordedFlags,
    symbols: {
      functions: functions.length,
      global: countBind('global'),
      local: countBind('local'),
      weak: countBind('weak'),
    },
    stripped: functions.length === 0,
  };
}

/**
 * Decide the optimization level, preferring what the compiler recorded.
 *
 * The inference is deliberately coarse: three signals, two thresholds. A
 * richer model would be a guess dressed as a measurement, which is the defect
 * this row exists to fix.
 */
export function classifyOptimization(facts: BinaryFacts): OptimizationVerdict {
  for (const flag of facts.recordedFlags) {
    const level = LEVEL_OF_FLAG[flag];
    if (level !== undefined) return { level, basis: 'recorded', signals: [] };
  }

  const total = facts.instructions.total;
  if (total === 0) {
    // Nothing to read. HapRay would run its model on an empty tensor and
    // report whatever fell out; saying "unknown" is the honest answer.
    return { level: 'unknown', basis: 'none', signals: [] };
  }

  const vectorDensity = facts.instructions.vector / total;
  // A build that vectorises was optimized, whatever else it carries: a `-g`
  // release build keeps debug info and is still `-O2`. So the vector check
  // comes first, and debug sections only decide the builds that did not.
  if (vectorDensity >= VECTOR_DENSITY_HIGH) {
    return { level: 'high', basis: 'inferred', signals: ['vector_density'] };
  }
  if (facts.debug) {
    return {
      level: 'unoptimized',
      basis: 'inferred',
      signals: vectorDensity <= VECTOR_DENSITY_NONE
        ? ['debug_sections', 'no_vector_code']
        : ['debug_sections'],
    };
  }
  if (vectorDensity <= VECTOR_DENSITY_NONE) {
    return { level: 'low', basis: 'inferred', signals: ['no_vector_code'] };
  }
  return { level: 'medium', basis: 'inferred', signals: ['vector_density'] };
}

const ARM64_LIBRARY = /^(?:libs|lib)\/arm64(?:-v8a)?\//;
const SHARED_OBJECT = /\.so(?:\.|$)/;

/**
 * Pull the arm64 shared objects out of a package, or take a bare `.so`.
 *
 * An `ar` archive is refused by name: it is a third container format, and
 * returning an empty report for one would read as "no optimizations found"
 * when the truth is "this package did not look".
 */
export function extractBinaries(input: BinaryInput): BinaryInput[] {
  if (input.path.endsWith('.a')) {
    throw new OhosPerfError(
      `${input.path}: an .a archive is not read by this package; pass the .so files` +
        ' (or the package that contains them) instead',
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }
  if (!isZip(input.bytes)) {
    return [{ path: input.path, bytes: input.bytes }];
  }

  const archive = openZip(input.bytes);
  const binaries: BinaryInput[] = [];
  for (const entry of archive.entries) {
    if (!ARM64_LIBRARY.test(entry.name)) continue;
    if (!SHARED_OBJECT.test(entry.name)) continue;
    const bytes = archive.read(entry);
    // HapRay checks the ELF magic after extraction for the same reason: a
    // linker script named `.so` is not a library.
    if (bytes.length < 4 || bytes[0] !== 0x7f || bytes[1] !== 0x45) continue;
    binaries.push({ path: entry.name, bytes });
  }
  if (binaries.length === 0) {
    throw new OhosPerfError(
      `${input.path}: no arm64 libraries (libs/arm64/*.so) in the package`,
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }
  return binaries;
}

function offlineProvenance(rows: number): Metric['provenance'] {
  return { collector: 'offline', table: 'elf', rows, device: 'offline' };
}

const LEVEL_IDS: Readonly<Record<OptimizationLevel, string>> = {
  unoptimized: 'binary.unoptimized.files.count',
  low: 'binary.low.optimization.files.count',
  medium: 'binary.medium.optimization.files.count',
  high: 'binary.high.optimization.files.count',
  unknown: 'binary.unknown.optimization.files.count',
};

function buildMetrics(binaries: readonly BinaryReport[]): Metric[] {
  const rows = binaries.length;
  const make = (
    id: string, value: number, unit: Metric['unit'], fidelity: Metric['fidelity'],
  ): Metric => metric({
    id, value, unit, fidelity,
    provenance: offlineProvenance(rows),
    window: OFFLINE_WINDOW,
  });

  const metrics: Metric[] = [
    make('binary.files.count', rows, 'count', 'exact'),
    make('binary.text.bytes', binaries.reduce((sum, b) => sum + b.facts.textBytes, 0), 'bytes', 'exact'),
    make(
      'binary.instructions.count',
      binaries.reduce((sum, b) => sum + b.facts.instructions.total, 0),
      'count', 'exact',
    ),
    make('binary.lto.files.count', binaries.filter((b) => b.facts.lto === 'present').length, 'count', 'exact'),
    make('binary.lto.unknown.files.count', binaries.filter((b) => b.facts.lto === 'unknown').length, 'count', 'exact'),
    make('binary.debug.files.count', binaries.filter((b) => b.facts.debug).length, 'count', 'exact'),
    make('binary.stripped.files.count', binaries.filter((b) => b.facts.stripped).length, 'count', 'exact'),
  ];

  // The level is a verdict over the instruction mix, so its count is a proxy:
  // the mix was measured, the level was inferred from it.
  const byLevel = new Map<OptimizationLevel, number>();
  for (const binary of binaries) {
    byLevel.set(binary.verdict.level, (byLevel.get(binary.verdict.level) ?? 0) + 1);
  }
  for (const level of ['unoptimized', 'low', 'medium', 'high', 'unknown'] as const) {
    const count = byLevel.get(level) ?? 0;
    if (count === 0) continue;
    metrics.push(make(LEVEL_IDS[level], count, 'count', 'proxy'));
  }

  return metrics.sort((a, b) => byString(a.id, b.id));
}

function buildEvidence(
  packageName: string,
  binaries: readonly BinaryReport[],
): Evidence[] {
  const subject = { process: packageName };
  const items: Evidence[] = [];

  for (const binary of binaries) {
    if (binary.facts.lto === 'present') {
      items.push(evidence({
        kind: 'optimization',
        severity: 'info',
        subject,
        window: OFFLINE_WINDOW,
        signals: {
          path: binary.path,
          lto: 'present',
          markers: binary.facts.ltoMarkers.length,
          level: binary.verdict.level,
          basis: binary.verdict.basis,
        },
        explain:
          `${binary.path} was linked with LTO: ` +
          `${binary.facts.ltoMarkers.slice(0, 3).join(', ')}` +
          (binary.facts.ltoMarkers.length > 3 ? `, and ${binary.facts.ltoMarkers.length - 3} more` : ''),
        drillDown: [],
        key: `${binary.path}:lto`,
      }));
    }
    if (binary.facts.instructions.total === 0) {
      items.push(evidence({
        kind: 'no_data',
        severity: 'info',
        subject,
        window: OFFLINE_WINDOW,
        signals: { path: binary.path },
        explain:
          `${binary.path} has no instructions in .text, so its optimization level was not` +
          ' measured; a binary with no code carries no evidence either way',
        drillDown: [],
        key: `${binary.path}:no-text`,
      }));
    }
    if (binary.verdict.level === 'unoptimized' || binary.verdict.level === 'low') {
      items.push(evidence({
        kind: 'optimization',
        severity: binary.verdict.level === 'unoptimized' ? 'warn' : 'info',
        subject,
        window: OFFLINE_WINDOW,
        signals: {
          path: binary.path,
          level: binary.verdict.level,
          basis: binary.verdict.basis,
          signals: [...binary.verdict.signals],
          vectorDensity: binary.facts.instructions.total === 0
            ? 0
            : Math.round((binary.facts.instructions.vector / binary.facts.instructions.total) * 10_000) / 10_000,
        },
        explain:
          `${binary.path} reads as ${binary.verdict.level} optimization` +
          (binary.verdict.basis === 'recorded'
            ? ` from its recorded flag ${binary.facts.recordedFlags.join(' ')}`
            : ` from its instruction mix (${binary.verdict.signals.join(', ')})`),
        drillDown: [],
        key: `${binary.path}:level`,
      }));
    }
  }

  return items.sort((a, b) => byString(a.kind, b.kind) || byString(a.id, b.id));
}

/**
 * Measure every binary and summarise the package.
 *
 * Binaries are sorted by path, and every number is derived from the bytes, so
 * two runs over the same package produce the same document.
 */
export function analyzeBinaries(
  inputs: readonly BinaryInput[],
  packageName: string,
): OptimizationAnalysis {
  const binaries: BinaryReport[] = [...inputs]
    .sort((a, b) => byString(a.path, b.path))
    .map((input) => {
      const facts = inspectBinary(input);
      return { path: facts.path, facts, verdict: classifyOptimization(facts) };
    });

  return {
    schemaVersion: 1,
    package: packageName,
    binaries,
    totals: {
      binaries: binaries.length,
      lto: binaries.filter((binary) => binary.facts.lto === 'present').length,
      debug: binaries.filter((binary) => binary.facts.debug).length,
      stripped: binaries.filter((binary) => binary.facts.stripped).length,
    },
    metrics: buildMetrics(binaries),
    evidence: buildEvidence(packageName, binaries),
  };
}

/** Wrap an analysis as the `optimization` section the report renderer takes. */
export function optimizationSection(analysis: OptimizationAnalysis): AnalyzerSection {
  return {
    analyzerId: 'optimization',
    status: 'measured',
    result: { metrics: analysis.metrics, evidence: analysis.evidence },
  };
}
