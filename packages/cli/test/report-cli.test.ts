import { describe, it, expect } from 'vitest';
import { CommanderError } from 'commander';
import type { CliDeps, ReportOutput } from '../src/commands';
import { runReport } from '../src/commands';
import { buildProgram } from '../src/program';

const output: ReportOutput = {
  outDir: '/reports/run1',
  files: [
    'report.html', 'report.json', 'summary.json',
    'metrics.csv', 'evidence.csv', 'report.xlsx',
  ],
  sections: { total: 14, measured: 13, degraded: 1 },
  metrics: 57,
  evidence: 12,
  bySeverity: { info: 3, warn: 8, critical: 1 },
};

/** A complete deps object; only `report` matters to these tests. */
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
    report: async () => output,
    trend: async () => { throw new Error('trend not stubbed'); },
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

describe('runReport', () => {
  it('renders the report path, artifact list, section counts and totals', async () => {
    const r = await runReport(
      deps(),
      { sceneDir: 'scene1', outDir: '/reports/run1' },
      {},
    );
    expect(r).toEqual({
      stdout:
        'report  /reports/run1/report.html\n' +
        'artifacts  report.html report.json summary.json metrics.csv evidence.csv report.xlsx\n' +
        'sections  13 measured, 1 degraded\n' +
        'totals    57 metrics, 12 evidence (info 3, warn 8, critical 1)\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('says every section is measured when none degraded', async () => {
    const r = await runReport(
      deps({ report: async () => ({ ...output, sections: { total: 14, measured: 14, degraded: 0 } }) }),
      { sceneDir: 'scene1', outDir: '/reports/run1' },
      {},
    );
    expect(r.stdout).toContain('sections  14 measured\n');
    expect(r.stdout).not.toContain('degraded');
  });

  it('appends the comparison totals only when a baseline was used', async () => {
    const comparison = {
      improved: 2, regressed: 1, unchanged: 5, added: 0, removed: 0, incomparable: 3,
    };
    const r = await runReport(
      deps({ report: async () => ({ ...output, comparison }) }),
      { sceneDir: 'scene1', outDir: '/reports/run1', baseline: 'base' },
      {},
    );
    expect(r.stdout).toContain(
      'comparison  improved 2, regressed 1, unchanged 5, added 0, removed 0, incomparable 3\n',
    );
  });

  it('prints the manifest as JSON', async () => {
    const r = await runReport(deps(), { sceneDir: 'scene1', outDir: '/reports/run1' }, { json: true });
    expect(r.stdout).toBe(JSON.stringify(output, null, 2) + '\n');
  });

  it('fails with one stderr line and empty stdout when the report cannot be written', async () => {
    const r = await runReport(
      deps({ report: async () => { throw new Error('cannot open scene1'); } }),
      { sceneDir: 'scene1', outDir: '/reports/run1' },
      {},
    );
    expect(r).toEqual({ stdout: '', stderr: 'cannot open scene1\n', exitCode: 1 });
  });
});

describe('report command wiring', () => {
  function harness(overrides: Partial<CliDeps> = {}) {
    const emitted: unknown[] = [];
    const program = buildProgram(
      deps(overrides),
      {
        writeOut: () => {},
        writeErr: () => {},
        emit: (result) => emitted.push(result),
      },
      { exitOverride: true },
    );
    return { program, emitted };
  }

  it('passes scene, out, app and baseline through', async () => {
    const seen: unknown[] = [];
    const { program } = harness({
      report: async (req) => {
        seen.push(req);
        return output;
      },
    });
    await program.parseAsync([
      'node', 'ohos-perf', 'report', 'scene1',
      '--out', 'out1', '--app', 'com.demo', '--baseline', 'base',
    ]);
    expect(seen).toEqual([
      { sceneDir: 'scene1', outDir: 'out1', app: 'com.demo', baseline: 'base' },
    ]);
  });

  it('requires --out before calling the deps layer', async () => {
    let called = false;
    const { program } = harness({ report: async () => { called = true; return output; } });
    let error: CommanderError | undefined;
    try {
      await program.parseAsync(['node', 'ohos-perf', 'report', 'scene1']);
    } catch (caught) {
      error = caught as CommanderError;
    }
    expect(called).toBe(false);
    expect(error?.exitCode).toBe(1);
  });
});
