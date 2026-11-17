import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import type { CliDeps, RenderOutput } from '../src/commands';
import { runRender } from '../src/commands';

/*
 * `render` is HapRay's `update` without the re-analysis: it takes a saved
 * `report.json` and writes the bundle's artifacts again.
 *
 * The command's whole value is that it reads no scene and runs no analyzer —
 * so a report recorded months ago renders as it was measured, not as today's
 * code would measure it. The refusals are about the document: a path that is
 * not a report, or a model that would render a page of blanks.
 */

const output: RenderOutput = {
  outDir: '/out',
  files: ['report.html', 'report.json', 'summary.json', 'metrics.csv', 'evidence.csv', 'report.xlsx'],
  sections: 14,
  metrics: 57,
  evidence: 12,
};


/** The shared deps, with this file's own seam returning its fixture. */
const deps = (overrides: Partial<CliDeps> = {}): CliDeps =>
  cliDeps({ render: async () => output, ...overrides });

describe('runRender', () => {
  it('names the page, the artifacts and the counts it re-rendered', async () => {
    const r = await runRender(deps(), { report: '/saved/report.json', outDir: '/out' }, {});
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('report  /out/report.html\n');
    expect(r.stdout).toContain('artifacts  report.html report.json summary.json metrics.csv evidence.csv report.xlsx\n');
    expect(r.stdout).toContain('sections  14 · 57 metrics · 12 evidence\n');
    expect(r.stdout).toContain('source  /saved/report.json (re-rendered, not re-analyzed)\n');
  });

  it('accepts a bundle directory and resolves report.json inside it', async () => {
    const seen: string[] = [];
    await runRender(
      deps({ render: async (req) => { seen.push(req.report); return output; } }),
      { report: '/saved/bundle', outDir: '/out' },
      {},
    );
    expect(seen).toEqual(['/saved/bundle']);
  });

  it('prints the manifest as JSON with --json', async () => {
    const r = await runRender(deps(), { report: '/saved/report.json', outDir: '/out' }, { json: true });
    expect(JSON.parse(r.stdout)).toEqual(output);
  });

  it('exits 1 with the reason when the document is not a report', async () => {
    const r = await runRender(
      deps({ render: async () => { throw new Error('not a report document'); } }),
      { report: '/bad.json', outDir: '/out' },
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('not a report document');
  });
});
