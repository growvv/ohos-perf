import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliDeps } from './helpers/deps';
import { runRootCauseCommand } from '../src/commands';
import type { RootCauseOutput } from '../src/commands';
import { buildRootCauseDocument } from '../../core/src/report/root-cause';
import { buildMovement } from '../../core/src/report/movement';
import type { Evidence } from '../../core/src/report/evidence';
import type { Metric } from '../../core/src/report/metric';

/*
 * P28 task 4 — `ohos-perf root-cause`.
 *
 * HapRay's `root-cause` requires an endpoint. Its `--skip-llm` writes
 * "Pending Agent Inference" placeholders, so the artifact is unusable without a
 * model. Here the deterministic half is the product: `--offline` writes a real
 * report, and a missing endpoint falls back to it rather than failing.
 */

function evidence(overrides: Partial<Evidence> & Pick<Evidence, 'id'>): Evidence {
  return {
    kind: 'jank',
    severity: 'warn',
    subject: { process: 'com.demo' },
    window: { startNs: 0, endNs: 1_000_000 },
    signals: {},
    explain: 'something was slow',
    drillDown: [],
    ...overrides,
  };
}

const document = buildRootCauseDocument({
  app: 'com.demo',
  device: 'dev-1',
  window: { startNs: 0, endNs: 2_000_000_000 },
  generator: { name: '@ohos-perf/core', version: '0.23.0' },
  evidence: [evidence({ id: 'ev-1', severity: 'critical', explain: 'frame 42 took 118.5 ms' })],
});

const withAnalysis = {
  ...document,
  analysis: {
    model: 'test-model',
    summary: 'the main thread stalls',
    suspects: [{
      rank: 1, evidenceIds: ['ev-1'], metrics: [], rootCause: 'long frame', fix: 'split',
      confidence: 'high' as const, ungrounded: [],
    }],
    caveats: [],
    needsMoreData: [],
  },
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rootcause-'));
}

describe('runRootCauseCommand', () => {
  it('writes the document, the markdown and the model input', async () => {
    const dir = tempDir();
    try {
      const result = await runRootCauseCommand(
        cliDeps({ rootCause: async () => ({ document, outDir: dir, files: [] }) }),
        { input: '/scene', outDir: dir, offline: true },
        {},
      );
      expect(result.exitCode).toBe(0);
      // The seam owns the writing; the command reports what was written.
      expect(result.stdout).toContain('root-cause');
      expect(result.stdout).toMatch(/ev-1|1 critical/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes --offline through so the model is never asked', async () => {
    let seen: unknown;
    await runRootCauseCommand(
      cliDeps({
        async rootCause(req) {
          seen = req;
          return { document, outDir: '/out', files: [] };
        },
      }),
      { input: '/scene', outDir: '/out', offline: true },
      {},
    );
    expect(seen).toMatchObject({ input: '/scene', outDir: '/out', offline: true });
  });

  it('reports that it fell back to offline when no endpoint is configured', async () => {
    // Falling back rather than failing is the point: the evidence is the
    // product, the model is the extra. The user is told which they got.
    const result = await runRootCauseCommand(
      cliDeps({
        rootCause: async () => ({ document, outDir: '/out', files: [], fellBackToOffline: true }),
      }),
      { input: '/scene', outDir: '/out' },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/no model endpoint|offline/i);
  });

  it('does not warn about a fallback when the model did answer', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document: withAnalysis, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out' },
      {},
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('test-model');
  });

  it('prints the document with --json and nothing else', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out', offline: true },
      { json: true },
    );
    const parsed = JSON.parse(result.stdout) as typeof document;
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0]!.evidenceId).toBe('ev-1');
  });

  it('reports a seam failure as one line and exits 1', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => { throw new Error('scene not readable'); } }),
      { input: '/nope', outDir: '/out', offline: true },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('scene not readable');
  });

  it('names the ungrounded claims in the human summary', async () => {
    const ungrounded = {
      ...document,
      analysis: {
        ...withAnalysis.analysis,
        suspects: [{ ...withAnalysis.analysis.suspects[0]!, ungrounded: ['aboutToAppear'] }],
      },
    };
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document: ungrounded, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out' },
      {},
    );
    expect(result.stdout).toMatch(/ungrounded/i);
    expect(result.stdout).toContain('aboutToAppear');
  });
});

describe('runRootCauseCommand — --baseline', () => {
  const metric = (id: string, value: number): Metric => ({
    id, value, unit: 'count', fidelity: 'exact',
    provenance: { collector: 'hitrace', device: 'emu' },
  });
  const movement = buildMovement(
    {
      label: 'v1', app: 'com.demo', device: 'emu',
      result: { metrics: [metric('frame.jank.rate', 10)], evidence: [] },
    },
    {
      label: 'v2', app: 'com.demo', device: 'emu',
      result: { metrics: [metric('frame.jank.rate', 15)], evidence: [] },
    },
  );
  const moved = buildRootCauseDocument({
    app: 'com.demo',
    device: 'dev-1',
    window: { startNs: 0, endNs: 2_000_000_000 },
    generator: { name: '@ohos-perf/core', version: '0.27.0' },
    evidence: [evidence({ id: 'ev-1', severity: 'critical', explain: 'frame 42 took 118.5 ms' })],
    movement,
  });

  it('forwards --baseline to the seam', async () => {
    let seen: unknown;
    await runRootCauseCommand(
      cliDeps({
        async rootCause(req) {
          seen = req;
          return { document: moved, outDir: '/out', files: [] };
        },
      }),
      { input: '/scene', outDir: '/out', baseline: '/before', offline: true },
      {},
    );
    expect(seen).toMatchObject({ input: '/scene', outDir: '/out', baseline: '/before' });
  });

  it('prints a movement line naming both runs and the counts', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document: moved, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out', baseline: '/before', offline: true },
      {},
    );
    expect(result.stdout).toMatch(/movement\s+v1 → v2/);
    expect(result.stdout).toMatch(/1 regressed/);
  });

  it('prints no movement line when there is no baseline', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out', offline: true },
      {},
    );
    expect(result.stdout).not.toContain('movement');
  });

  it('keeps the movement in the --json document', async () => {
    const result = await runRootCauseCommand(
      cliDeps({ rootCause: async () => ({ document: moved, outDir: '/out', files: [] }) }),
      { input: '/scene', outDir: '/out', baseline: '/before', offline: true },
      { json: true },
    );
    const parsed = JSON.parse(result.stdout) as typeof moved;
    expect(parsed.movement?.rows[0]?.id).toBe('frame.jank.rate');
  });
});

describe('RootCauseOutput', () => {
  it('is the shape the command and the seam share', () => {
    const output: RootCauseOutput = {
      document,
      outDir: '/out',
      files: ['root-cause.json', 'root-cause.md', 'root-cause.evidence.json'],
    };
    expect(output.files).toHaveLength(3);
  });
});

describe('the artifacts on disk', () => {
  it('are three files a reader can open', async () => {
    const dir = tempDir();
    try {
      const result = await runRootCauseCommand(
        cliDeps({
          async rootCause() {
            const { writeFileSync } = await import('node:fs');
            const { renderRootCauseMarkdown } = await import('../../core/src/report/root-cause-markdown');
            writeFileSync(join(dir, 'root-cause.json'), JSON.stringify(document));
            writeFileSync(join(dir, 'root-cause.md'), renderRootCauseMarkdown(document));
            writeFileSync(join(dir, 'root-cause.evidence.json'), JSON.stringify(document));
            return {
              document, outDir: dir,
              files: ['root-cause.json', 'root-cause.md', 'root-cause.evidence.json'],
            };
          },
        }),
        { input: '/scene', outDir: dir, offline: true },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, 'root-cause.json'))).toBe(true);
      expect(readFileSync(join(dir, 'root-cause.md'), 'utf8')).toContain('frame 42 took 118.5 ms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
