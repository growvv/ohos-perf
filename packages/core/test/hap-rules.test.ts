import { describe, it, expect } from 'vitest';
import {
  EXCLUDE_PATTERNS, TECH_RULES, matchRules, validateRules,
  type FileRule, type RuleMatch, type RuleMatchKind, type TechRule,
} from '../src/hap/rules';
import { openZip } from '../src/hap/zip';
import { buildInventory } from '../src/hap/inventory';
import { makeZip, type TestEntry } from './helpers/hap-zip-writer';
import { OhosPerfError } from '../src/errors';

const encoder = new TextEncoder();
const text = (value: string): Uint8Array => encoder.encode(value);

function rule(partial: Pick<TechRule, 'id' | 'fileRules'> & Partial<TechRule>): TechRule {
  return { name: partial.id, type: 'Test', confidence: 0.9, ...partial };
}

function run(rules: readonly TechRule[], entries: TestEntry[]): RuleMatch[] {
  const archive = openZip(makeZip(entries));
  return matchRules(rules, archive, buildInventory(archive));
}

function refusal(fn: () => void): OhosPerfError {
  try {
    fn();
  } catch (err) {
    return err as OhosPerfError;
  }
  throw new Error('expected the call to throw');
}

describe('matchRules — rule kinds', () => {
  it('matches a filename pattern against the basename, not the directory', () => {
    const matches = run(
      [rule({ id: 'so', fileRules: [{ kind: 'filename', patterns: ['^libfoo\\.so$'] }] })],
      [
        { name: 'libs/arm64/libfoo.so', data: text('x') },
        { name: 'libs/arm64/foo.so', data: text('x') },
      ],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['libs/arm64/libfoo.so']);
  });

  it('matches a path pattern against the whole entry name', () => {
    const matches = run(
      [rule({ id: 'assets', fileRules: [{ kind: 'path', patterns: ['^flutter_assets/'] }] })],
      [
        { name: 'flutter_assets/kernel_blob.bin', data: text('x') },
        { name: 'assets/flutter_assets/other.bin', data: text('x') },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['flutter_assets/kernel_blob.bin']);
  });

  it('matches an extension case-insensitively', () => {
    const matches = run(
      [rule({ id: 'bundle', fileRules: [{ kind: 'extension', extensions: ['hbc'] }] })],
      [
        { name: 'index.HBC', data: text('x') },
        { name: 'index.js', data: text('x') },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['index.HBC']);
  });

  it('matches magic bytes at the configured offset and refuses a short file', () => {
    const matches = run(
      [rule({ id: 'trip', fileRules: [{ kind: 'magic', bytes: [0x74, 0x72, 0x69, 0x70], offset: 1 }] })],
      [
        { name: 'a.ctz', data: new Uint8Array([0x00, 0x74, 0x72, 0x69, 0x70]) },
        { name: 'b.ctz', data: new Uint8Array([0x00, 0x74]) },
        { name: 'c.ctz', data: new Uint8Array([0x74, 0x72, 0x69, 0x70, 0x00]) },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['a.ctz']);
  });

  it('matches a content pattern over the inflated text', () => {
    const matches = run(
      [rule({ id: 'kotlin', fileRules: [{ kind: 'content', patterns: ['KOTLIN_NATIVE_AVAILABLE'] }] })],
      [
        { name: 'libkn.so', data: text('prefix KOTLIN_NATIVE_AVAILABLE suffix') },
        { name: 'libother.so', data: text('nothing here') },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['libkn.so']);
  });

  it('applies and over every sub-rule', () => {
    const fileRules: FileRule[] = [{
      kind: 'combined',
      operator: 'and',
      rules: [
        { kind: 'filename', patterns: ['\\.so$'] },
        { kind: 'content', patterns: ['MARKER'] },
      ],
    }];
    const matches = run([rule({ id: 'kmp', fileRules })], [
      { name: 'libkn.so', data: text('MARKER') },
      { name: 'libplain.so', data: text('nothing') },
      { name: 'notes.txt', data: text('MARKER') },
    ]);
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['libkn.so']);
  });

  it('applies or over every sub-rule', () => {
    const fileRules: FileRule[] = [{
      kind: 'combined',
      operator: 'or',
      rules: [
        { kind: 'extension', extensions: ['hbc'] },
        { kind: 'extension', extensions: ['jsbundle'] },
      ],
    }];
    const matches = run([rule({ id: 'rn', fileRules })], [
      { name: 'a.hbc', data: text('x') },
      { name: 'b.jsbundle', data: text('x') },
      { name: 'c.js', data: text('x') },
    ]);
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['a.hbc', 'b.jsbundle']);
  });

  it('applies not as "the first matches and none of the rest do"', () => {
    const fileRules: FileRule[] = [{
      kind: 'combined',
      operator: 'not',
      rules: [
        { kind: 'filename', patterns: ['\\.so$'] },
        { kind: 'content', patterns: ['DEBUG_BUILD'] },
      ],
    }];
    const matches = run([rule({ id: 'release', fileRules })], [
      { name: 'librelease.so', data: text('stripped') },
      { name: 'libdebug.so', data: text('DEBUG_BUILD') },
      { name: 'readme.md', data: text('stripped') },
    ]);
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['librelease.so']);
  });
});

describe('matchRules — metadata', () => {
  const flutter = (): TechRule => rule({
    id: 'Flutter',
    type: 'Flutter',
    confidence: 0.95,
    requireMetadata: true,
    fileRules: [{ kind: 'filename', patterns: ['^libflutter\\.so$'] }],
    metadataPatterns: [{
      field: 'dartVersion',
      source: 'content',
      pattern: '(\\d+\\.\\d+\\.\\d+) \\(stable\\)',
      captureGroup: 1,
    }],
  });

  it('reports the extracted metadata beside the match', () => {
    const matches = run([flutter()], [
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.metadata).toEqual({ dartVersion: '3.4.1' });
  });

  it('refuses a requireMetadata rule when the matched file yields no metadata', () => {
    expect(run([flutter()], [{ name: 'libs/libflutter.so', data: text('no version here') }])).toEqual([]);
  });

  it('reads metadata from the matched file, not from any file in the archive', () => {
    const matches = run([flutter()], [
      { name: 'libs/libflutter.so', data: text('no version here') },
      { name: 'assets/notes.txt', data: text('3.4.1 (stable)') },
    ]);
    expect(matches).toEqual([]);
  });

  it('matches without metadata when requireMetadata is absent', () => {
    const matches = run(
      [rule({ id: 'assets', type: 'Flutter', fileRules: [{ kind: 'path', patterns: ['^flutter_assets/'] }] })],
      [{ name: 'flutter_assets/a.bin', data: text('x') }],
    );
    expect(matches[0]!.metadata).toEqual({});
  });
});

describe('matchRules — grouping and confidence', () => {
  it('reports every matching file and sums their bytes', () => {
    const matches = run(
      [rule({ id: 'so', fileRules: [{ kind: 'filename', patterns: ['\\.so$'] }] })],
      [
        { name: 'a.so', data: new Uint8Array([1, 2, 3]) },
        { name: 'b.so', data: new Uint8Array([1, 2, 3, 4, 5]) },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['a.so', 'b.so']);
    expect(matches[0]!.bytes).toBe(8);
  });

  it('multiplies the rule confidence by the pattern confidence', () => {
    const matches = run([
      rule({
        id: 'marked',
        confidence: 0.8,
        fileRules: [{ kind: 'content', confidence: 0.5, patterns: [{ pattern: 'MARKER', confidence: 0.5 }] }],
      }),
    ], [{ name: 'a.bin', data: text('MARKER') }]);
    expect(matches[0]!.confidence).toBeCloseTo(0.4, 10);
  });

  it('uses the rule confidence alone when the pattern carries none', () => {
    const matches = run(
      [rule({ id: 'so', confidence: 0.9, fileRules: [{ kind: 'filename', patterns: ['\\.so$'] }] })],
      [{ name: 'a.so', data: text('x') }],
    );
    expect(matches[0]!.confidence).toBeCloseTo(0.9, 10);
  });

  it('produces nothing when no rule matches', () => {
    expect(run(
      [rule({ id: 'so', fileRules: [{ kind: 'filename', patterns: ['\\.so$'] }] })],
      [{ name: 'a.txt', data: text('x') }],
    )).toEqual([]);
  });

  it('sorts the output by type then rule id', () => {
    const rules = [
      rule({ id: 'b', type: 'T', fileRules: [{ kind: 'extension', extensions: ['txt'] }] }),
      rule({ id: 'a', type: 'T', fileRules: [{ kind: 'extension', extensions: ['txt'] }] }),
      rule({ id: 'z', type: 'A', fileRules: [{ kind: 'extension', extensions: ['txt'] }] }),
    ];
    const matches = run(rules, [{ name: 'a.txt', data: text('x') }]);
    expect(matches.map((match) => `${match.type}/${match.ruleId}`)).toEqual(['A/z', 'T/a', 'T/b']);
  });

  it('skips files under an excluded path', () => {
    expect(EXCLUDE_PATTERNS).toContain('resources/base/.*');
    const matches = run(
      [rule({ id: 'so', fileRules: [{ kind: 'filename', patterns: ['\\.so$'] }] })],
      [
        { name: 'resources/base/libs/libx.so', data: text('x') },
        { name: 'libs/liby.so', data: text('x') },
      ],
    );
    expect(matches[0]!.files.map((file) => file.path)).toEqual(['libs/liby.so']);
  });
});

describe('validateRules', () => {
  it('refuses an invalid regex, naming the rule', () => {
    const err = refusal(() => validateRules([
      rule({ id: 'broken', fileRules: [{ kind: 'filename', patterns: ['('] }] }),
    ]));
    expect(err.code).toBe('HAP_BAD_RULE');
    expect(err.message).toContain('broken');
  });

  it('refuses an invalid metadata pattern, naming the rule', () => {
    const err = refusal(() => validateRules([
      rule({
        id: 'broken-meta',
        fileRules: [{ kind: 'filename', patterns: ['x'] }],
        metadataPatterns: [{ field: 'f', source: 'content', pattern: '[' }],
      }),
    ]));
    expect(err.code).toBe('HAP_BAD_RULE');
    expect(err.message).toContain('broken-meta');
  });

  it('refuses an unknown rule kind, naming the rule', () => {
    const err = refusal(() => validateRules([
      rule({ id: 'mystery', fileRules: [{ kind: 'nope' as RuleMatchKind }] }),
    ]));
    expect(err.code).toBe('HAP_BAD_RULE');
    expect(err.message).toContain('mystery');
  });

  it('accepts the shipped rules', () => {
    expect(() => validateRules(TECH_RULES)).not.toThrow();
  });
});

describe('TECH_RULES', () => {
  it('ships HapRay\'s framework rules', () => {
    const ids = TECH_RULES.map((entry) => entry.id);
    for (const id of [
      'Flutter', 'RN_LibReact', 'Hermes_Engine', 'KMP_LibKn', 'Lynx_Framework',
      'Qt_Framework', 'Unity_Engine', 'Taro_Framework', 'Weex_Framework',
      'Cangjie_Framework', 'CMP_Skiko',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('detects Flutter from a real libflutter.so string table', () => {
    const matches = run(TECH_RULES, [
      { name: 'libs/arm64/libflutter.so', data: text('... Dart VM version: 3.4.1 (stable) ...') },
    ]);
    expect(matches.map((match) => match.ruleId)).toContain('Flutter');
  });

  it('detects Compose Multiplatform from libskikobridge.so', () => {
    const matches = run(TECH_RULES, [{ name: 'libs/arm64/libskikobridge.so', data: text('x') }]);
    expect(matches.find((match) => match.ruleId === 'CMP_Skiko')?.type).toBe('KMP');
  });
});
