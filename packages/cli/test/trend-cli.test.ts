import { describe, it, expect } from 'vitest';
import type { CliDeps, TrendOutput } from '../src/commands';
import { runTrend } from '../src/commands';
import { collectLabels } from '../src/trend';
import { buildProgram } from '../src/program';

/*
 * `trend` is the multi-report half of HapRay's report comparison (row 35).
 * The core `buildTrend` does the aggregation; the command reads saved reports,
 * names the runs, and reports what it wrote.
 *
 * The refusals are the interesting part: a trend across two apps or under a
 * duplicate label is a claim the runs cannot support, and the command must
 * surface that as exit 1 with the reason, not as a page.
 */

const output: TrendOutput = {
  outDir: '/reports/trend',
  files: ['trend.html', 'trend.json'],
  runs: [
    { label: 'v1', app: 'com.demo', device: 'emu', startedAtNs: 1000, metrics: 57 },
    { label: 'v2', app: 'com.demo', device: 'emu', startedAtNs: 2000, metrics: 57 },
  ],
  orderedBy: 'startedAtNs',
  series: 57,
  improved: 3,
  regressed: 1,
  unchanged: 40,
  verdictless: 13,
};

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
    trend: async () => output,
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

describe('runTrend', () => {
  it('names the page, the artifacts, the runs and the verdict counts', async () => {
    const r = await runTrend(
      deps(),
      { reports: [{ label: 'v1', path: '/r1' }, { label: 'v2', path: '/r2' }], outDir: '/reports/trend' },
      {},
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('trend  /reports/trend/trend.html\n');
    expect(r.stdout).toContain('artifacts  trend.html trend.json\n');
    expect(r.stdout).toContain('runs  2 (v1, v2) · ordered by capture start time\n');
    expect(r.stdout).toContain(
      'series  57 metrics · 3 improved, 1 regressed, 40 unchanged, 13 without a known direction\n',
    );
  });

  it('says the order was argument order when a run had no start time', async () => {
    const r = await runTrend(
      deps({
        trend: async () => ({
          ...output,
          orderedBy: 'argument',
          runs: output.runs.map((run) => ({ ...run, startedAtNs: undefined })),
        }),
      }),
      { reports: [{ label: 'v1', path: '/r1' }, { label: 'v2', path: '/r2' }], outDir: '/out' },
      {},
    );
    expect(r.stdout).toContain('ordered by argument (a run has no capture start time)');
  });

  it('defaults each run label to the report path when none is given', async () => {
    const seen: Array<{ label: string; path: string }> = [];
    await runTrend(
      deps({
        trend: async (req) => {
          seen.push(...req.reports);
          return output;
        },
      }),
      { reports: [{ path: '/reports/run1' }, { path: '/reports/run2' }], outDir: '/out' },
      {},
    );
    expect(seen).toEqual([
      { label: '/reports/run1', path: '/reports/run1' },
      { label: '/reports/run2', path: '/reports/run2' },
    ]);
  });

  it('prints the trend document as JSON with --json', async () => {
    const r = await runTrend(
      deps(),
      { reports: [{ label: 'v1', path: '/r1' }, { label: 'v2', path: '/r2' }], outDir: '/out' },
      { json: true },
    );
    expect(JSON.parse(r.stdout)).toEqual(output);
  });

  it('exits 1 with the refusal when the runs are not comparable', async () => {
    const r = await runTrend(
      deps({
        trend: async () => {
          throw new Error('buildTrend: the runs measure different apps (com.a, com.b)');
        },
      }),
      { reports: [{ label: 'v1', path: '/r1' }, { label: 'v2', path: '/r2' }], outDir: '/out' },
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('different apps');
  });

  it('refuses fewer than two reports before reading any of them', async () => {
    let called = false;
    const r = await runTrend(
      deps({ trend: async () => { called = true; return output; } }),
      { reports: [{ path: '/only' }], outDir: '/out' },
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('at least two');
    expect(called).toBe(false);
  });
});

/** Parse through the real program, capturing its help text instead of printing. */
async function parse(argv: string[]): Promise<{ out: string[] }> {
  const out: string[] = [];
  const program = buildProgram(
    deps(),
    {
      writeOut: (text) => out.push(text),
      writeErr: () => {},
      emit: () => {},
    },
    { exitOverride: true },
  );
  try {
    await program.parseAsync(['node', 'ohos-perf', ...argv]);
  } catch {
    // `--help` exits through commander's override; the captured text is the point.
  }
  return { out };
}

describe('collectLabels', () => {
  it('collects repeated labels in order', () => {
    const first = collectLabels('v1', undefined);
    const second = collectLabels('v2', first);
    expect(second).toEqual(['v1', 'v2']);
  });

  it('returns a new list each time, so commander cannot share state', () => {
    const first = collectLabels('v1', undefined);
    const second = collectLabels('v2', first);
    expect(first).toEqual(['v1']);
    expect(second).not.toBe(first);
  });

  it('advertises no default in --help', async () => {
    // Commander prints an option's initial value; `[]` is not a value a user
    // typed, and `(default: [])` in the help text reads as a mistake.
    const { out } = await parse(['trend', '--help']);
    expect(out.join('')).not.toContain('(default: [])');
  });
});
