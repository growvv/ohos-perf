import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../../core/test/helpers/hap-zip-writer';
import {
  insn,
  makeElf64,
  OP,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_EXECINSTR,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FUNC,
  text,
} from '../../core/test/helpers/elf-writer';
import { runOptimization } from '../src/commands';

/*
 * `ohos-perf opt <package|lib.so>` — HapRay parity row 27.
 *
 * The command reads a package or a bare library and reports each binary's
 * measured facts and its optimization verdict. The tests below pin the
 * terminal contract: what the lines say, that `--json` carries the document,
 * that a package with no arm64 libraries is a named failure rather than an
 * empty success, and that the flags reach the dependency seam.
 */

const encoder = new TextEncoder();

function textSection(data: Uint8Array) {
  return {
    name: '.text', type: SHT_PROGBITS,
    flags: SHF_ALLOC | SHF_EXECINSTR, data,
  };
}

/** A library whose mix reads as low optimization, with an LTO marker. */
function ltoLibrary(): Uint8Array {
  return makeElf64([
    textSection(text(...Array.from({ length: 100 }, () => OP.add))),
    {
      name: '.symtab',
      symbols: [
        { name: 'main', bind: STB_GLOBAL, type: STT_FUNC, size: 64 },
        { name: 'lto_priv.0.abc', bind: STB_LOCAL, type: STT_FUNC, size: 16 },
      ],
    },
  ]);
}

/** A package carrying one arm64 library. */
function packageWithLibrary(): Uint8Array {
  return makeZip([
    { name: 'module.json', data: encoder.encode('{"app":{"bundleName":"com.demo"}}') },
    { name: 'libs/arm64/libdemo.so', data: ltoLibrary(), method: 0 },
  ]);
}

function withFile(name: string, bytes: Uint8Array, run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ohos-perf-opt-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/**
 * The narrowest deps a command test needs: the real `opt` implementation is
 * exercised through `realDeps` elsewhere, so this stub only proves the command
 * calls the seam with the parsed request.
 */
describe('runOptimization', () => {
  it('reports each binary with its level, basis and LTO verdict', async () => {
    const bytes = packageWithLibrary();
    await withFile('demo.hap', bytes, async (path) => {
      const result = await runOptimization(
        cliDeps({
          async opt(req) {
            expect(req.packagePath).toBe(path);
            return {
              analysis: {
                schemaVersion: 1, package: 'demo.hap',
                binaries: [{
                  path: 'libs/arm64/libdemo.so',
                  facts: {
                    path: 'libs/arm64/libdemo.so', size: 4096, machine: 183,
                    textBytes: 400,
                    instructions: {
                      total: 100, ret: 0, blr: 0, br: 0, bl: 0, b: 0, bcond: 0,
                      cbz: 0, tbz: 0, adrp: 0, adr: 0, ldr: 0, str: 0, add: 100,
                      vector: 0, other: 0,
                    },
                    lto: 'present', ltoMarkers: ['lto_priv.0.abc'],
                    debug: false, debugSections: [], compiler: [], recordedFlags: [],
                    symbols: { functions: 2, global: 1, local: 1, weak: 0 }, stripped: false,
                  },
                  verdict: { level: 'low', basis: 'inferred', signals: ['no_vector_code'] },
                }],
                totals: { binaries: 1, lto: 1, debug: 0, stripped: 0 },
                metrics: [], evidence: [],
              },
              capabilities: [],
            };
          },
        }),
        { packagePath: path },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('package  demo.hap');
      expect(result.stdout).toContain('binaries 1, 1 with LTO');
      expect(result.stdout).toContain('libdemo.so');
      expect(result.stdout).toContain('low');
      expect(result.stdout).toContain('inferred');
      expect(result.stdout).toContain('lto_priv.0.abc');
    });
  });

  it('prints the whole document with --json', async () => {
    const analysis = {
      schemaVersion: 1 as const, package: 'demo.hap', binaries: [],
      totals: { binaries: 0, lto: 0, debug: 0, stripped: 0 }, metrics: [], evidence: [],
    };
    await withFile('demo.hap', new Uint8Array(0), async (path) => {
      const result = await runOptimization(
        cliDeps({ opt: async () => ({ analysis, capabilities: [] }) }),
        { packagePath: path },
        { json: true },
      );
      expect(JSON.parse(result.stdout)).toEqual({ analysis, capabilities: [] });
    });
  });

  it('refuses a path that is not a package or a library', async () => {
    await withFile('notes.txt', new TextEncoder().encode('hi'), async (path) => {
      const result = await runOptimization(cliDeps(), { packagePath: path }, {});
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/expected \.hap, \.hsp, \.zip or \.so/);
    });
  });

  it('refuses an .a archive by name, before any byte is read', async () => {
    await withFile('libx.a', new Uint8Array(8), async (path) => {
      const result = await runOptimization(cliDeps(), { packagePath: path }, {});
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/\.a archive is not read/);
    });
  });

  it('reports a missing file without touching the dependency seam', async () => {
    let called = false;
    const result = await runOptimization(
      cliDeps({ opt: async () => { called = true; throw new Error('unreachable'); } }),
      { packagePath: join(tmpdir(), 'definitely-absent-9f8a7.hap') },
      {},
    );
    expect(called).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no such package/);
  });

  it('turns a package with no arm64 libraries into a named failure', async () => {
    const empty = makeZip([{ name: 'module.json', data: encoder.encode('{}') }]);
    await withFile('empty.hap', empty, async (path) => {
      const result = await runOptimization(
        cliDeps({
          async opt() {
            throw new Error('demo.hap: no arm64 libraries (libs/arm64/*.so) in the package');
          },
        }),
        { packagePath: path },
        {},
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/no arm64 libraries/);
    });
  });

  it('accepts a bare .so as a package path', async () => {
    let seen = '';
    await withFile('libx.so', new Uint8Array(0), async (path) => {
      const result = await runOptimization(
        cliDeps({
          async opt(req) {
            seen = req.packagePath;
            return {
              analysis: {
                schemaVersion: 1 as const, package: 'libx.so', binaries: [],
                totals: { binaries: 0, lto: 0, debug: 0, stripped: 0 }, metrics: [], evidence: [],
              },
              capabilities: [],
            };
          },
        }),
        { packagePath: path },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(seen).toBe(path);
    });
  });
});
