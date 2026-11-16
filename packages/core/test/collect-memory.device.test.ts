import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { readSceneMetadata } from '../src/ingest/metadata';
import { createSceneLayout } from '../src/ingest/scene';
import { MemMeasureQuery } from '../src/query/mem-measure';

/**
 * Real-device acceptance for the memory-plugin collector.
 *
 * The capture test is skipped unless an hdc target is attached. Besides the
 * table counts it pins the two measured properties the analyzer depends on:
 * `process_measure.ts` shares the trace's nanosecond clock, and the filter
 * rows are keyed by the trace's ipid (not the OS pid).
 */

/**
 * Resolve an hdc binary with at least one connected target.
 *
 * Every failure (missing binary, timeout, empty target list) means "skip",
 * not "fail": the repo's CI has no device.
 */
function attachedHdc(): string | undefined {
  const candidates = [
    process.env.OHOS_PERF_HDC,
    process.platform === 'win32'
      ? 'D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
      : undefined,
    'hdc',
  ].filter((path): path is string => path !== undefined);

  for (const hdc of candidates) {
    try {
      const out = execFileSync(hdc, ['list', 'targets'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const targets = out.split(/\r?\n/).filter((line) => {
        const text = line.trim();
        return text !== '' && !text.includes('[Empty]');
      });
      if (targets.length > 0) return hdc;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const HDC = attachedHdc();

describe.skipIf(HDC === undefined)('memory-plugin on an attached device', () => {
  it('captures process_measure with a mem.rss filter in the trace clock base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ohosperf-memory-device-'));
    const target = process.env.OHOS_PERF_TARGET;
    try {
      const device = await connect({
        ...(HDC === undefined ? {} : { hdcPath: HDC }),
        ...(target === undefined ? {} : { target }),
      });
      // An app-less capture is the point of the device-wide collector: the
      // memory-plugin records every process, and nothing here needs a pid.
      const session = await device.collect({
        durationMs: 3000,
        sceneRoot: root,
        hiprofiler: { plugins: ['memory'] },
      });
      const scene = await session.ingest();
      try {
        const measure = scene.traceDb.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM process_measure',
        );
        expect(measure[0].n).toBeGreaterThan(0);

        const filters = scene.traceDb.query<{ n: number }>(
          "SELECT COUNT(*) AS n FROM process_measure_filter WHERE name = 'mem.rss'",
        );
        expect(filters[0].n).toBeGreaterThan(0);

        const query = new MemMeasureQuery(scene.traceDb);
        // The nanosecond clock base: if the table were microseconds and the
        // query multiplied by 1000, every row would fall outside this window
        // (and outside the CLI's Number.MAX_SAFE_INTEGER end).
        const joins = query.all({ startNs: 0, endNs: Number.MAX_SAFE_INTEGER });
        expect(joins.length).toBeGreaterThan(0);

        // The clock must match `trace_range`, not merely fit in a huge window.
        const traceRange = scene.traceDb.query<{ start_ts: number; end_ts: number }>(
          'SELECT start_ts, end_ts FROM trace_range LIMIT 1',
        );
        expect(traceRange).toHaveLength(1);
        for (const row of joins.slice(0, 20)) {
          expect(row.tsNs).toBeGreaterThanOrEqual(traceRange[0].start_ts);
          expect(row.tsNs).toBeLessThanOrEqual(traceRange[0].end_ts);
        }

        // The filter's `ipid` is the trace's internal process id: selecting a
        // real filter ipid must return that process's rows.
        const rssFilter = query.filters().find((filter) => filter.name === 'mem.rss');
        expect(rssFilter).toBeDefined();
        expect(rssFilter!.ipid).toBeGreaterThan(0);
        expect(query.forIpids([rssFilter!.ipid]).length).toBeGreaterThan(0);

        const meta = readSceneMetadata(createSceneLayout(root));
        expect(meta?.capture?.collectors).toEqual(['hiprofiler']);
        expect(meta?.app).toEqual({ packageName: '', processNames: [] });
      } finally {
        scene.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);
});
