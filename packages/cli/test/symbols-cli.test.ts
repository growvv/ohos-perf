import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  makeElf64,
  OP,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_EXECINSTR,
  STB_GLOBAL,
  STT_FUNC,
  text,
} from '../../core/test/helpers/elf-writer';
import { recoverSymbols } from '@ohos-perf/core';
import { runSymbolRecovery } from '../src/commands';
import type { CliDeps } from '../src/commands';

/*
 * `ohos-perf symbols recover <lib.so|dir> [addresses...]` — HapRay parity row 28.
 *
 * HapRay's tool takes a `perf.db`, pulls the unresolved addresses, and drives
 * radare2 plus an LLM to name them. The command here takes the libraries and
 * the addresses directly, so it works on any capture and any file, and it can
 * also *measure* the model's naming accuracy against names the file records.
 */

function library(): Uint8Array {
  return makeElf64([
    {
      name: '.text', type: SHT_PROGBITS,
      flags: SHF_ALLOC | SHF_EXECINSTR,
      data: text(...Array.from({ length: 64 }, () => OP.add)),
    },
    {
      name: '.symtab',
      symbols: [
        { name: 'parseExpression', bind: STB_GLOBAL, type: STT_FUNC, size: 64, value: 0 },
        { name: 'emitError', bind: STB_GLOBAL, type: STT_FUNC, size: 32, value: 64 },
      ],
    },
  ]);
}

/**
 * The narrowest deps a command test needs.
 *
 * `symbols` is the real core implementation rather than a stub: what these
 * tests assert is the command's rendering of a real recovery, so a stub would
 * only prove the command can echo its own fake.
 */
function stubDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return cliDeps({
    symbols: async (req) => {
      const bytes = readFileSync(req.library);
      return { library: basename(req.library), ...recoverSymbols(bytes, req.addresses) };
    },
    ...overrides,
  });
}

function withFile(name: string, bytes: Uint8Array, run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ohos-perf-sym-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('runSymbolRecovery', () => {
  it('names each address from the library the reference names', async () => {
    await withFile('libx.so', library(), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps(),
        { library: path, addresses: ['libx.so+0x10', 'libx.so+0x50'] },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('libx.so+0x10');
      expect(result.stdout).toContain('parseExpression');
      expect(result.stdout).toContain('libx.so+0x50');
      expect(result.stdout).toContain('emitError');
    });
  });

  it('counts what it recovered and names what it could not', async () => {
    await withFile('libx.so', library(), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps(),
        { library: path, addresses: ['libx.so+0x10', 'libx.so+0xffff'] },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 recovered');
      expect(result.stdout).toContain('1 unresolved');
      expect(result.stdout).toMatch(/no function recorded/i);
    });
  });

  it('refuses a file that is not an ELF, naming it', async () => {
    // The seam prefixes the file name, so the command's job is only to render
    // the refusal as one line and exit 1.
    await withFile('libx.so', new Uint8Array(64), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps({
          symbols: async () => {
            throw new Error('libx.so: not an ELF file: the first four bytes are not \\x7fELF');
          },
        }),
        { library: path, addresses: ['libx.so+0x10'] },
        {},
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/libx\.so/);
      expect(result.stderr).toMatch(/not an ELF/i);
    });
  });

  it('refuses a missing file before any work', async () => {
    const result = await runSymbolRecovery(
      stubDeps(),
      { library: join(tmpdir(), 'absent-7c1f.so'), addresses: [] },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no such library/i);
  });

  it('says a stripped file cannot recover rather than returning an empty success', async () => {
    const stripped = makeElf64([{
      name: '.text', type: SHT_PROGBITS,
      flags: SHF_ALLOC | SHF_EXECINSTR,
      data: text(OP.ret),
    }]);
    await withFile('libx.so', stripped, async (path) => {
      const result = await runSymbolRecovery(
        stubDeps(),
        { library: path, addresses: ['libx.so+0x0'] },
        {},
      );
      expect(result.stdout).toMatch(/stripped|no symbol table/i);
      expect(result.stdout).toContain('0 recovered');
    });
  });

  it('prints the document with --json', async () => {
    await withFile('libx.so', library(), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps(),
        { library: path, addresses: ['libx.so+0x10'] },
        { json: true },
      );
      const document = JSON.parse(result.stdout) as {
        recovered: Array<{ name: string }>;
      };
      expect(document.recovered[0]!.name).toBe('parseExpression');
    });
  });

  it('measures naming accuracy when asked to', async () => {
    // The half HapRay never reports: hold out the names the file records,
    // ask the model to infer them, and state how many it got right.
    await withFile('libx.so', library(), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps({
          symbols: async () => ({
            library: 'libx.so',
            recovered: [],
            unresolved: [],
            naming: {
              heldOut: 2, correct: 1, accuracy: 0.5,
              cases: [
                { truth: 'parseExpression', answer: 'parseExpression', correct: true, start: 0, size: 64 },
                { truth: 'emitError', answer: 'reportError', correct: false, start: 64, size: 32 },
              ],
            },
          }),
        }),
        { library: path, addresses: [], measure: true },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 of 2 named correctly');
      expect(result.stdout).toContain('50.0%');
      expect(result.stdout).toContain('reportError');
      expect(result.stdout).toContain('emitError');
    });
  });

  it('reports an unmeasurable accuracy rather than 0%', async () => {
    await withFile('libx.so', library(), async (path) => {
      const result = await runSymbolRecovery(
        stubDeps({
          symbols: async () => ({
            library: 'libx.so', recovered: [], unresolved: [],
            naming: { heldOut: 0, correct: 0, accuracy: undefined, cases: [] },
          }),
        }),
        { library: path, addresses: [], measure: true },
        {},
      );
      expect(result.stdout).toMatch(/no nameable function/i);
      expect(result.stdout).not.toContain('0.0%');
    });
  });
});
