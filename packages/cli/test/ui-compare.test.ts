import { describe, it, expect } from 'vitest';
import type { CliDeps, UiCompareOutput } from '../src/commands';
import { runUiCompare } from '../src/commands';

/** A complete deps object; only `uiCompare` matters to these tests. */
function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' }, collectors: [] }),
    gesture: async () => ({ gesture: { action: 'key' as const, key: 'Home' }, output: 'No Error' }),
    query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false }),
    tools: () => [],
    compare: async () => { throw new Error('compare not stubbed'); },
    uiCompare: async () => { throw new Error('ui-compare not stubbed'); },
    report: async () => { throw new Error('report not stubbed'); },
    hap: async () => { throw new Error('hap not stubbed'); },
    emulator: {
      list: async () => [],
      start: async () => { throw new Error('emulator not stubbed'); },
      stop: async () => { throw new Error('emulator not stubbed'); },
      create: async () => { throw new Error('emulator not stubbed'); },
    },
    run: async () => { throw new Error('run not stubbed'); },
    ...overrides,
  };
}

const made: UiCompareOutput = {
  outDir: '/out',
  files: ['ui-diff.json', 'ui-diff.html', 'ui-diff-marked-a.png', 'ui-diff-marked-b.png'],
  tree: { added: 1, removed: 0, changed: 2, unchanged: 7 },
  image: { hamming: 4, similarity: 0.9375, changedRatio: 0.0125, tolerance: 8 },
  regions: 3,
  animations: 1,
  pixelOnly: 2,
  unmeasuredRegions: 0,
  degraded: [],
};

describe('runUiCompare', () => {
  it('renders one line per difference class and the image numbers', async () => {
    const r = await runUiCompare(deps({ uiCompare: async () => made }), {
      a: 'a', b: 'b', outDir: '/out',
    }, {});

    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('1 added, 0 removed, 2 changed, 7 unchanged');
    expect(r.stdout).toContain('similarity 0.9375');
    expect(r.stdout).toContain('tolerance 8');
    expect(r.stdout).toContain('regions  3');
    expect(r.stdout).toContain('animations  1 labelled, 2 pixel-only, 0 unmeasured');
    expect(r.stdout).toContain('ui-diff.html');
  });

  it('exits 0 when the screens are identical', async () => {
    const r = await runUiCompare(deps({
      uiCompare: async () => ({
        ...made,
        tree: { added: 0, removed: 0, changed: 0, unchanged: 9 },
        image: { hamming: 0, similarity: 1, changedRatio: 0, tolerance: 8 },
        regions: 0,
      }),
    }), { a: 'a', b: 'b', outDir: '/out' }, {});

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('0 added, 0 removed, 0 changed, 9 unchanged');
  });

  it('prints the degraded lines for a partial comparison', async () => {
    const r = await runUiCompare(deps({
      uiCompare: async () => ({ ...made, image: null, degraded: ['no screenshot.png on either side'] }),
    }), { a: 'a', b: 'b', outDir: '/out' }, {});

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('image  not compared');
    // No pixels means no animation claim, and the line says so rather than
    // reporting three zeros.
    expect(r.stdout).toContain('animations  not measured');
    expect(r.stdout).toContain('degraded  no screenshot.png on either side');
  });

  it('emits the JSON document with --json', async () => {
    const r = await runUiCompare(deps({ uiCompare: async () => made }), {
      a: 'a', b: 'b', outDir: '/out',
    }, { json: true });

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(made);
  });

  it('exits 1 with an empty stdout when the comparison could not be made', async () => {
    const r = await runUiCompare(deps({
      uiCompare: async () => { throw new Error('side b has no screenshot.png'); },
    }), { a: 'a', b: 'b', outDir: '/out' }, { json: true });

    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('side b has no screenshot.png');
  });
});
