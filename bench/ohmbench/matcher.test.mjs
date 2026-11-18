import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matches, scoreCase, fileMatches } from './score.mjs';

/*
 * The matcher, transcribed from the benchmark's docs/evaluation.md.
 *
 * These tests pin the three rules the standard states, because a matcher that
 * is more generous than the benchmark's inflates the score and one that is
 * stricter understates it. Neither is a measurement.
 */

const location = (over) => ({
  file: 'a/b/C.ets',
  class: 'C',
  symbol: 'run',
  changed_lines: [4, 6],
  ...over,
});

describe('fileMatches', () => {
  it('matches the trailing two segments and ignores the extension', () => {
    assert.equal(fileMatches('x/y/b/C.ts', 'a/b/C.ets'), true);
  });

  it('does not match on a single trailing segment', () => {
    assert.equal(fileMatches('C.ets', 'a/b/C.ets'), false);
  });

  it('matches a whole one-segment path against a one-segment path', () => {
    assert.equal(fileMatches('C.ets', 'C.ets'), true);
  });

  it('reduces an ABC record name to its path', () => {
    assert.equal(fileMatches('&a/b/C&', 'x/b/C.ets'), true);
  });
});

describe('matches', () => {
  it('matches by file and symbol', () => {
    assert.equal(matches({ file: 'x/y/b/C.ts', symbol: 'run', line_start: 1, line_end: 2 }, location()), true);
  });

  it('matches the last component of a Class.method symbol', () => {
    assert.equal(matches({ file: 'a/b/C.ets', symbol: 'run', line_start: 1, line_end: 1 }, location({ symbol: 'C.run' })), true);
  });

  it('matches by line overlap when no symbol is given', () => {
    assert.equal(matches({ file: 'a/b/C.ets', line_start: 5, line_end: 5 }, location()), true);
  });

  it('does not match a different symbol outside the range', () => {
    assert.equal(matches({ file: 'a/b/C.ets', symbol: 'other', line_start: 90, line_end: 91 }, location()), false);
  });

  it('matches an alias location', () => {
    const withAlias = location({ aliases: [{ file: 'a/b/D.ets', symbol: 'read' }] });
    assert.equal(matches({ file: 'a/b/D.ets', symbol: 'read', line_start: 1, line_end: 1 }, withAlias), true);
  });
});

describe('scoreCase', () => {
  const groundtruth = {
    case: 'c',
    root_causes: [
      { role: 'primary', file: 'a/b/C.ets', symbol: 'run', changed_lines: [4, 6] },
      { role: 'related', file: 'a/b/E.ets', symbol: 'init', changed_lines: [1, 2] },
    ],
  };

  it('scores precision over the returned top five, not over five slots', () => {
    const record = {
      case: 'c',
      suspects: [
        { rank: 1, file: 'a/b/C.ets', symbol: 'run', line_start: 4, line_end: 4 },
        { rank: 2, file: 'a/b/E.ets', symbol: 'init', line_start: 1, line_end: 1 },
      ],
    };
    const row = scoreCase(record, groundtruth);
    assert.equal(row.precision, 1);
    assert.equal(row.recall, 1);
  });

  it('counts a miss in precision and recall', () => {
    const record = {
      case: 'c',
      suspects: [
        { rank: 1, file: 'z/z/Z.ets', symbol: 'no', line_start: 1, line_end: 1 },
        { rank: 2, file: 'a/b/C.ets', symbol: 'run', line_start: 4, line_end: 4 },
      ],
    };
    const row = scoreCase(record, groundtruth);
    assert.equal(row.precision, 0.5);
    assert.equal(row.recall, 1);
  });

  it('scores an empty answer as zero', () => {
    const row = scoreCase({ case: 'c', suspects: [] }, groundtruth);
    assert.equal(row.precision, 0);
    assert.equal(row.recall, 0);
    assert.equal(row.f1, 0);
  });
});
