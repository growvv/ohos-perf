import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The README and the site quote measured output from the two recorded traces:
 * "80 metrics and 98 evidence items on `emu_big`". Those are claims about what
 * the `analyze` command produces, and P18 moved both — `fault.ipc_binder`
 * added three metrics and the redundant-file analyzer added a `no_data` item —
 * while the prose still said 77 and 97.
 *
 * The number is re-measured by running the built CLI, not by reconstructing
 * its analysis context here: a hand-built context enables a different set of
 * analyzers (its capability matrix is derived from the database's tables) and
 * measures something the quoted command never produces. A first attempt that
 * assembled the context by hand reported 38 metrics against a real 80, which
 * is exactly the kind of test that agrees with itself and not with the user.
 *
 * The fixtures are gitignored; a checkout without them skips, like every other
 * fixture suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '../../..');
const CLI = join(here, '../dist/index.js');
const EMU = join(REPO, 'spike/out/emu_big.db');
const REAL = join(REPO, 'spike/out/real_device.db');

const HAVE_ALL = existsSync(CLI) && existsSync(EMU) && existsSync(REAL);

/** Copy one recorded trace into a throwaway scene and analyze it. */
function measure(dbPath: string, app: string): { metrics: number; evidence: number } {
  const dir = mkdtempSync(join(tmpdir(), 'ohosperf-doc-'));
  try {
    copyFileSync(dbPath, join(dir, 'trace.db'));
    // `--app` is what the README's quoted command passes; without it the
    // binder analyzer is skipped and the counts are a different run.
    const r = spawnSync(process.execPath, [CLI, 'analyze', dir, '--app', app, '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`analyze exited ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as { metrics: unknown[]; evidence: unknown[] };
    return { metrics: parsed.metrics.length, evidence: parsed.evidence.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The counts the README states: `<n> metrics and <n> evidence items on \`trace\``. */
function quoted(text: string, trace: string): { metrics: number; evidence: number } | undefined {
  const match = text.match(new RegExp(`(\\d+) metrics and (\\d+) evidence items on \`${trace}\``));
  return match === null
    ? undefined
    : { metrics: Number(match[1]), evidence: Number(match[2]) };
}

describe.skipIf(!HAVE_ALL)('the quoted analysis counts are measured', () => {
  it('README quotes what `emu_big` actually produces', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    expect(quoted(readme, 'emu_big')).toEqual(measure(EMU, 'pbench.baseline'));
  });

  it('README quotes what `real_device` actually produces', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    expect(quoted(readme, 'real_device')).toEqual(measure(REAL, 'erviceAbility:1'));
  });

  it('the site quotes what `emu_big` actually produces', () => {
    const site = readFileSync(join(REPO, 'site/index.html'), 'utf8');
    const measured = measure(EMU, 'pbench.baseline');
    // The site states the two numbers in prose rather than in the README's
    // `on \`trace\`` shape, so it is matched separately.
    expect(site).toContain(`${measured.metrics} metrics, ${measured.evidence} evidence items`);
  });
});
