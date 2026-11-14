import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const coreDir = join(repoRoot, 'packages/core');
const distDts = join(coreDir, 'dist/index.d.ts');
const tscBin = join(repoRoot, 'node_modules/typescript/bin/tsc');

/**
 * Compile a consumer file against the BUILT declarations, under the strictest
 * realistic settings: skipLibCheck false and no ambient node types.
 *
 * This is what catches "a type appears in a public signature but is not
 * exported" and "the .d.ts references an ambient namespace the package does
 * not declare" — neither of which the runtime export test can see.
 */
function typecheck(source: string): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ohosperf-types-'));
  try {
    mkdirSync(join(dir, 'node_modules/@ohos-perf'), { recursive: true });
    cpSync(coreDir, join(dir, 'node_modules/@ohos-perf/core'), { recursive: true });
    writeFileSync(join(dir, 'consumer.ts'), source);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true, module: 'esnext', moduleResolution: 'bundler',
        noEmit: true, skipLibCheck: false, types: [], target: 'ES2022',
      },
      include: ['consumer.ts'],
    }));
    try {
      execFileSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')],
        { stdio: 'pipe', encoding: 'utf8' });
      return { code: 0, output: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// This test checks the built declarations, not src. `dist/` is gitignored, so
// on a fresh checkout it does not exist until the package is built. Skipping is
// visible on purpose: run `npm run build -w @ohos-perf/core` first.
if (!existsSync(distDts)) {
  console.warn(
    '[types.test] SKIPPED: packages/core/dist/index.d.ts not found. ' +
    'Run `npm run build -w @ohos-perf/core` before running this test.',
  );
}

describe.skipIf(!existsSync(distDts))('published type surface', () => {
  it('every type named in a public signature is importable', () => {
    const r = typecheck(`
      import {
        connect, runProbe, Device, Hdc, Streamer, FrameAnalyzer, FrameQuery,
        ProcessQuery, openDb, HitraceCollector, CapabilityMatrix, Scene,
        createSceneLayout, ingestScene, metric, evidence, buildMatrix,
        tableRowCounts, HITRACE_DEFAULT_CATEGORIES,
      } from '@ohos-perf/core';
      import type {
        ConnectOptions, DeviceDeps, ProbeRunner, ProbeSnapshot, Env,
      } from '@ohos-perf/core';

      // Fix 1: injection fields must be expressible through ConnectOptions.
      const opts: ConnectOptions = { target: 'x', hdc: new Hdc() };

      // Fix 3: runProbe's parameter type must be nameable.
      const runner: ProbeRunner = { shell: async () => ({ stdout: '', stderr: '', code: 0 }) };
      const probe: ProbeSnapshot extends never ? never : (r: ProbeRunner) => Promise<ProbeSnapshot>
        = runProbe;

      // Fix 2: the environment type is self-owned, no @types/node required.
      const env: Env = { PATH: '/x' };
      const hdcOpts = { env };
      const streamerOpts = { env };

      export const all = [opts, runner, probe, hdcOpts, streamerOpts,
        Device, Streamer, FrameAnalyzer, FrameQuery, ProcessQuery, openDb,
        HitraceCollector, CapabilityMatrix, Scene, createSceneLayout,
        ingestScene, metric, evidence, buildMatrix, tableRowCounts,
        HITRACE_DEFAULT_CATEGORIES, connect];
    `);
    expect(r.output, r.output).toBe('');
    expect(r.code).toBe(0);
  });
});
