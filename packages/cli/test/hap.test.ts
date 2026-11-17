import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { OhosPerfError, type CapabilityState, type HapAnalysis } from '@ohos-perf/core';
import type { CliDeps, HapOutput } from '../src/commands';
import { runHap } from '../src/commands';
import { buildProgram } from '../src/program';
import { realDeps } from '../src/deps';
import { writeHap, type HapEntry } from './helpers/hap-zip';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const analysis: HapAnalysis = {
  schemaVersion: 1,
  package: {
    name: 'demo.hap',
    bundleName: 'com.example.demo',
    versionName: '1.2.3',
    versionCode: 42,
    appName: 'Demo',
  },
  totals: { files: 2, size: 4096, compressedSize: 2048 },
  categories: [{ name: 'binaries', files: 1, size: 3000, compressedSize: 1500 }],
  technologies: [{
    ruleId: 'Flutter',
    ruleName: 'Flutter',
    type: 'Flutter',
    confidence: 0.95,
    files: [{
      path: 'libs/libflutter.so', size: 3000, compressedSize: 1500,
      crc32: '00000000', extension: 'so', category: 'binaries',
    }],
    bytes: 3000,
    metadata: {},
  }],
  duplicates: [],
  oversized: [],
  largest: [{ path: 'libs/libflutter.so', size: 3000 }],
  files: [
    {
      path: 'libs/libflutter.so', size: 3000, compressedSize: 1500,
      crc32: '00000000', extension: 'so', category: 'binaries',
    },
    { path: 'module.json', size: 1096, compressedSize: 548, crc32: '00000001', extension: 'json', category: 'data' },
  ],
  metrics: [],
  evidence: [],
};

const STATIC_HAP_CAPABILITY: CapabilityState = {
  id: 'static.hap',
  available: true,
  collector: 'offline',
  fidelity: 'exact',
  probe: { command: '', stdout: '', stderr: '', code: 0 },
};

const output: HapOutput = { analysis, capabilities: [STATIC_HAP_CAPABILITY] };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real `.hap` file on disk, because `runHap` checks the path before IO. */
function packageFile(name = 'demo.hap', body = 'stored'): string {
  const root = mkdtempSync(join(tmpdir(), 'ohosperf-hap-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

/** A complete deps object; only `hap` matters to these tests. */
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
    trend: async () => { throw new Error('trend not stubbed'); },
    render: async () => { throw new Error('render not stubbed'); },
    hap: async () => output,
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

function harness(overrides: Partial<CliDeps> = {}) {
  const emitted: Array<{ stdout: string; stderr: string; exitCode: number }> = [];
  const program = buildProgram(
    deps(overrides),
    { writeOut: () => {}, writeErr: () => {}, emit: (result) => emitted.push(result) },
    { exitOverride: true },
  );
  return { program, emitted };
}

async function parse(argv: string[], overrides: Partial<CliDeps> = {}) {
  const h = harness(overrides);
  let error: CommanderError | undefined;
  try {
    await h.program.parseAsync(['node', 'ohos-perf', ...argv]);
  } catch (caught) {
    error = caught as CommanderError;
  }
  return { ...h, error };
}

describe('runHap', () => {
  it('prints the package, totals, technologies, duplicates and largest files', async () => {
    const r = await runHap(deps(), { packagePath: packageFile() }, {});
    expect(r).toEqual({
      stdout:
        'package  demo.hap  com.example.demo 1.2.3 (42)  Demo\n' +
        'files    2, 4096 bytes (2048 compressed)\n' +
        'tech     Flutter (rule Flutter)  1 file(s), 3000 bytes\n' +
        'duplicates  0 group(s), 0 bytes wasted\n' +
        'oversized  0 file(s)\n' +
        'largest  libs/libflutter.so  3000 bytes\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('says so when nothing matched a rule', async () => {
    const r = await runHap(
      deps({ hap: async () => ({ ...output, analysis: { ...analysis, technologies: [] } }) }),
      { packagePath: packageFile() },
      {},
    );
    expect(r.stdout).toContain('tech     none detected\n');
  });

  it('names the artifacts it wrote under --out', async () => {
    const r = await runHap(
      deps({
        hap: async () => ({ ...output, outDir: '/out', artifacts: ['hap.json', 'hap.html'] }),
      }),
      { packagePath: packageFile(), outDir: '/out' },
      {},
    );
    expect(r.stdout).toContain('wrote    hap.json, hap.html in /out\n');
  });

  it('prints the HapAnalysis document --out writes, with the inventory and capability row', async () => {
    // The spec names the document `--json` prints, and `hap.json` is that
    // document. Printing a terminal summary instead means an agent that pipes
    // `--json` cannot see the per-file inventory the spec says to open.
    const r = await runHap(deps(), { packagePath: packageFile() }, { json: true });
    const printed = JSON.parse(r.stdout) as {
      analysis: HapAnalysis;
      capabilities: CapabilityState[];
    };
    expect(printed.analysis).toEqual(analysis);
    expect(printed.analysis.files.map((file) => file.path))
      .toEqual(['libs/libflutter.so', 'module.json']);
    expect(printed.capabilities).toEqual([STATIC_HAP_CAPABILITY]);
    expect(r.exitCode).toBe(0);
  });

  it('keeps an absolute --out directory out of the document', async () => {
    // `hap.json` is a function of the archive's bytes; the path the caller
    // chose belongs to the invocation, not the package.
    const r = await runHap(
      deps({
        hap: async () => ({
          ...output, outDir: 'E:/abs/out', artifacts: ['hap.json', 'hap.html'],
        }),
      }),
      { packagePath: packageFile(), outDir: 'E:/abs/out' },
      { json: true },
    );
    expect(r.stdout).not.toContain('E:/abs/out');
    expect(JSON.parse(r.stdout).analysis).toEqual(analysis);
  });

  it('exits 1 naming a missing path without calling the dependency', async () => {
    let called = false;
    const r = await runHap(
      deps({ hap: async () => { called = true; return output; } }),
      { packagePath: 'no/such/file.hap' },
      {},
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no/such/file.hap');
    expect(called).toBe(false);
  });

  it('exits 1 naming a file that is not a package', async () => {
    const path = packageFile('notes.txt', 'hello');
    const r = await runHap(deps(), { packagePath: path }, {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('notes.txt');
  });

  it('exits 1 naming a directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hap-'));
    roots.push(root);
    const r = await runHap(deps(), { packagePath: root }, {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(root);
  });

  it('maps a dependency failure to exit 1 with an empty stdout', async () => {
    const r = await runHap(
      deps({ hap: async () => { throw new Error('HAP_CRC_MISMATCH: bad entry'); } }),
      { packagePath: packageFile() },
      {},
    );
    expect(r).toEqual({ stdout: '', stderr: 'HAP_CRC_MISMATCH: bad entry\n', exitCode: 1 });
  });

  it('names the refusal code a typed failure carries', async () => {
    // The skill tells an agent to report the code ("HAP_CRC_MISMATCH"), and
    // every error in core carries one. Printing only the message drops the
    // one token a caller can branch on.
    const r = await runHap(
      deps({
        hap: async () => {
          throw new OhosPerfError('archive entry "a.txt" fails its CRC check', {
            code: 'HAP_CRC_MISMATCH',
          });
        },
      }),
      { packagePath: packageFile() },
      {},
    );
    expect(r).toEqual({
      stdout: '',
      stderr: 'HAP_CRC_MISMATCH: archive entry "a.txt" fails its CRC check\n',
      exitCode: 1,
    });
  });
});

describe('hap command', () => {
  it('forwards the package path and --out', async () => {
    const seen: unknown[] = [];
    const path = packageFile();
    const { emitted } = await parse(['hap', path, '--out', '/out'], {
      hap: async (req) => { seen.push(req); return output; },
    });
    expect(seen).toEqual([{ packagePath: path, outDir: '/out' }]);
    expect(emitted).toHaveLength(1);
  });

  it('rejects --target, because a package needs no device', async () => {
    const { error } = await parse(['hap', packageFile(), '--target', 't1']);
    expect(error).toBeInstanceOf(CommanderError);
    expect(error?.exitCode).not.toBe(0);
  });
});

describe('realDeps().hap', () => {
  function fixture(entries: HapEntry[]): string {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-hap-'));
    roots.push(root);
    const path = join(root, 'demo.hap');
    writeHap(path, entries);
    return path;
  }

  it('analyzes a package and writes hap.json plus hap.html', async () => {
    const path = fixture([
      { name: 'module.json', data: text(JSON.stringify({
        app: { bundleName: 'com.example.demo', versionCode: 7, versionName: '2.0.0', label: 'Demo' },
      })) },
      { name: 'a.png', data: text('same bytes') },
      { name: 'b.png', data: text('same bytes') },
      { name: 'libs/libflutter.so', data: text('Dart VM version: 3.4.1 (stable)') },
    ]);
    const outDir = join(path, '..', 'out');
    const result = await realDeps('0.10.0').hap({ packagePath: path, outDir });

    expect(result.artifacts).toEqual(['hap.json', 'hap.html']);
    expect(result.analysis.package.bundleName).toBe('com.example.demo');
    expect(result.analysis.technologies.map((entry) => entry.ruleId)).toContain('Flutter');
    expect(result.analysis.duplicates).toHaveLength(1);
    expect(result.analysis.duplicates[0]!.wastedBytes).toBe(10);
    expect(result.capabilities).toEqual([{
      id: 'static.hap',
      available: true,
      collector: 'offline',
      fidelity: 'exact',
      probe: { command: '', stdout: '', stderr: '', code: 0 },
    }]);

    const document = JSON.parse(readFileSync(join(outDir, 'hap.json'), 'utf8')) as {
      schemaVersion: number;
      technologies: Array<{ ruleId: string }>;
      files: Array<{ path: string }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.technologies.map((entry) => entry.ruleId)).toContain('Flutter');
    // The inventory the spec says a caller opens is in the file.
    expect(document.files.map((file) => file.path)).toEqual([
      'a.png', 'b.png', 'libs/libflutter.so', 'module.json',
    ]);

    const html = readFileSync(join(outDir, 'hap.html'), 'utf8');
    expect(html).not.toContain('<script');
    expect(html).toContain('Flutter');
    expect(html).toContain('static-hap');
  });

  it('writes byte-identical artifacts twice', async () => {
    const path = fixture([
      { name: 'a.png', data: text('same bytes') },
      { name: 'b.png', data: text('same bytes') },
    ]);
    const deps = realDeps('0.10.0');
    const first = join(path, '..', 'out1');
    const second = join(path, '..', 'out2');
    await deps.hap({ packagePath: path, outDir: first });
    await deps.hap({ packagePath: path, outDir: second });
    for (const name of ['hap.json', 'hap.html']) {
      expect(readFileSync(join(second, name))).toEqual(readFileSync(join(first, name)));
    }
  });
});
