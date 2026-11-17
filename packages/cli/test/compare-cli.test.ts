import { describe, it, expect } from 'vitest';
import { cliDeps as deps } from './helpers/deps';
import { compareResults, type BaselineComparison, type Metric } from '@ohos-perf/core';
import type { CliDeps } from '../src/commands';
import { runCompare } from '../src/commands';

const metricOf = (id: string, value: number | string): Metric => ({
  id, value, unit: 'count', fidelity: 'exact',
  provenance: { collector: 'test', device: 'd' },
});

/** A complete deps object; only `compare` matters to these tests. */

const comparison: BaselineComparison = compareResults(
  { metrics: [metricOf('frame.jank.rate', 40)], evidence: [] },
  { metrics: [metricOf('frame.jank.rate', 30)], evidence: [] },
);

describe('runCompare', () => {
  it('renders one line per metric with the status', async () => {
    const r = await runCompare(
      deps({ compare: async () => comparison }),
      { baseline: 'a.json', current: 'b.json' },
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(
      'frame.jank.rate  40 -> 30  (-25%)  improved\n' +
      'totals  improved 1, regressed 0, unchanged 0, added 0, removed 0, incomparable 0\n',
    );
  });

  it('omits the percentage when it cannot be computed', async () => {
    const added = compareResults({ metrics: [], evidence: [] }, { metrics: [metricOf('frame.count', 5)], evidence: [] });
    const r = await runCompare(
      deps({ compare: async () => added }),
      { baseline: 'a', current: 'b' },
      {},
    );
    expect(r.stdout).toBe(
      'frame.count  - -> 5  added\n' +
      'totals  improved 0, regressed 0, unchanged 0, added 1, removed 0, incomparable 0\n',
    );
  });

  it('renders JSON identical to the API structure', async () => {
    const r = await runCompare(
      deps({ compare: async () => comparison }),
      { baseline: 'a.json', current: 'b.json' },
      { json: true },
    );
    expect(JSON.parse(r.stdout)).toEqual(comparison);
    expect(r.stdout).toBe(JSON.stringify(comparison, null, 2) + '\n');
  });

  it('prints a totals line after the rows', async () => {
    const r = await runCompare(
      deps({ compare: async () => comparison }),
      { baseline: 'a', current: 'b' },
      {},
    );
    expect(r.stdout.split('\n').at(-2)).toBe(
      'totals  improved 1, regressed 0, unchanged 0, added 0, removed 0, incomparable 0',
    );
  });

  it('fails with one stderr line and empty stdout when an input is unreadable', async () => {
    const r = await runCompare(
      deps({ compare: async () => { throw new Error('cannot read a.json'); } }),
      { baseline: 'a.json', current: 'b.json' },
      {},
    );
    expect(r).toEqual({ stdout: '', stderr: 'cannot read a.json\n', exitCode: 1 });
  });

  it('reports an empty comparison as the totals line alone', async () => {
    const empty = compareResults({ metrics: [], evidence: [] }, { metrics: [], evidence: [] });
    const r = await runCompare(
      deps({ compare: async () => empty }),
      { baseline: 'a', current: 'b' },
      {},
    );
    expect(r.stdout).toBe(
      'totals  improved 0, regressed 0, unchanged 0, added 0, removed 0, incomparable 0\n',
    );
  });
});
