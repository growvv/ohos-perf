import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuspects } from '../src/commands';
import { buildProgram } from '../src/program';

/*
 * `ohos-perf suspects <root>` — the static scan as a command.
 *
 * The scan itself is tested in the core; what these tests pin is the command's
 * contract: that a directory is required, that `--json` carries the document,
 * that a prompt file narrows the ranking, that a clean tree is a result and
 * not a failure, and that the flags reach the dependency seam.
 */

const PAGE = [
  'export struct Page {',
  '  build() {',
  '    List() {',
  '      ForEach(this.items, (item: Item) => {',
  '        ListItem() { Text(item.name) }',
  '      })',
  '    }',
  '  }',
  '}',
].join('\n');

const SQL = [
  'export class DbConst {',
  "  static readonly R: string = 'select * from t order by random() limit 1'",
  '}',
].join('\n');

function withTree(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ohos-perf-suspects-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

/** A fake scan result: what the real seam would return for the tree above. */
function scanned(suspects: unknown[], files = 2, symbols = 3) {
  return {
    document: {
      schema: 'ohos-perf.suspects/1' as const,
      root: '/src',
      scanned: { files, symbols },
      suspects,
    } as never,
  };
}

describe('runSuspects', () => {
  it('refuses a path that is not a directory', async () => {
    const result = await runSuspects(cliDeps(), { root: join(tmpdir(), 'no-such-dir-xyz') }, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a directory');
  });

  it('prints the document as JSON when asked', async () => {
    await withTree({ 'a.ets': PAGE }, async (root) => {
      const result = await runSuspects(
        cliDeps({
          async suspects(req) {
            expect(req.root).toBe(root);
            return scanned([{ rank: 1, file: 'a.ets', symbol: 'build', lineStart: 2, lineEnd: 8 }]);
          },
        }),
        { root },
        { json: true },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { schema: string; suspects: unknown[] };
      expect(parsed.schema).toBe('ohos-perf.suspects/1');
      expect(parsed.suspects).toHaveLength(1);
    });
  });

  it('says none, and exits zero, when the tree has no suspects', async () => {
    await withTree({ 'a.ets': PAGE }, async (root) => {
      const result = await runSuspects(
        cliDeps({ async suspects() { return scanned([]); } }),
        { root },
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('suspects none');
      expect(result.stderr).toBe('');
    });
  });

  it('passes the prompt through to the seam', async () => {
    await withTree({ 'a.ets': PAGE }, async (root) => {
      const prompt = { symptom: '打开列表时响应变慢。', perf_scenarios: ['列表滑动'] };
      const result = await runSuspects(
        cliDeps({
          async suspects(req) {
            expect(req.prompt).toEqual(prompt);
            return scanned([]);
          },
        }),
        { root, prompt },
        {},
      );
      expect(result.exitCode).toBe(0);
    });
  });

  it('writes suspects.json when --out is given', async () => {
    const { realDeps } = await import('../src/deps');
    await withTree({ 'a.ets': PAGE }, async (root) => {
      const outDir = mkdtempSync(join(tmpdir(), 'ohos-perf-suspects-out-'));
      try {
        const result = await runSuspects(realDeps(), { root, outDir }, {});
        expect(result.exitCode).toBe(0);
        const written = JSON.parse(readFileSync(join(outDir, 'suspects.json'), 'utf8')) as {
          schema: string;
          suspects: unknown[];
        };
        expect(written.schema).toBe('ohos-perf.suspects/1');
        expect(written.suspects.length).toBeGreaterThan(0);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });

  it('reads a prompt.json through the command line', async () => {
    await withTree(
      { 'a.ets': PAGE, 'prompt.json': JSON.stringify({ symptom: '列表慢', perf_scenarios: ['列表滑动'] }) },
      async (root) => {
        const seen: unknown[] = [];
        const program = buildProgram(
          cliDeps({
            async suspects(req) {
              seen.push(req.prompt);
              return scanned([]);
            },
          }),
          { writeOut: () => {}, writeErr: () => {}, emit: () => {} },
        );
        await program.parseAsync(['node', 'ohos-perf', 'suspects', root, '--prompt', join(root, 'prompt.json')]);
        expect(seen[0]).toEqual({ symptom: '列表慢', perf_scenarios: ['列表滑动'] });
      },
    );
  });

  it('ranks a real tree through the real seam', async () => {
    // End-to-end through the core: the seam is the real one, so this pins the
    // whole path from a directory to a ranked line.
    const { realDeps } = await import('../src/deps');
    await withTree({ 'DbConst.ets': SQL, 'List.ets': PAGE }, async (root) => {
      const result = await runSuspects(realDeps(), { root, prompt: { perf_scenarios: ['数据库读取'] } }, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('sql-order-by-random');
      expect(result.stdout).not.toContain('eager-foreach');
    });
  });
});
