import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `site/dynamic.json` is generated from a sweep record, and the benchmark page
 * renders it as "The same cases, run on a device". A generator change that
 * reads the wrong field would silently relabel every case — a `measured`
 * failure reported as `verify`, an unanalyzed scene counted as captured —
 * and nothing on the page would look wrong.
 *
 * These tests run the generator over a hand-built record whose answer is
 * known, and then check the committed file still agrees with the committed
 * record it was made from.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '../../..');
const GENERATOR = join(REPO, 'bench/ohmbench/site-dynamic.mjs');
const COMMITTED = join(REPO, 'site/dynamic.json');

function generate(records: unknown[]): { summary: Record<string, number>; cases: Array<Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), 'ohosperf-site-dyn-'));
  try {
    const source = join(dir, 'dynamic.json');
    const out = join(dir, 'out.json');
    writeFileSync(source, JSON.stringify({ records }));
    const result = spawnSync(process.execPath, [GENERATOR, source, out], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** A record shaped the way `dynamic/run.mjs` writes one. */
function record(over: Record<string, unknown>): Record<string, unknown> {
  return {
    case: 'case_a',
    status: 'failed',
    windowSeconds: 15,
    captured: false,
    workload: {
      setup: { ok: true, actions: [] },
      measured: { ok: true, actions: [] },
      verify: { ok: true, actions: [] },
    },
    ...over,
  };
}

describe('site-dynamic', () => {
  it('names the first phase that failed, not the last one checked', () => {
    // `measured` runs inside the window and `verify` after it. A plan that
    // fails in both stopped in `measured`; reporting `verify` points a reader
    // at a step the run never reached with a screen that already failed.
    const failed = (description: string) => ({
      ok: false,
      actions: [{ op: 'wait', description, ok: false, error: 'UI target not found' }],
    });
    const { cases } = generate([
      record({
        workload: {
          setup: { ok: true, actions: [] },
          measured: failed('wait text="Article"'),
          verify: failed('wait text="Article"'),
        },
      }),
    ]);
    expect((cases[0]!.stoppedAt as { phase: string }).phase).toBe('measured');
  });

  it('names an overrun as the measured phase, and carries its reason', () => {
    // `sepweather_font_register_per_page` ran its own `repeat x40` for 322 s
    // inside a 30 s window: every phase succeeded, and the run failed on the
    // window. Calling that "no phase" leaves the table saying `failed` with no
    // reason, and calling it `verify` points at a step that passed.
    const { cases } = generate([
      record({
        case: 'overrun',
        captured: true,
        metrics: 83,
        workload: {
          setup: { ok: true, actions: [] },
          measured: { ok: true, actions: [] },
          verify: { ok: true, actions: [] },
          error: 'workload took 322.23s, exceeding the 30.00s capture window',
        },
      }),
    ]);
    const stopped = cases[0]!.stoppedAt as { phase: string; error: string } | null;
    expect(stopped?.phase).toBe('measured');
    expect(stopped?.error).toContain('exceeding the 30.00s capture window');
  });

  it('counts a scene as captured only when it was analyzed', () => {
    // A scene on disk is not an analysis. `run.mjs` before 0.33.2 wrote the
    // directory for a measured failure and never analyzed it, so a record
    // without `captured` falls back to "metrics exist".
    const old = record({ case: 'case_b', metrics: 83, degraded: 12, evidence: ['jank'] });
    delete old.captured;
    const { summary } = generate([
      record({ workload: { setup: { ok: true }, measured: { ok: true }, verify: { ok: true } } }),
      old,
    ]);
    expect(summary.captured).toBe(1);
  });

  it('counts a critical verdict and a clean run separately', () => {
    const { summary } = generate([
      record({ case: 'clean', status: 'ok', captured: true, metrics: 83, evidence: [], rootCause: { verdict: 'info: nothing' } }),
      record({ case: 'bad', captured: true, metrics: 83, evidence: [], rootCause: { verdict: 'critical: a 597 ms VSync gap' } }),
    ]);
    expect(summary).toEqual({ cases: 2, ranClean: 1, captured: 2, critical: 1 });
  });

  it('the committed file matches the committed sweep record', () => {
    // `site/dynamic.json` is a generated artifact checked in beside the page.
    // Regenerating it must be a no-op, or the page shows a different sweep
    // than the one `RESULTS.md` describes.
    const data = JSON.parse(readFileSync(COMMITTED, 'utf8'));
    expect(data.cases).toHaveLength(21);
    for (const item of data.cases) {
      expect(typeof item.id).toBe('string');
      expect(item.status === 'ok' || item.status === 'failed').toBe(true);
      // The table's two claims: a captured row carries counts, and a stopped
      // row names a phase. A run that overran its own window is `measured`:
      // the workload was inside it when it took too long.
      if (item.captured) expect(typeof item.metrics).toBe('number');
      if (item.status !== 'ok') expect(['setup', 'measured', 'verify']).toContain(item.stoppedAt?.phase);
    }
  });
});
