// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import { OhosPerfError } from '../errors';
import type { InventoryFile } from './inventory';
import type { ZipArchive, ZipEntry } from './zip';

/*
 * Technology-stack detection as data.
 *
 * HapRay keeps its rules in `res/techstack/techstack-config.yaml`; this is that
 * file as typed values, with the same kinds, the same arithmetic and the same
 * shipped detections. The rules decide what an app is built with by looking at
 * what it ships — a file name, a path, a magic number, a string in a binary.
 * Nothing here reads an ELF symbol table: HapRay's custom extractors need one,
 * and a rule that only matched when an ELF parser agreed would silently vanish
 * from this tool. The metadata fields those extractors fill are simply absent.
 */

export type RuleMatchKind = 'filename' | 'path' | 'extension' | 'magic' | 'content' | 'combined';

/** A content pattern, optionally carrying its own confidence (HapRay's YAML). */
export interface ContentPattern {
  readonly pattern: string;
  readonly confidence?: number;
}

export interface FileRule {
  readonly kind: RuleMatchKind;
  /** Regex sources, tried in order. */
  readonly patterns?: readonly (string | ContentPattern)[];
  readonly extensions?: readonly string[];
  readonly bytes?: readonly number[];
  readonly offset?: number;
  readonly operator?: 'and' | 'or' | 'not';
  readonly rules?: readonly FileRule[];
  /** Multiplies the rule's confidence when this file rule decides the match. */
  readonly confidence?: number;
}

/** One field read out of a matched file, beside the match. */
export interface MetadataPattern {
  readonly field: string;
  readonly source: 'content' | 'path' | 'filename';
  readonly pattern: string;
  readonly captureGroup?: number;
}

export interface TechRule {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly confidence: number;
  readonly fileRules: readonly FileRule[];
  /** When true, a file match without extracted metadata is not a match. */
  readonly requireMetadata?: boolean;
  readonly metadataPatterns?: readonly MetadataPattern[];
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly type: string;
  readonly confidence: number;
  readonly files: InventoryFile[];
  readonly bytes: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * HapRay's `excludes`: entries under these paths are not offered to any rule.
 *
 * Its config excludes `resources/base/.*`, and keeping the exclusion means the
 * same package yields the same detections here as there.
 */
export const EXCLUDE_PATTERNS: readonly string[] = ['resources/base/.*'];

const KINDS: readonly RuleMatchKind[] = ['filename', 'path', 'extension', 'magic', 'content', 'combined'];

function fail(ruleId: string, message: string): never {
  throw new OhosPerfError(`rule ${JSON.stringify(ruleId)}: ${message}`, { code: 'HAP_BAD_RULE' });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Compile a regex, refusing a bad source rather than skipping the pattern. */
function compile(ruleId: string, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (err) {
    return fail(ruleId, `invalid pattern ${JSON.stringify(source)}: ${(err as Error).message}`);
  }
}

/** One file's verdict on one file rule, plus the confidence it carries. */
interface FileVerdict {
  readonly matched: boolean;
  readonly confidence?: number;
}

/**
 * Everything a match needs about one entry: its name and, when a magic or
 * content rule asks, its inflated bytes.
 *
 * Bytes are held for the duration of one file's rules and released before the
 * next file. Caching every entry instead would hold a whole package in memory
 * — a 100 MB archive peaked near 500 MB — to answer questions that each need
 * one entry at a time.
 */
class EntryReader {
  private readonly byName: Map<string, ZipEntry>;
  private cache = new Map<string, Uint8Array | undefined>();

  constructor(private readonly archive: ZipArchive) {
    this.byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
  }

  /** Drop what was inflated for the previous file. */
  release(): void {
    this.cache = new Map();
  }

  bytes(path: string): Uint8Array | undefined {
    if (!this.cache.has(path)) {
      const entry = this.byName.get(path);
      this.cache.set(path, entry === undefined ? undefined : this.archive.read(entry));
    }
    return this.cache.get(path);
  }
}

function matchContent(
  ruleId: string,
  rule: FileRule,
  data: Uint8Array | undefined,
): FileVerdict {
  if (data === undefined) return { matched: false };
  const text = new TextDecoder('utf-8').decode(data);
  let best: number | undefined;
  for (const item of rule.patterns ?? []) {
    const source = typeof item === 'string' ? item : item.pattern;
    const own = typeof item === 'string' ? undefined : item.confidence;
    if (!compile(ruleId, source).test(text)) continue;
    const confidence = own ?? rule.confidence ?? 1;
    best = best === undefined ? confidence : Math.max(best, confidence);
  }
  return best === undefined ? { matched: false } : { matched: true, confidence: best };
}

function matchOne(ruleId: string, rule: FileRule, file: InventoryFile, reader: EntryReader): FileVerdict {
  switch (rule.kind) {
    case 'filename': {
      const name = basename(file.path);
      for (const item of rule.patterns ?? []) {
        const source = typeof item === 'string' ? item : item.pattern;
        if (compile(ruleId, source).test(name)) return { matched: true, confidence: rule.confidence ?? 1 };
      }
      return { matched: false };
    }
    case 'path': {
      for (const item of rule.patterns ?? []) {
        const source = typeof item === 'string' ? item : item.pattern;
        if (compile(ruleId, source).test(file.path)) return { matched: true, confidence: rule.confidence ?? 1 };
      }
      return { matched: false };
    }
    case 'extension': {
      for (const extension of rule.extensions ?? []) {
        if (file.extension === extension.toLowerCase()) {
          return { matched: true, confidence: rule.confidence ?? 1 };
        }
      }
      return { matched: false };
    }
    case 'magic': {
      const data = reader.bytes(file.path);
      if (data === undefined) return { matched: false };
      const offset = rule.offset ?? 0;
      const bytes = rule.bytes ?? [];
      if (data.length < offset + bytes.length) return { matched: false };
      for (let index = 0; index < bytes.length; index++) {
        if (data[offset + index] !== bytes[index]) return { matched: false };
      }
      return { matched: true, confidence: rule.confidence ?? 1 };
    }
    case 'content':
      return matchContent(ruleId, rule, reader.bytes(file.path));
    case 'combined': {
      const subRules = rule.rules ?? [];
      if (rule.operator === 'and') {
        // Evaluate in order and stop at the first failure: a cheap extension
        // test that fails means a later magic or content rule never has to
        // inflate the entry. Confidence is unchanged, since a failed `and`
        // reports no match at all.
        const verdicts: FileVerdict[] = [];
        for (const sub of subRules) {
          const verdict = matchOne(ruleId, sub, file, reader);
          if (!verdict.matched) return { matched: false };
          verdicts.push(verdict);
        }
        const carried = verdicts.filter((verdict) => verdict.confidence !== undefined)
          .map((verdict) => verdict.confidence!);
        const confidence = rule.confidence ?? (carried.length === 0 ? undefined : Math.max(...carried));
        return confidence === undefined ? { matched: true } : { matched: true, confidence };
      }
      const verdicts = subRules.map((sub) => matchOne(ruleId, sub, file, reader));
      const matched = rule.operator === 'or'
        ? verdicts.some((verdict) => verdict.matched)
        : verdicts.length > 0 && verdicts[0]!.matched && !verdicts.slice(1).some((verdict) => verdict.matched);
      if (!matched) return { matched: false };      const carried = verdicts.filter((verdict) => verdict.matched && verdict.confidence !== undefined)
        .map((verdict) => verdict.confidence!);
      const confidence = rule.confidence ?? (carried.length === 0 ? undefined : Math.max(...carried));
      return confidence === undefined ? { matched: true } : { matched: true, confidence };
    }
    default:
      return { matched: false };
  }
}

/** Extract every metadata field the rule names from one file. */
function extractMetadata(
  ruleId: string,
  rule: TechRule,
  file: InventoryFile,
  reader: EntryReader,
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const pattern of rule.metadataPatterns ?? []) {
    const source = pattern.source === 'content'
      ? new TextDecoder('utf-8').decode(reader.bytes(file.path) ?? new Uint8Array(0))
      : pattern.source === 'path' ? file.path : basename(file.path);
    const match = compile(ruleId, pattern.pattern).exec(source);
    const value = match?.[pattern.captureGroup ?? 0];
    if (value !== undefined && value !== '') metadata[pattern.field] = value;
  }
  return metadata;
}

/**
 * Run every rule against the inventory and report the rules that matched.
 *
 * A rule matches when at least one file matches it; the match carries every
 * matching file, their summed bytes, and the highest confidence any of them
 * produced. Rules keep their configured order on the way in; the output is
 * sorted by `(type, ruleId)` so two runs of the same archive agree byte for
 * byte.
 */
export function matchHapRules(
  rules: readonly TechRule[],
  archive: ZipArchive,
  inventory: readonly InventoryFile[],
): RuleMatch[] {
  validateRules(rules);
  const reader = new EntryReader(archive);
  const excludes = EXCLUDE_PATTERNS.map((pattern) => new RegExp(pattern));
  const files = inventory.filter((file) => !excludes.some((regex) => regex.test(file.path)));

  // Files are the outer loop so each entry is inflated at most once, while it
  // is offered every rule, and released before the next file is read.
  const accumulators = new Map<string, {
    hit: InventoryFile[];
    best: number | undefined;
    metadata: Record<string, string>;
  }>(rules.map((rule) => [rule.id, { hit: [], best: undefined, metadata: {} }]));

  for (const file of files) {
    reader.release();
    for (const rule of rules) {
      const state = accumulators.get(rule.id)!;
      const verdicts = rule.fileRules.map((fileRule) => matchOne(rule.id, fileRule, file, reader));
      if (!verdicts.some((verdict) => verdict.matched)) continue;
      const carried = verdicts.filter((verdict) => verdict.matched && verdict.confidence !== undefined)
        .map((verdict) => verdict.confidence!);
      const confidence = carried.length === 0 ? undefined : Math.max(...carried);
      if (confidence !== undefined) {
        state.best = state.best === undefined ? confidence : Math.max(state.best, confidence);
      }
      state.hit.push(file);
      if (Object.keys(state.metadata).length === 0) {
        const found = extractMetadata(rule.id, rule, file, reader);
        if (Object.keys(found).length > 0) state.metadata = found;
      }
    }
  }

  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const { hit, best, metadata } = accumulators.get(rule.id)!;
    if (hit.length === 0) continue;
    if (rule.requireMetadata === true && Object.keys(metadata).length === 0) continue;
    matches.push({
      ruleId: rule.id,
      ruleName: rule.name,
      type: rule.type,
      confidence: best === undefined ? rule.confidence : rule.confidence * best,
      files: hit,
      bytes: hit.reduce((sum, file) => sum + file.size, 0),
      metadata,
    });
  }

  return matches.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });
}

/**
 * Refuse a rule set that cannot run: an unknown kind, an invalid regex, or a
 * malformed combined rule. HapRay logs a warning and skips the pattern, which
 * turns a typo into a detection that never fires; a load-time refusal names
 * the rule instead.
 */
export function validateRules(rules: readonly TechRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) fail(rule.id, 'duplicate rule id');
    seen.add(rule.id);
    if (rule.fileRules.length === 0) fail(rule.id, 'has no file rules');
    if (rule.requireMetadata === true && (rule.metadataPatterns ?? []).length === 0) {
      fail(rule.id, 'requires metadata but names no metadata pattern');
    }
    for (const pattern of rule.metadataPatterns ?? []) {
      if (pattern.source !== 'content' && pattern.source !== 'path' && pattern.source !== 'filename') {
        fail(rule.id, `metadata field ${JSON.stringify(pattern.field)} has unknown source ${JSON.stringify(pattern.source)}`);
      }
      compile(rule.id, pattern.pattern);
    }
    validateFileRules(rule.id, rule.fileRules);
  }
}

function validateFileRules(ruleId: string, rules: readonly FileRule[]): void {
  for (const rule of rules) {
    if (!KINDS.includes(rule.kind)) fail(ruleId, `unknown rule kind ${JSON.stringify(rule.kind)}`);
    switch (rule.kind) {
      case 'filename':
      case 'path':
      case 'content':
        if ((rule.patterns ?? []).length === 0) fail(ruleId, `a ${rule.kind} rule names no pattern`);
        for (const item of rule.patterns ?? []) compile(ruleId, typeof item === 'string' ? item : item.pattern);
        break;
      case 'extension':
        if ((rule.extensions ?? []).length === 0) fail(ruleId, 'an extension rule names no extension');
        break;
      case 'magic':
        if ((rule.bytes ?? []).length === 0) fail(ruleId, 'a magic rule names no bytes');
        for (const byte of rule.bytes ?? []) {
          if (!Number.isInteger(byte) || byte < 0 || byte > 255) fail(ruleId, `magic byte ${byte} is not a byte`);
        }
        break;
      case 'combined':
        if (rule.operator !== 'and' && rule.operator !== 'or' && rule.operator !== 'not') {
          fail(ruleId, `combined rule has operator ${JSON.stringify(rule.operator)}`);
        }
        if ((rule.rules ?? []).length === 0) fail(ruleId, 'a combined rule names no sub-rules');
        validateFileRules(ruleId, rule.rules ?? []);
        break;
    }
  }
}

/**
 * HapRay's shipped detections, in its own order.
 *
 * Ids and types are the upstream ones so a comparison against its output is
 * meaningful. The ELF-backed metadata fields (`soDependencies`, `Key`,
 * `openSourcePackages`, …) are not ported; see the module comment.
 */
export const TECH_RULES: readonly TechRule[] = [
  {
    id: 'SO_Files',
    name: 'SO Files',
    type: 'SO',
    confidence: 0.9,
    fileRules: [{ kind: 'filename', patterns: ['.*\\.so$'] }],
  },
  {
    id: 'Flutter',
    name: 'Flutter',
    type: 'Flutter',
    confidence: 0.95,
    requireMetadata: true,
    fileRules: [{ kind: 'filename', patterns: ['libflutter\\.so$', 'libapp\\.so$'] }],
    metadataPatterns: [{
      field: 'dartVersion',
      source: 'content',
      pattern: '(\\d+\\.\\d+\\.\\d+) \\(stable\\)',
      captureGroup: 1,
    }],
  },
  {
    id: 'FlutterAssets',
    name: 'Flutter Assets',
    type: 'Flutter',
    confidence: 0.95,
    fileRules: [{ kind: 'path', patterns: ['flutter_assets/.*'] }],
    metadataPatterns: [{
      field: 'flutterVersion',
      source: 'content',
      pattern: '"flutterVersion":"(\\d+\\.\\d+\\.\\d+)"',
      captureGroup: 1,
    }],
  },
  {
    id: 'RN_LibReact',
    name: 'React Native',
    type: 'RN',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: [
        'libreact_.*\\.so$', 'libreact_.*\\.so', 'librnoh\\.so', 'librnoh_.*\\.so',
        'libjsi\\.so', 'libjsinspector\\.so',
      ],
    }],
  },
  {
    id: 'Hermes_Engine',
    name: 'Hermes JavaScript Engine',
    type: 'RN',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libhermes\\.so$'] }],
  },
  {
    id: 'RN bundles',
    name: 'RN bundles',
    type: 'RN',
    confidence: 0.9,
    fileRules: [
      { kind: 'extension', extensions: ['hbc', 'jsbundle'] },
      {
        // HapRay's bare magic rule, gated on the extensions a Hermes bundle
        // ships under. Ungated it is offered every entry in the archive and
        // inflates all of them; the detection is unchanged.
        kind: 'combined',
        operator: 'and',
        rules: [
          { kind: 'extension', extensions: ['hbc', 'jsbundle', 'bundle'] },
          { kind: 'magic', bytes: [0xc2, 0x1f, 0xf0, 0x9f] },
        ],
      },
      {
        kind: 'combined',
        operator: 'and',
        rules: [
          { kind: 'extension', extensions: ['ctz'] },
          { kind: 'magic', bytes: [0x74, 0x72, 0x69, 0x70] },
        ],
      },
    ],
  },
  {
    id: 'KMP_LibKn',
    name: 'Kotlin Multiplatform',
    type: 'KMP',
    confidence: 0.9,
    fileRules: [{
      kind: 'combined',
      operator: 'and',
      rules: [
        { kind: 'filename', patterns: ['.*\\.so$'] },
        {
          kind: 'content',
          patterns: [
            { pattern: 'KOTLIN_NATIVE_AVAILABLE_PROCESSORS', confidence: 0.95 },
            { pattern: 'ZN6kotlin2gc22ConcurrentMarkAndSweep', confidence: 0.5 },
            { pattern: 'ZN6kotlin2gc27ParallelMarkConcurrentSweep', confidence: 0.5 },
            { pattern: 'ZN6kotlin11gcScheduler11GCScheduler4ImplC1ERNS0_17GCSchedulerConfigEE3$_0', confidence: 0.5 },
          ],
        },
      ],
    }],
  },
  {
    id: 'CMP_Skiko',
    name: 'Compose Multiplatform',
    type: 'KMP',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libskikobridge\\.so$'] }],
  },
  {
    id: 'Lynx_Framework',
    name: 'Lynx Framework',
    type: 'Lynx',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['liblynx.*\\.so$'] }],
  },
  {
    id: 'Qt_Framework',
    name: 'Qt Framework',
    type: 'Qt',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libQt.*\\.so$'] }],
  },
  {
    id: 'Unity_Engine',
    name: 'Unity Game Engine',
    type: 'Unity',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libunity\\.so$', 'libil2cpp\\.so$'] }],
  },
  {
    id: 'Taro_Framework',
    name: 'Taro Framework',
    type: 'Taro',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: [
        'libJDSilkTaroNativeOH\\.so$', 'libSilkTaroKit\\.so$', 'libtaro_native_core\\.so$',
        'libTaroHarmonyLibrary\\.so$', 'libsilktaronativelib\\.so$',
      ],
    }],
  },
  {
    id: 'Weex_Framework',
    name: 'Weex Framework',
    type: 'Weex',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libweex_ability\\.so$', 'libweex_framework\\.so$'] }],
  },
  {
    id: 'Cangjie_Framework',
    name: 'Cangjie Framework',
    type: 'Cangjie',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: ['libcj_.*\\.so$', 'libcjhybridview\\.so$', 'libcontact_cj.*\\.so$'],
    }],
  },
  {
    id: '@duke/logan',
    name: '@duke/logan',
    type: '@duke/logan',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['liblogan\\.so$'] }],
  },
  {
    id: '@devzeng/leveldb',
    name: '@devzeng/leveldb',
    type: '@devzeng/leveldb',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libleveldb\\.so$'] }],
  },
  {
    id: '@duke/websocket-client',
    name: '@duke/websocket-client',
    type: '@duke/websocket-client',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libwebsocketClient\\.so$'] }],
  },
  {
    id: '@ohos/flate2',
    name: '@ohos/flate2',
    type: '@ohos/flate2',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libflate2\\.so$'] }],
  },
  {
    id: 'GPU_Transform',
    name: '@ohos/gpu_transform',
    type: '@ohos/gpu_transform',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libnativeGpu\\.so$'] }],
  },
  {
    id: '@ohos/imageknifepro',
    name: '@ohos/imageknifepro',
    type: '@ohos/imageknifepro',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libimageknifepro\\.so$'] }],
  },
  {
    id: 'PAG_Framework',
    name: '@tencent/libpag',
    type: '@tencent/libpag',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libpag\\.so$', 'libnative_libpag\\.so$'] }],
  },
  {
    id: '@ohos/linphone',
    name: '@ohos/linphone',
    type: '@ohos/linphone',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: [
        'liblinphone\\.so$', 'libbelle-sip\\.so$', 'libmediastreamer2\\.so$', 'libohos_linphone\\.so$',
        'libbctoolbox\\.so$', 'libbelr\\.so$', 'libortp\\.so$',
      ],
    }],
  },
  {
    id: '@ohos/lottie-turbo',
    name: '@ohos/lottie-turbo',
    type: '@ohos/lottie-turbo',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['liblottie-turbo\\.so$'] }],
  },
  {
    id: '@tencent/mmkv',
    name: '@tencent/mmkv',
    type: '@tencent/mmkv',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libmmkv\\.so$'] }],
  },
  {
    id: '@ohos/mp4parser',
    name: '@ohos/mp4parser',
    type: '@ohos/mp4parser',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libmp4parser_napi\\.so$'] }],
  },
  {
    id: '@ohos/vap',
    name: '@ohos/vap',
    type: '@ohos/vap',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libvap\\.so$'] }],
  },
  {
    id: '@hw-agconnect/hmcore',
    name: '@hw-agconnect/hmcore',
    type: '@hw-agconnect/hmcore',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libagccrypto\\.so$', 'libagcmbedtls\\.so$'] }],
  },
  {
    id: '@kuiklybase/knoi',
    name: '@kuiklybase/knoi',
    type: '@kuiklybase/knoi',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libknoi\\.so$'] }],
  },
  {
    id: '@mysoft/archive',
    name: '@mysoft/archive',
    type: '@mysoft/archive',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libarchive\\.so$', 'libmyarchive\\.so$'] }],
  },
  {
    id: '@tencentyun/libiotvideo',
    name: '@tencentyun/libiotvideo',
    type: '@tencentyun/libiotvideo',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['liblibiotvideo\\.so$'] }],
  },
  {
    id: '@volcengine/apmplus',
    name: '@volcengine/apmplus',
    type: '@volcengine/apmplus',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libnpth\\.so$'] }],
  },
  {
    id: '@wolfx/untar',
    name: '@wolfx/untar',
    type: '@wolfx/untar',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libboundscheck\\.so$', 'libctar\\.so$', 'libtar\\.so$'] }],
  },
  {
    id: '@ohos/ijkplayer',
    name: '@ohos/ijkplayer',
    type: '@ohos/ijkplayer',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: [
        'libijkplayer\\.so$', 'libijkplayer_audio_napi\\.so$', 'libijkplayer_napi\\.so$', 'libijksdl\\.so$',
      ],
    }],
  },
  {
    id: '@zaiohos/ijkplayer-surface',
    name: '@zaiohos/ijkplayer-surface',
    type: '@zaiohos/ijkplayer-surface',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libijkplayer_surface_napi\\.so$'] }],
  },
  {
    id: 'jlreader',
    name: 'jlreader',
    type: 'jlreader',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libjlreader\\.so$'] }],
  },
  {
    id: 'ksadsdk',
    name: 'ksadsdk',
    type: 'ksadsdk',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libksadsdk\\.so$', 'libkwai-v8-lite\\.so$'] }],
  },
  {
    id: '@ohos/aki',
    name: '@ohos/aki',
    type: '@ohos/aki',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libaki\\.so$', 'libaki_jsbind\\.so$'] }],
  },
  {
    id: 'rapid_kit',
    name: 'rapid_kit',
    type: 'rapid_kit',
    confidence: 0.95,
    fileRules: [{
      kind: 'filename',
      patterns: [
        'libPPCS\\.so$', 'libRapidCore\\.so$', 'libRapidMedia\\.so$', 'libRapidSDL\\.so$',
        'libnative_rapid_kit\\.so$',
      ],
    }],
  },
  {
    id: 'shiply',
    name: 'shiply',
    type: 'shiply',
    confidence: 0.95,
    fileRules: [{ kind: 'filename', patterns: ['libshiply\\.so$'] }],
  },
];
