import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameAnalyzer } from '../src/analyze/frames';

/**
 * Offline end-to-end check over a recorded emulator trace.
 *
 * The fixture is a real 17.9MB SQLite export of a 249MB hitrace capture, so
 * this is the only test that exercises the full chain — SQLite driver, query
 * layer, analyzer, evidence ids and ordering — against data this project did
 * not author. With the fixture present it must actually run; a silent skip
 * would make `vitest run` report green while nothing end-to-end was verified.
 *
 * The fixture is **not** checked in (`spike/out/` is gitignored), so:
 * - missing + `OHOS_PERF_E2E_REQUIRED=1` -> fail at collection (CI enforcement),
 * - missing otherwise -> warn on stdout and skip visibly,
 * - present -> the three tests below run.
 *
 * See `test/fixtures/README.md` for provenance and regeneration.
 */
const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.OHOS_PERF_E2E_DB ?? join(here, '../../../spike/out/emu_big.db');
const REQUIRED = process.env.OHOS_PERF_E2E_REQUIRED === '1';
const HAVE_DB = existsSync(DB);

if (!HAVE_DB && REQUIRED) {
  // CI assertion that the e2e really ran: a missing fixture is a failure, not
  // a skip. Vitest reports this as `Test Files 1 failed` and exits non-zero.
  throw new Error(
    `OHOS_PERF_E2E_REQUIRED=1 but the e2e fixture is missing at ${DB}. ` +
      `Generate it with trace_streamer (see test/fixtures/README.md) or point ` +
      `OHOS_PERF_E2E_DB at an existing trace.db.`,
  );
}
if (!HAVE_DB) {
  console.warn(
    `[e2e] skipped: fixture not found at ${DB}; ` +
      `set OHOS_PERF_E2E_DB or run the spike conversion (see test/fixtures/README.md)`,
  );
}

describe.skipIf(!HAVE_DB)('e2e on recorded emulator trace', () => {
  it('produces the measured frame metrics from a real trace', async () => {
    const db = openDb(DB);
    try {
      const r = await new FrameAnalyzer().run(ctxFor(db));
      // Assert that the analyzer produced *something* first: an empty result
      // would otherwise make the `!` below throw a bare TypeError and report
      // "cannot read value of undefined" instead of "nothing was analyzed".
      expect(r.metrics.length, 'the analyzer produced no metrics at all').toBeGreaterThan(0);
      expect(r.metrics.find((m) => m.id === 'frame.count')!.value).toBeGreaterThan(0);
      expect(r.metrics.every((m) => m.provenance.table === 'frame_slice')).toBe(true);
      // Values measured on the recorded emulator trace: 169 actual frames, 161
      // rendered (8 empty), 60 stuttered. Asserting concrete numbers lets the
      // e2e catch semantic drift, not just crashes.
      const count = r.metrics.find((m) => m.id === 'frame.count')!.value;
      const rendered = r.metrics.find((m) => m.id === 'frame.rendered.count')!.value;
      expect(count).toBe(169);
      expect(rendered).toBe(161);
      // stuttered / rendered = 60/161 = 37.267...%; the whole reason the
      // denominator is emitted separately is that 60/169 would be 35.50%.
      const jank = r.metrics.find((m) => m.id === 'frame.jank.rate')!.value as number;
      expect(jank).toBeCloseTo(37.27, 1);
      // 60 jank evidence items with 60 distinct ids: using the analysis window
      // for every frame would collapse them to one id per process name.
      const jankEvidence = r.evidence.filter((e) => e.kind === 'jank');
      expect(jankEvidence).toHaveLength(60);
      expect(r.evidence).toHaveLength(60);
      expect(r.evidence.every((e) => e.kind === 'jank')).toBe(true);
      expect(new Set(jankEvidence.map((e) => e.id)).size).toBe(60);
    } finally {
      db.close();
    }
  });

  // The other half of acceptance criterion 5: empty rate, mean duration, fps,
  // and their fidelity. Every expected value is measured, not invented.
  it('reports the remaining measured frame metrics with the right fidelity', async () => {
    const db = openDb(DB);
    try {
      const r = await new FrameAnalyzer().run(ctxFor(db));
      const get = (id: string) => r.metrics.find((m) => m.id === id)!;
      expect(get('frame.empty.rate').value).toBeCloseTo(4.7337, 3);
      expect(get('frame.avg.duration').value).toBeCloseTo(35.8355, 3);
      expect(get('frame.fps').value).toBeCloseTo(5.917, 2);
      // fps is a whole-span average, not HapRay's 1-second sliding window, so
      // it must be labelled approximate.
      expect(get('frame.fps').fidelity).toBe('approximate');
      for (const id of ['frame.count', 'frame.rendered.count', 'frame.jank.rate',
                        'frame.empty.rate', 'frame.avg.duration']) {
        expect(get(id).fidelity).toBe('exact');
      }
    } finally {
      db.close();
    }
  });

  // Acceptance criterion 6: two runs over the same input produce byte-identical
  // JSON (D5). Unit tests cover this with fake databases; the real 17.9MB file
  // is where a large ORDER BY could expose an unstable sort.
  it('is byte-identical across two runs on the real trace', async () => {
    // Both handles must be closed: on Windows an unclosed SQLite handle keeps
    // the file open and later cleanup (in tests or CI) fails.
    const dbA = openDb(DB);
    const dbB = openDb(DB);
    try {
      const a = await new FrameAnalyzer().run(ctxFor(dbA));
      const b = await new FrameAnalyzer().run(ctxFor(dbB));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.metrics.map((m) => m.id)).toEqual([...a.metrics.map((m) => m.id)].sort());
      // Evidence must be sorted by (kind, window.startNs, id). Two runs agreeing
      // only proves the order is stable, not that it is ordered, so assert the
      // sort explicitly as well.
      const key = (e: { kind: string; window: { startNs: number }; id: string }) =>
        `${e.kind}\u0000${String(e.window.startNs).padStart(20, '0')}\u0000${e.id}`;
      expect(a.evidence.map(key)).toEqual([...a.evidence.map(key)].sort());
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

/** Builds the analyzer context once so the three tests cannot drift apart. */
function ctxFor(db: ReturnType<typeof openDb>) {
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    app: { packageName: 'pbench.baseline', pids: [], processNames: [] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: new CapabilityMatrix([
      { id: 'trace.frames' as const, available: true, collector: 'hitrace',
        fidelity: 'exact' as const,
        probe: { command: 'which hitrace', stdout: '/bin/hitrace', stderr: '', code: 0 } },
    ]),
    deviceId: 'emulator-6.1.0.126',
  };
}
