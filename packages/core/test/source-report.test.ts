import { describe, it, expect } from 'vitest';
import { buildSuspectsDocument, renderSuspectsText } from '../src/source/report';
import type { Suspect } from '../src/source/suspects';

/*
 * A big tree produces a big suspect list, and the text renderer measures the
 * widest file path to align the columns. `Math.max(...paths)` puts one
 * argument on the stack per suspect, so a tree with enough findings made the
 * renderer throw `RangeError` instead of printing — the report for the tree
 * that needed it most was the one that could not be produced.
 *
 * The threshold is machine- and call-site-dependent (measured here at
 * somewhere between 124k and 150k arguments), so the test asks for more than
 * any of them tolerate.
 */

function suspects(count: number): Suspect[] {
  const list: Suspect[] = [];
  for (let index = 0; index < count; index++) {
    list.push({
      rank: index + 1,
      file: `entry/src/main/ets/pages/Page${index}.ets`,
      className: 'Page',
      symbol: 'build',
      lineStart: index + 1,
      lineEnd: index + 2,
      rule: 'eager-foreach',
      description: 'ForEach builds every row up front.',
      confidence: 'medium',
    });
  }
  return list;
}

describe('renderSuspectsText', () => {
  it('renders a suspect list too long for Math.max(...paths)', () => {
    const document = buildSuspectsDocument('/app', 1, 1, suspects(150_000));
    const text = renderSuspectsText(document);
    expect(text).toContain('# 1 ');
    expect(text).toContain('Page149999.ets');
    expect(text.trimEnd().split('\n')).toHaveLength(1 + 150_000 * 2);
  });
});
