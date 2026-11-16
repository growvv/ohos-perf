import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery, ThreadQuery } from '../src/query/process';
import { SchedQuery, InstantQuery } from '../src/query/sched';
import { ThreadStateQuery } from '../src/query/thread-state';
import { CallstackQuery } from '../src/query/callstack';
import { PerfQuery } from '../src/query/perf';
import { BinderQuery } from '../src/query/binder';
import { StartupQuery } from '../src/query/startup';
import { CapabilityMatrix, type CapabilityId } from '../src/device/capability';
import { defaultAnalyzers, runAnalyzers } from '../src/analyze/engine';
import type { AnalyzeContext } from '../src/analyze/types';
import { runDrillDown, type QueryContext } from '../src/query/registry';

/**
 * End-to-end drill-down over a recorded emulator trace.
 *
 * The fixture is the same 17.9MB export `e2e-offline` uses; this test proves
 * the P3 acceptance criterion on real data: after a full analysis, every
 * `Evidence.drillDown` handle the analyzers emitted resolves through the
 * registry. The fixture is gitignored, so a missing file skips visibly.
 */
const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.OHOS_PERF_E2E_DB ?? join(here, '../../../spike/out/emu_big.db');
const HAVE_DB = existsSync(DB);
const REQUIRED = process.env.OHOS_PERF_E2E_REQUIRED === '1';

if (!HAVE_DB && REQUIRED) {
  throw new Error(
    `OHOS_PERF_E2E_REQUIRED=1 but the drill-down fixture is missing at ${DB}. ` +
      'Run the spike conversion or unset the variable.',
  );
}
if (!HAVE_DB) {
  console.warn(`[drilldown-e2e] skipped: fixture not found at ${DB}`);
}

function available(id: CapabilityId) {
  return {
    id, available: true as const, collector: 'hitrace', fidelity: 'exact' as const,
    probe: { command: '', stdout: '', stderr: '', code: 0 },
  };
}

function ctxFor(db: ReturnType<typeof openDb>): AnalyzeContext {
  const processes = new ProcessQuery(db);
  const pid = processes.byName('pbench.baseline')?.pid;
  return {
    db,
    frames: new FrameQuery(db),
    processes,
    threads: new ThreadQuery(db),
    sched: new SchedQuery(db),
    instant: new InstantQuery(db),
    threadStates: new ThreadStateQuery(db),
    callstacks: new CallstackQuery(db),
    perf: new PerfQuery(db),
    binder: new BinderQuery(db),
    startup: new StartupQuery(db),
    app: {
      packageName: 'pbench.baseline',
      pids: pid === undefined ? [] : [pid],
      processNames: ['pbench.baseline'],
    },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    // mem.procfs is deliberately absent: memory degrades, which guarantees a
    // caps.get handle in the evidence set.
    caps: new CapabilityMatrix([
      available('trace.frames'), available('trace.binder'),
      available('trace.sched'), available('trace.thread_state'),
    ]),
    deviceId: 'emulator-6.1.0.126',
  };
}

describe.skipIf(!HAVE_DB)('drill-down on a recorded trace', () => {
  it('resolves every handle the analyzers emit', async () => {
    const db = openDb(DB);
    try {
      const ctx = ctxFor(db);
      const result = await runAnalyzers(defaultAnalyzers(), ctx);
      const handles = result.evidence.flatMap((e) => e.drillDown);
      expect(handles.length).toBeGreaterThan(0);

      const tools = new Set(handles.map((h) => h.tool));
      expect(tools.has('frames.get')).toBe(true);
      expect(tools.has('caps.get')).toBe(true);

      const queryCtx: QueryContext = { db, app: ctx.app, caps: ctx.caps };
      // Analysis-backed queries (binder/threads) run once per distinct handle;
      // every distinct emitted handle is still proven to resolve.
      const seen = new Set<string>();
      for (const handle of handles) {
        const key = `${handle.tool}:${JSON.stringify(handle.args)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const r = runDrillDown(queryCtx, handle, { limit: 5 });
        expect(r.rows.length, `${handle.tool} returned too many rows`).toBeLessThanOrEqual(5);
        expect(r.total).toBeGreaterThanOrEqual(r.rows.length);
        expect(r.truncated).toBe(r.total > r.rows.length);
        // The fixture is known to populate these; an empty result would mean
        // the analyzer or the query regressed while the envelope stayed valid.
        const NON_EMPTY = new Set([
          'binder.processStats', 'callstack.matching', 'callstack.range', 'frames.get',
        ]);
        if (NON_EMPTY.has(handle.tool)) {
          expect(r.total, `${handle.tool} returned no rows`).toBeGreaterThan(0);
        }
        // Determinism: the same handle resolves identically twice.
        expect(JSON.stringify(runDrillDown(queryCtx, handle, { limit: 5 })))
          .toBe(JSON.stringify(r));
      }

      for (const handle of handles.filter((h) => h.tool === 'frames.get')) {
        const r = runDrillDown(queryCtx, handle);
        expect(r.rows).toHaveLength(1);
        expect((r.rows[0] as { id: number }).id).toBe(handle.args.id);
      }
    } finally {
      db.close();
    }
  });

  it('produces the same evidence and handles on two runs', async () => {
    const db = openDb(DB);
    try {
      const a = await runAnalyzers(defaultAnalyzers(), ctxFor(db));
      const b = await runAnalyzers(defaultAnalyzers(), ctxFor(db));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.evidence.flatMap((e) => e.drillDown.map((h) => h.tool))).toEqual(
        b.evidence.flatMap((e) => e.drillDown.map((h) => h.tool)),
      );
    } finally {
      db.close();
    }
  });
});
