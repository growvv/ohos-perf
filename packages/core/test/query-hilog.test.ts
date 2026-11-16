import { describe, it, expect } from 'vitest';
import { runNamedQuery, type QueryContext } from '../src/query/registry';
import { parseHilogText, type HilogLine } from '../src/hilog/parse';
import { CapabilityMatrix } from '../src/device/capability';

const noDb = {
  path: '',
  query: () => [],
  close: () => {},
};

function lines(): HilogLine[] {
  const text = [
    '11-17 05:12:10.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 1 us',
    '11-17 05:12:11.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 3, cost 2 us',
    '11-17 05:12:12.000  4999  5010 I A00000/com.demo/Image: CreatePixelMap success, memType : 4, cost 3 us',
    '11-17 05:12:13.000  4999  5010 I A00000/com.demo/Image: unrelated',
  ].join('\n');
  return parseHilogText(text, { year: 2026, captureNs: Date.UTC(2026, 10, 17, 5, 12) * 1e6 });
}

function ctx(hilog?: HilogLine[]): QueryContext {
  return {
    db: noDb as never,
    app: { packageName: 'com.demo', pids: [4999], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
    ...(hilog === undefined ? {} : { hilog }),
  };
}

describe('hilog queries', () => {
  it('returns the matches of one rule', () => {
    const r = runNamedQuery(ctx(lines()), 'hilog.matches', { rule: 'no_dmp' });
    expect((r.rows as Array<{ lineIndex: number }>).map((x) => x.lineIndex)).toEqual([0, 1]);
  });

  it('returns every match when no rule is named', () => {
    const r = runNamedQuery(ctx(lines()), 'hilog.matches', {});
    expect((r.rows as Array<{ ruleName: string }>).map((x) => x.ruleName)).toEqual([
      'no_dmp', 'no_dmp',
    ]);
  });

  it('returns [] when the scene has no log', () => {
    expect(runNamedQuery(ctx(), 'hilog.matches', {}).rows).toEqual([]);
  });

  it('rejects an unknown rule name', () => {
    expect(() => runNamedQuery(ctx(lines()), 'hilog.matches', { rule: 'nope' })).toThrow(/nope/);
  });

  it('reports the effective rule set with counts', () => {
    const r = runNamedQuery(ctx(lines()), 'hilog.rules', {});
    const rows = r.rows as Array<{ name: string; count: number }>;
    expect(rows.map((row) => row.name)).toEqual([
      'big_image_with_target_size', 'big_image_without_target_size',
      'image_same_size', 'no_dmp',
    ]);
    expect(rows.find((row) => row.name === 'no_dmp')!.count).toBe(2);
    expect(rows.find((row) => row.name === 'image_same_size')!.count).toBe(0);
  });

  it('returns the log lines inside a nanosecond window', () => {
    const all = lines();
    const start = all[1].ts;
    const end = all[2].ts;
    const r = runNamedQuery(ctx(all), 'hilog.around', { startNs: start, endNs: end });
    const rows = r.rows as HilogLine[];
    expect(rows.map((row) => row.index)).toEqual([1, 2]);
  });

  it('returns [] for hilog.around on a scene with no log', () => {
    expect(runNamedQuery(ctx(), 'hilog.around', { startNs: 0, endNs: 1 }).rows).toEqual([]);
  });
});
