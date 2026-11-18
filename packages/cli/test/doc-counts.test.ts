import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultAnalyzers } from '@ohos-perf/core';

/**
 * The docs quote how many analyzers and collectors the package has, and the
 * quote has drifted every time a phase added one.
 *
 * The defect this pins: 0.13.0 added the twentieth analyzer (`redundant-file`)
 * and the ninth collector (`jsheap`) while the README, the site and the core
 * package description still said "nineteen analyzers, eight collectors". The
 * parity ledger was made machine-checked in the same release precisely because
 * prose counts rot; these counts were the prose that was left behind.
 *
 * The collector count is a literal here, not a computed one: there is no
 * registry function for collectors the way `defaultAnalyzers()` is one, so the
 * number is maintained beside the phrase. `analyzers` is computed, so adding an
 * analyzer fails this test until the docs are updated with it.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const ANALYZER_COUNT = defaultAnalyzers().length;
const COLLECTOR_COUNT = 10;

/** "19" / "nineteen" — the spellings the prose actually uses. */
const words: Record<number, string> = {
  8: 'eight',
  9: 'nine',
  10: 'ten',
  14: 'fourteen',
  19: 'nineteen',
  20: 'twenty',
  21: 'twenty-one',
  22: 'twenty-two',
  23: 'twenty-three',
};

function countPattern(n: number): RegExp {
  const word = words[n];
  return word === undefined ? new RegExp(`\\b${n} analyzers`) : new RegExp(`\\b(?:${n}|${word}) analyzers`);
}

function collectorPattern(n: number): RegExp {
  const word = words[n];
  return word === undefined
    ? new RegExp(`\\b${n} collectors`)
    : new RegExp(`\\b(?:${n}|${word}) collectors`);
}

/**
 * Collapse every run of whitespace to one space.
 *
 * The prose is hard-wrapped at 80 columns, so "nine" and "collectors" can sit
 * on different lines — and did, in the core README, which is why the first
 * version of this test passed on a file that still said "eight collectors":
 * it read the raw text, the regex could not see across the newline, and the
 * `not.toMatch` half was equally blind. Normalizing first is what makes the
 * check see the sentence a reader sees.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

describe('the documented analyzer and collector counts match the code', () => {
  it('has a name for every count the docs currently use', () => {
    // A new count that has no word spelling would make the regexes below fall
    // back to digits only, and a prose "twenty-one" would slip past.
    expect(ANALYZER_COUNT).toBe(23);
    expect(COLLECTOR_COUNT).toBe(10);
  });

  it('README states the real analyzer count', () => {
    const text = flat(read('../../../README.md'));
    expect(text).toMatch(countPattern(ANALYZER_COUNT));
    // The previous number must be gone, not merely accompanied.
    expect(text).not.toMatch(countPattern(ANALYZER_COUNT - 1));
  });

  it('README states the real collector count', () => {
    const text = flat(read('../../../README.md'));
    expect(text).toMatch(collectorPattern(COLLECTOR_COUNT));
    expect(text).not.toMatch(collectorPattern(COLLECTOR_COUNT - 1));
  });

  it('the site states the real analyzer count', () => {
    const text = flat(read('../../../site/index.html'));
    expect(text).toMatch(countPattern(ANALYZER_COUNT));
    expect(text).not.toMatch(countPattern(ANALYZER_COUNT - 1));
  });

  it('the site states the real collector count', () => {
    const text = flat(read('../../../site/index.html'));
    expect(text).toMatch(collectorPattern(COLLECTOR_COUNT));
    expect(text).not.toMatch(collectorPattern(COLLECTOR_COUNT - 1));
  });

  it('the core package description states the real counts', () => {
    const description = (
      JSON.parse(read('../../core/package.json')) as { description: string }
    ).description;
    expect(description).toMatch(countPattern(ANALYZER_COUNT));
    expect(description).toMatch(collectorPattern(COLLECTOR_COUNT));
  });

  it('the core README that ships inside the tarball states the real collector count', () => {
    // `packages/core/README.md` is not the repo README: npm publishes it as
    // the package's landing page, so its counts are read by anyone who lands
    // on npmjs. It said "eight collectors" after P18 added the ninth, and the
    // repo-level check could not see it.
    const text = flat(read('../../core/README.md'));
    expect(text).toMatch(collectorPattern(COLLECTOR_COUNT));
    expect(text).not.toMatch(collectorPattern(COLLECTOR_COUNT - 1));
  });
});
