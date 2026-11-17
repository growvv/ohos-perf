import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultAnalyzers } from '@ohos-perf/core';

/**
 * Every analyzer the engine registers must be named in the README, and every
 * one of them must appear in the metric-id table.
 *
 * The defect this pins: `redundant-file` and the `hilog` analyzer were both
 * registered while the README's analyzer list and metric table still stopped
 * at component reuse. A reader looking up "what does this package measure"
 * got a list that was short by two, and nothing failed.
 *
 * The token map is maintained here rather than derived: an analyzer's id
 * (`rs-skip`) is not the metric prefix it emits (`rs_skip.*`), and a new
 * analyzer with no entry fails this test by name — which is the point.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** analyzer id → the phrase the README uses for it, and its metric prefix. */
const TOKENS: Record<string, { phrase: string; prefix?: string }> = {
  frames: { phrase: 'frames', prefix: 'frame.*' },
  'frame-load': { phrase: 'frame load', prefix: 'frame.load.*' },
  'fault-tree': { phrase: 'fault tree', prefix: 'fault.*' },
  binder: { phrase: 'binder', prefix: 'binder.*' },
  threads: { phrase: 'threads', prefix: 'thread.*' },
  memory: { phrase: 'memory', prefix: 'mem.*' },
  'mem-measure': { phrase: 'memory measure', prefix: 'mem.measure.*' },
  'native-memory': { phrase: 'native memory', prefix: 'mem.native.*' },
  startup: { phrase: 'startup', prefix: 'startup.*' },
  render: { phrase: 'render', prefix: 'render.*' },
  gc: { phrase: 'GC pressure', prefix: 'gc.*' },
  vsync: { phrase: 'VSync anomalies', prefix: 'vsync.*' },
  'empty-frame': { phrase: 'empty frames', prefix: 'empty_frame.*' },
  'rs-skip': { phrase: 'RenderService skips', prefix: 'rs_skip.*' },
  symbols: { phrase: 'symbol statistics', prefix: 'symbol.*' },
  flamegraph: { phrase: 'flamegraph', prefix: 'flamegraph.*' },
  components: { phrase: 'component reuse', prefix: 'components.*' },
  hilog: { phrase: 'device log', prefix: 'hilog.*' },
  'redundant-file': { phrase: 'redundant-file', prefix: 'redundant_file.*' },
  ui: { phrase: 'UI tree', prefix: 'ui.*' },
};

describe('the README documents every registered analyzer', () => {
  const readme = read('../../../README.md');
  const registered = defaultAnalyzers().map((analyzer) => analyzer.id);

  it('has a token entry for every analyzer, so a new one cannot be forgotten', () => {
    // A new analyzer without an entry fails here by name rather than silently
    // passing the per-analyzer checks below.
    const undocumented = registered.filter((id) => TOKENS[id] === undefined);
    expect(undocumented).toEqual([]);
  });

  it('names every analyzer in its prose list', () => {
    const missing = registered.filter(
      (id) => TOKENS[id] !== undefined && !readme.includes(TOKENS[id]!.phrase),
    );
    expect(missing).toEqual([]);
  });

  it('lists every analyzer metric prefix in the metric-id table', () => {
    // Scoped to the table, not the whole file: a prefix named in the prose
    // list would otherwise satisfy this check while the table — the place a
    // reader looks up an id — still lacked the row. A mutation that removed a
    // table row while leaving the prose passed the unscoped version.
    const table = readme
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .join('\n');
    const missing = registered.filter((id) => {
      const prefix = TOKENS[id]?.prefix;
      return prefix !== undefined && !table.includes(`| \`${prefix}\``);
    });
    expect(missing).toEqual([]);
  });
});
