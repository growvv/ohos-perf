import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import type { CliDeps, HapOutput } from '../src/commands';
import { runHap } from '../src/commands';
import { buildProgram } from '../src/program';
import { realDeps } from '../src/deps';
import { writeHap, type HapEntry } from './helpers/hap-zip';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const output: HapOutput = {
  package: {
    name: 'demo.hap',
    bundleName: 'com.example.demo',
    versionName: '1.2.3',
    versionCode: 42,
    appName: 'Demo',
  },
  totals: { files: 2, size: 4096, compressedSize: 2048 },
  technologies: [{ ruleId: 'Flutter', type: 'Flutter', files: 1, bytes: 3000 }],
  duplicates: { groups: 1, wastedBytes: 1024 },
  oversized: 0,
  largest: [{ path: 'libs/libflutter.so', size: 3000 }],
};

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
        'duplicates  1 group(s), 1024 bytes wasted\n' +
        'oversized  0 file(s)\n' +
        'largest  libs/libflutter.so  3000 bytes\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('says so when nothing matched a rule', async () => {
    const r = await runHap(
      deps({ hap: async () => ({ ...output, technologies: [] }) }),
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

  it('prints the analysis as JSON', async () => {
    const r = await runHap(deps(), { packagePath: packageFile() }, { json: true });
    expect(JSON.parse(r.stdout)).toEqual(output);
    expect(r.exitCode).toBe(0);
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
    expect(result.package.bundleName).toBe('com.example.demo');
    expect(result.technologies.map((entry) => entry.ruleId)).toContain('Flutter');
    expect(result.duplicates).toEqual({ groups: 1, wastedBytes: 10 });

    const document = JSON.parse(readFileSync(join(outDir, 'hap.json'), 'utf8')) as {
      schemaVersion: number;
      technologies: Array<{ ruleId: string }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.technologies.map((entry) => entry.ruleId)).toContain('Flutter');

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
