import { describe, it, expect } from 'vitest';
import { buildDepGraph } from '../src/hap/depgraph';

/*
 * HapFlow (HapRay row 29) is static/dynamic integration: which module owns a
 * file, which modules depend on which, and how long a timing cycle is.
 *
 * HapRay needs a Homecheck checkout with `node_modules` and a 16 GiB heap to
 * produce `fileDepGraph.json`; the graph it builds is a heuristic over path
 * segments and basenames. This port takes the file list and module
 * declarations as input and does the same arithmetic deterministically — no
 * Homecheck, no heap requirement, and the same answer on every run.
 */

const MODULES = [
  { name: 'entry', path: 'entry' },
  { name: 'feature', path: 'feature' },
  { name: 'common', path: 'common' },
];

describe('buildDepGraph', () => {
  it('assigns each file to the module whose path it sits under', () => {
    const graph = buildDepGraph(
      [
        'entry/src/main/ets/pages/Index.ets',
        'feature/src/main/ets/views/List.ets',
        'common/src/main/ets/utils/log.ets',
      ],
      MODULES,
    );
    const owner = new Map(graph.files.map((f) => [f.path, f.module]));
    expect(owner.get('entry/src/main/ets/pages/Index.ets')).toBe('entry');
    expect(owner.get('feature/src/main/ets/views/List.ets')).toBe('feature');
    expect(owner.get('common/src/main/ets/utils/log.ets')).toBe('common');
  });

  it('falls back to the longest matching module path, not the first', () => {
    // A nested module (`app/feature`) and its parent (`app`) both own this
    // file. The nested one must win, whatever order they were declared in —
    // a first-match walk would give the parent whenever it came first.
    const nested = [
      { name: 'app', path: 'app' },
      { name: 'app-feature', path: 'app/feature' },
    ];
    const forward = buildDepGraph(['app/feature/src/a.ets'], nested);
    expect(forward.files[0]!.module).toBe('app-feature');
    const reversed = buildDepGraph(['app/feature/src/a.ets'], [...nested].reverse());
    expect(reversed.files[0]!.module).toBe('app-feature');
  });

  it('does not treat a longer sibling name as a prefix', () => {
    // `feature-detail` starts with `feature` as a string but is a different
    // segment, so a raw-prefix match would misfile it.
    const graph = buildDepGraph(
      ['feature-detail/src/main/ets/a.ets'],
      [...MODULES, { name: 'feature-detail', path: 'feature-detail' }],
    );
    expect(graph.files[0]!.module).toBe('feature-detail');
  });

  it('leaves a file with no owning module unassigned rather than guessing', () => {
    const graph = buildDepGraph(['build/outputs/x.js'], MODULES);
    expect(graph.files[0]!.module).toBeUndefined();
  });

  it('counts an edge per cross-module import and ignores a same-module one', () => {
    const graph = buildDepGraph(
      [
        'entry/src/main/ets/pages/Index.ets',
        'common/src/main/ets/utils/log.ets',
        'common/src/main/ets/utils/str.ets',
      ],
      MODULES,
      [
        { from: 'entry/src/main/ets/pages/Index.ets', to: 'common/src/main/ets/utils/log.ets' },
        { from: 'entry/src/main/ets/pages/Index.ets', to: 'common/src/main/ets/utils/str.ets' },
        { from: 'common/src/main/ets/utils/log.ets', to: 'common/src/main/ets/utils/str.ets' },
      ],
    );
    expect(graph.harEdges).toEqual([{ from: 'entry', to: 'common', count: 2 }]);
    expect(graph.edges).toHaveLength(3);
  });

  it('is deterministic: the same input gives the same order', () => {
    const files = [
      'common/src/b.ets',
      'entry/src/a.ets',
      'common/src/a.ets',
    ];
    expect(buildDepGraph(files, MODULES)).toEqual(buildDepGraph([...files].reverse(), MODULES));
  });

  it('computes a timing cycle from per-module build durations', () => {
    const graph = buildDepGraph(
      ['entry/src/a.ets', 'common/src/b.ets'],
      MODULES,
      [{ from: 'entry/src/a.ets', to: 'common/src/b.ets' }],
      { entry: 120, common: 80 },
    );
    // A cycle is the sum of the durations on the path between two modules.
    expect(graph.timingCycles).toEqual([{ modules: ['entry', 'common'], ms: 200 }]);
  });

  it('reports no timing cycle when durations are not supplied', () => {
    const graph = buildDepGraph(['entry/src/a.ets'], MODULES);
    expect(graph.timingCycles).toEqual([]);
  });
});
