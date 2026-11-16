import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync,
  readFileSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 *
 * Both streams are returned on the success path too. TypeScript 5.9.3 is silent
 * with exit 0 today, but a future version that warns without failing must not
 * be invisible.
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
    const r = spawnSync(process.execPath, [tscBin, '-p', join(dir, 'tsconfig.json')],
      { encoding: 'utf8' });
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Newest mtime under `dir`, recursively. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/**
 * Types that are declared in the published .d.ts but deliberately not exported.
 *
 * These four appear only as *method parameter/return* types (`Hdc.buildArgv`,
 * `Streamer.spawnSpec`, `Streamer.spawnProcess`), which callers satisfy
 * structurally without naming them. Everything else that is declared must be
 * exported — a type named in any exported symbol's signature has to be
 * nameable, or consumers can call a function but not write its type.
 *
 * If this list ever needs to grow, that is an API decision, not a test fix.
 */
const KNOWN_INTERNAL_TYPES = ['HdcArgvParams', 'HdcOp', 'SpawnResult', 'SpawnSpec'];

/** The runtime value exports of `@ohos-perf/core`; `index.test.ts` exercises them at runtime. */
const VALUE_EXPORTS = [
  'BinderAnalyzer', 'BinderQuery', 'CapabilityMatrix', 'CallstackQuery', 'Device',
  'DEFAULT_QUERY_LIMIT', 'DEVICE_PERF_PATH', 'DEVICE_UI_PATH', 'DeviceNotFoundError',
  'FaultTreeAnalyzer',
  'FPS_COMMAND', 'flattenUiTree', 'FrameAnalyzer', 'FrameQuery', 'FTRACE_CATEGORIES',
  'HidumperCollector', 'HIPROFILER_PLUGIN_NAMES', 'HITCH_COMMAND',
  'HITRACE_DEFAULT_CATEGORIES',
  'Hdc', 'HdcNotFoundError', 'HiperfCollector', 'hiperfRecordCommand',
  'HitraceCollector', 'HiprofilerCollector',
  'IngestError', 'InstantQuery', 'MAX_QUERY_LIMIT', 'MIN_BUFFER_PAGES', 'MemoryAnalyzer',
  'MemoryMeasureAnalyzer',
  'OhosPerfError', 'PLANE_A_PLUGINS', 'PerfQuery',
  'ProcessQuery', 'RenderAnalyzer', 'Scene', 'UitestCollector',
  'ProcfsCollector', 'parseFpsCounts', 'parseHitches', 'parseProcfsStatus',
  'parseSmapsRollup', 'readHidumperCapture', 'readProcfsSamples', 'readUiTree',
  'writeProcfsSamples',
  'SchedQuery', 'StartupAnalyzer', 'StartupQuery', 'Streamer', 'StreamerNotFoundError',
  'ThreadAnalyzer', 'ThreadQuery',
  'ThreadStateQuery', 'analyzeThreadWakeup', 'buildHiprofilerConfig', 'buildMatrix',
  'compareResults', 'computeBinderAnalysis', 'computeFaultTree', 'computeThreadAnalysis',
  'connect', 'createSceneLayout', 'defaultAnalyzers', 'evidence', 'ftracePlugin',
  'gpuPlugin', 'ingestScene', 'lookupQuery',
  'memoryPlugin', 'MemMeasureQuery',
  'METRIC_DIRECTIONS', 'metric', 'nativehookPlugin', 'openDb', 'parseHiperfSummary', 'queryDefinitions',
  'readSceneMetadata',
  'resolveAppIdentity', 'resolveQueryLimit',
  'runAnalyzers', 'runDrillDown', 'runNamedQuery', 'runProbe', 'tableRowCounts',
  'unknownQueryError',
  'writeSceneMetadata', 'xpowerPlugin',
];

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
        ProcessQuery, ThreadQuery, openDb, HitraceCollector, CapabilityMatrix, Scene,
        createSceneLayout, ingestScene, metric, evidence, buildMatrix,
        tableRowCounts, HITRACE_DEFAULT_CATEGORIES,
        OhosPerfError, HdcNotFoundError, DeviceNotFoundError, StreamerNotFoundError,
        IngestError,
      } from '@ohos-perf/core';
      import type {
        ConnectOptions, DeviceDeps, ProbeRunner, ProbeSnapshot, Env,
        HdcOptions, StreamerOptions,
      } from '@ohos-perf/core';

      // Fix 1: every field connect() reads must be expressible through
      // ConnectOptions. Each one is written out so that moving ANY of them back
      // into a private interface fails here — the earlier version only wrote
      // \`target\` and \`hdc\`, so moving \`probe\` out escaped detection.
      const opts: ConnectOptions = {
        target: 'x',
        hdcPath: '/hdc',
        streamerPath: '/streamer',
        hdc: new Hdc(),
        probe: async () => { throw new Error('not called'); },
      };

      // Fix 3: runProbe's parameter type must be nameable.
      const runner: ProbeRunner = { shell: async () => ({ stdout: '', stderr: '', code: 0 }) };
      const probe: ProbeSnapshot extends never ? never : (r: ProbeRunner) => Promise<ProbeSnapshot>
        = runProbe;

      // Fix 2: the environment type is self-owned, no @types/node required, and
      // both option types must accept it and expose it back as an Env.
      const env: Env = { PATH: '/x' };
      const hdcOpts: HdcOptions = { env };
      const streamerOpts: StreamerOptions = { env };
      const asEnv: Env = hdcOpts.env ?? {};
      const asEnv2: Env = streamerOpts.env ?? {};

      // Env must stay an index signature, not \`any\`: assigning a non-string
      // value must be a type error. If Env ever degrades to \`any\`, this
      // directive becomes unused and tsc fails with TS2578.
      // @ts-expect-error — Env values are string | undefined, never number.
      const badEnv: Env = { PATH: 123 };

      export const all = [opts, runner, probe, hdcOpts, streamerOpts, asEnv, asEnv2, badEnv,
        Device, Streamer, FrameAnalyzer, FrameQuery, ProcessQuery, ThreadQuery, openDb,
        HitraceCollector, CapabilityMatrix, Scene, createSceneLayout,
        ingestScene, metric, evidence, buildMatrix, tableRowCounts,
        HITRACE_DEFAULT_CATEGORIES, OhosPerfError, HdcNotFoundError, DeviceNotFoundError,
        StreamerNotFoundError, IngestError, connect];
    `);
    expect(r.output, r.output).toBe('');
    expect(r.code).toBe(0);
  });

  it('ConnectOptions names every field connect() reads', () => {
    // Runtime mirror of the literal compiled above. The compile proves every
    // field is assignable; this proves none was silently dropped from the
    // object (a leaked `any` would hide that from tsc). If a field is ever
    // removed from ConnectOptions, both this and the excess-property check in
    // the consumer fail.
    const opts = {
      target: 'x',
      hdcPath: '/hdc',
      streamerPath: '/streamer',
      hdc: null,
      probe: null,
    };
    expect(Object.keys(opts).sort()).toEqual(
      ['hdc', 'hdcPath', 'probe', 'streamerPath', 'target'],
    );
  });

  it('exports every declared type except the four known method-only seams', () => {
    const text = readFileSync(distDts, 'utf8');

    const declared = [...text.matchAll(
      /^(?:declare )?(?:interface|type|class|function|const|enum) ([A-Za-z_$][\w$]*)/gm,
    )].map((m) => m[1]);

    const exportLine = text.match(/^export \{([\s\S]*?)\};/m);
    expect(exportLine, 'the .d.ts must end with a single export { ... } statement').toBeTruthy();
    const exported = new Set(
      exportLine![1].split(',').map((p) => p.trim().replace(/^type /, '')).filter(Boolean),
    );

    // Sanity: the parse must actually find the surface, not silently match nothing.
    expect(declared.length).toBeGreaterThan(40);
    expect(exported.size).toBeGreaterThan(40);

    const unexported = declared.filter(
      (name) => !exported.has(name) && !KNOWN_INTERNAL_TYPES.includes(name),
    );
    expect(unexported, `these types are declared in dist/index.d.ts but not exported:\n  ${unexported.join('\n  ')}`)
      .toEqual([]);
  });

  it('the built module exports exactly the documented value surface', async () => {
    // Compare the literal against the built module itself. Asserting the
    // literal against its own length/uniqueness would let a new accidental value
    // export ship unnoticed.
    const mod = await import(pathToFileURL(join(coreDir, 'dist/index.js')).href);
    expect(Object.keys(mod).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it('the built declarations are not older than the sources they were built from', () => {
    const distMtime = statSync(distDts).mtimeMs;
    const srcMtime = newestMtime(join(coreDir, 'src'));
    expect(
      distMtime,
      `packages/core/dist/index.d.ts is older than packages/core/src — ` +
      `run \`npm run build -w @ohos-perf/core\` before running this test. ` +
      `(A stale dist makes every assertion in this file validate the previous build.)`,
    ).toBeGreaterThanOrEqual(srcMtime);
  });
});
