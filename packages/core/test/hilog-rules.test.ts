import { describe, it, expect } from 'vitest';
import { parseHilogLine } from '../src/hilog/parse';
import type { HilogLine } from '../src/hilog/parse';
import { DEFAULT_HILOG_RULES, compileRules, matchRules } from '../src/hilog/rules';

const CAPTURE = Date.UTC(2026, 10, 17, 5, 13);

function line(index: number, message: string): HilogLine {
  const parsed = parseHilogLine(
    `11-17 05:12:33.412  4999  5010 I A00000/com.demo/Image: ${message}`,
    2026,
    CAPTURE,
  );
  return { ...parsed, index };
}

const PIXEL_MAP_REGEX =
  'CreatePixelMap success,.*memType\\s*:\\s*(\\d+),\\s*cost\\s+\\d+\\s+us';
const SIZE_REGEX =
  'dSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\).*srcSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\)';

describe('compileRules and matchRules', () => {
  it('extracts the selected group and applies the expression', () => {
    const rules = compileRules([{
      name: 'no_dmp',
      regex: PIXEL_MAP_REGEX,
      groups: [1],
      conditions: '$1!=4',
    }]);
    const lines = [
      line(0, 'CreatePixelMap success, memType : 3, cost 120 us'),
      line(1, 'CreatePixelMap success, memType : 4, cost 120 us'),
    ];
    expect(matchRules(rules, lines).map((m) => [m.lineIndex, m.groups])).toEqual([[0, ['3']]]);
  });

  it('matches group 0 as the whole match', () => {
    const r = compileRules([{ name: 'all', regex: 'foo', groups: [0] }]);
    expect(matchRules(r, [line(0, 'a foo b')])[0].groups).toEqual(['foo']);
  });

  it('extracts several groups in the configured order', () => {
    const r = compileRules([{ name: 'size', regex: SIZE_REGEX, groups: [1, 2, 3, 4] }]);
    const got = matchRules(r, [
      line(0, 'CreatePixelMap success, dSize : (10, 20), srcSize : (30, 40)'),
    ]);
    expect(got[0].groups).toEqual(['10', '20', '30', '40']);
  });

  it('orders matches by line then rule name', () => {
    const r = compileRules([
      { name: 'b', regex: 'x', groups: [0] },
      { name: 'a', regex: 'x', groups: [0] },
    ]);
    expect(matchRules(r, [line(0, 'x'), line(1, 'x')]).map((m) => [m.lineIndex, m.ruleName]))
      .toEqual([[0, 'a'], [0, 'b'], [1, 'a'], [1, 'b']]);
  });

  it('applies the array form of conditions per group', () => {
    const r = compileRules([{
      name: 'cmp', regex: '(\\d+)', groups: [1], conditions: ['!=4'],
    }]);
    expect(matchRules(r, [line(0, '3'), line(1, '4')]).map((m) => m.lineIndex)).toEqual([0]);
  });

  it('names a rule whose regex does not compile', () => {
    expect(() => compileRules([{ name: 'broken', regex: '(' }])).toThrow(/broken/);
  });

  it('does not let a line-scoped rule match across lines', () => {
    // `^b$` matches at an inner line boundary only with the `m` flag. A
    // line-scoped rule must not have it: one log line is one line.
    const r = compileRules([{ name: 'multi', regex: '^b$', groups: [0], scope: 'line' }]);
    expect(matchRules(r, [line(0, 'a\nb')])).toEqual([]);
  });

  it('lets a message-scoped rule anchor at an inner line boundary', () => {
    // Upstream compiles with `re.MULTILINE`, so `^b$` matches the second line
    // of a multi-line message. `.` still does not cross the newline in either
    // implementation.
    const r = compileRules([{ name: 'multi', regex: '^b$', groups: [0], scope: 'message' }]);
    expect(matchRules(r, [line(0, 'a\nb')])).toHaveLength(1);
  });

  it('ignores case and never matches a tag when scoped to the message', () => {
    const r = compileRules([{ name: 'case', regex: 'createpixelmap', groups: [0] }]);
    expect(matchRules(r, [line(0, 'CreatePixelMap')])).toHaveLength(1);
    const tagOnly = compileRules([{ name: 'tag', regex: 'com\\.demo', groups: [0] }]);
    expect(matchRules(tagOnly, [line(0, 'nothing here')])).toEqual([]);
  });

  it('is deterministic regardless of rule order in the input', () => {
    const a = compileRules([
      { name: 'z', regex: 'x', groups: [0] },
      { name: 'a', regex: 'x', groups: [0] },
    ]);
    const b = compileRules([
      { name: 'a', regex: 'x', groups: [0] },
      { name: 'z', regex: 'x', groups: [0] },
    ]);
    expect(JSON.stringify(matchRules(a, [line(0, 'x')]))).toBe(
      JSON.stringify(matchRules(b, [line(0, 'x')])),
    );
  });
});

describe('DEFAULT_HILOG_RULES', () => {
  it('ports the four upstream CreatePixelMap rules in config order', () => {
    expect(DEFAULT_HILOG_RULES.map((r) => r.name)).toEqual([
      'no_dmp',
      'big_image_with_target_size',
      'big_image_without_target_size',
      'image_same_size',
    ]);
  });

  it('counts the upstream cases on one log', () => {
    const rules = compileRules(DEFAULT_HILOG_RULES);
    const lines = [
      line(0, 'CreatePixelMap success, memType : 3, cost 120 us'),
      line(1, 'CreatePixelMap success, memType : 4, cost 120 us'),
      line(2, 'CreatePixelMap success, dSize : (0, 0), srcSize : (800, 800)'),
      line(3, 'CreatePixelMap success, dSize : (100, 100), srcSize : (800, 800)'),
      line(4, 'CreatePixelMap success, dSize : (800, 800), srcSize : (800, 800)'),
    ];
    const counts = new Map<string, number>();
    for (const m of matchRules(rules, lines)) {
      counts.set(m.ruleName, (counts.get(m.ruleName) ?? 0) + 1);
    }
    expect(counts.get('no_dmp')).toBe(1);
    expect(counts.get('big_image_without_target_size')).toBe(1);
    // The 800x800 source at its target size satisfies both clauses: it is a
    // big image whose desired size matches, so upstream counts it in both.
    expect(counts.get('big_image_with_target_size')).toBe(2);
    expect(counts.get('image_same_size')).toBe(1);
  });
});
