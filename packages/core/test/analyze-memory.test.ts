import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { MemoryAnalyzer } from '../src/analyze/memory';
import type { AnalyzeContext } from '../src/analyze/types';
import type { ProcfsSample } from '../src/collectors/procfs';
import type { Metric } from '../src/report/metric';

const MB = 1024 * 1024;
const START = 1_000_000_000;
const MS = 1_000_000;
const WINDOW = { startNs: START, endNs: START + 3 * MS };
const PROBE = { command: 'probe', stdout: '', stderr: '', code: 0 };

/** MiB expressed in bytes; the collector's `*Bytes` fields are always bytes. */
function mb(value: number): number {
  return value * MB;
}

/** One procfs sample; `pssBytes` adds `smaps_rollup` data when provided. */
function sample(ts: number, rssBytes: number, pssBytes?: number): ProcfsSample {
  return {
    ts,
    pid: 5000,
    status: { vmRssBytes: rssBytes, vmHwmBytes: rssBytes + mb(1), threads: 42 },
    ...(pssBytes === undefined
      ? {}
      : {
          smaps: {
            pssBytes,
            privateDirtyBytes: pssBytes,
            swapPssBytes: 0,
          },
        }),
  };
}

let dir: string;
let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-memory-'));
  const path = join(dir, 't.db');
  // The memory analyzer reads only `ctx.procfs`; the query handles are
  // required by the context type but never used, so an empty database is
  // enough.
  new DatabaseSync(path).close();
  db = openDb(path);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(opts: {
  procfs?: ProcfsSample[];
  processNames?: string[];
} = {}): AnalyzeContext {
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    ...(opts.procfs === undefined ? {} : { procfs: opts.procfs }),
    app: {
      packageName: 'com.demo',
      pids: [5000],
      processNames: opts.processNames ?? ['com.demo'],
    },
    window: WINDOW,
    caps: new CapabilityMatrix([
      { id: 'mem.procfs', available: true, fidelity: 'exact', probe: PROBE },
    ]),
    deviceId: 'emu-memory',
  };
}

function byId(result: { metrics: Metric[] }): Map<string, Metric> {
  return new Map(result.metrics.map((entry) => [entry.id, entry]));
}

interface NoGrowthCase {
  label: string;
  rss: [number, number, number];
}

const NO_GROWTH_CASES: NoGrowthCase[] = [
  { label: 'flat', rss: [mb(100), mb(100), mb(100)] },
  { label: 'shrinking', rss: [mb(150), mb(120), mb(100)] },
];

describe('MemoryAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new MemoryAnalyzer();
    expect(analyzer.id).toBe('memory');
    expect(analyzer.requires).toEqual(['mem.procfs']);
  });

  it('reports peak and mean RSS in bytes with procfs provenance', async () => {
    // 100 MB, 150 MB, 120 MB; the mean is 129324373.33... bytes, rounded to
    // the nearest byte.
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [sample(1, mb(100)), sample(2, mb(150)), sample(3, mb(120))],
      }),
    );

    expect(result.metrics.map((entry) => entry.id)).toEqual([
      'mem.rss.mean',
      'mem.rss.peak',
      'mem.samples',
    ]);
    const metrics = byId(result);
    expect(metrics.get('mem.rss.peak')).toMatchObject({
      value: 157286400,
      unit: 'bytes',
      fidelity: 'exact',
      provenance: { collector: 'procfs', rows: 3, device: 'emu-memory' },
    });
    expect(metrics.get('mem.rss.mean')).toMatchObject({
      value: 129324373,
      unit: 'bytes',
      fidelity: 'exact',
      provenance: { collector: 'procfs', rows: 3, device: 'emu-memory' },
    });
    expect(metrics.get('mem.samples')).toMatchObject({
      value: 3,
      unit: 'count',
      fidelity: 'exact',
      provenance: { collector: 'procfs', rows: 3, device: 'emu-memory' },
    });
    for (const entry of result.metrics) {
      expect(entry.fidelity).toBe('exact');
      expect('window' in entry).toBe(false);
    }
  });

  it('emits one info memory_growth when last RSS exceeds first', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [sample(1, mb(100)), sample(2, mb(150)), sample(3, mb(120))],
      }),
    );

    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    expect(item.kind).toBe('memory_growth');
    expect(item.severity).toBe('info');
    expect(item.subject).toEqual({ process: 'com.demo' });
    expect(item.window).toEqual(WINDOW);
    expect(item.signals).toEqual({
      firstRssBytes: 104857600,
      lastRssBytes: 125829120,
      deltaBytes: 20971520,
      growthPercent: 20,
    });
    expect(item.drillDown).toEqual([]);
    expect(item.explain).toMatch(/RSS grew from 104857600 to 125829120 bytes/);
    expect(item.explain).toContain('20%');
    // The one evidence item is trivially in contract order; keep the check so
    // the result contract is pinned even when more evidence is added later.
    const orderKeys = result.evidence.map(
      (entry) => `${entry.kind}|${entry.window.startNs}|${entry.id}`,
    );
    expect(orderKeys).toEqual([...orderKeys].sort());
    expect('key' in item).toBe(false);
  });

  it('computes PSS peak and mean over only the smaps-bearing samples', async () => {
    // The middle sample has no smaps_rollup data, so PSS must ignore its RSS.
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [
          sample(1, mb(100), mb(80)),
          sample(2, mb(150)),
          sample(3, mb(120), mb(60)),
        ],
      }),
    );

    expect(result.metrics.map((entry) => entry.id)).toEqual([
      'mem.pss.mean',
      'mem.pss.peak',
      'mem.rss.mean',
      'mem.rss.peak',
      'mem.samples',
    ]);
    const metrics = byId(result);
    expect(metrics.get('mem.pss.peak')).toMatchObject({
      value: 83886080,
      unit: 'bytes',
      provenance: { collector: 'procfs', rows: 2, device: 'emu-memory' },
    });
    expect(metrics.get('mem.pss.mean')).toMatchObject({
      value: 73400320,
      unit: 'bytes',
      provenance: { collector: 'procfs', rows: 2, device: 'emu-memory' },
    });
    // RSS still covers every sample.
    expect(metrics.get('mem.rss.mean')).toMatchObject({
      value: 129324373,
      provenance: { collector: 'procfs', rows: 3, device: 'emu-memory' },
    });
    expect(metrics.get('mem.samples')).toMatchObject({ value: 3 });

    // PSS metrics carry the same exact/no-window contract as the RSS pair.
    for (const id of ['mem.pss.peak', 'mem.pss.mean']) {
      expect(metrics.get(id)).toMatchObject({
        fidelity: 'exact',
        provenance: { collector: 'procfs', device: 'emu-memory' },
      });
      expect('window' in metrics.get(id)!).toBe(false);
    }
  });

  it('omits PSS metrics entirely when no sample carries smaps', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [sample(1, mb(100)), sample(2, mb(150)), sample(3, mb(120))],
      }),
    );

    expect(result.metrics.map((entry) => entry.id)).toEqual([
      'mem.rss.mean',
      'mem.rss.peak',
      'mem.samples',
    ]);
    expect(result.metrics.some((entry) => entry.id.startsWith('mem.pss'))).toBe(false);
  });

  it.each(NO_GROWTH_CASES)(
    'emits no growth evidence when RSS is $label',
    async ({ rss }) => {
      const result = await new MemoryAnalyzer().run(
        makeCtx({
          procfs: [sample(1, rss[0]), sample(2, rss[1]), sample(3, rss[2])],
        }),
      );

      expect(result.metrics).toHaveLength(3);
      expect(result.evidence).toEqual([]);
    },
  );

  it('reports growth percent with two decimals, not integer percent', async () => {
    // 100 MiB -> 133.33 MiB is a 33.3333...% increase; the formula rounds to
    // two decimals, so 33.33. An integer-percent regression would yield 33.
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [sample(1, mb(100)), sample(2, Math.round(133.33 * MB))],
      }),
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].signals).toEqual({
      firstRssBytes: 104857600,
      lastRssBytes: 139806638,
      deltaBytes: 34949038,
      growthPercent: 33.33,
    });
  });

  it('reports peak equal to mean for a single sample and no growth', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({ procfs: [sample(1, mb(120), mb(90))] }),
    );

    const metrics = byId(result);
    expect(metrics.get('mem.rss.peak')).toMatchObject({ value: mb(120) });
    expect(metrics.get('mem.rss.mean')).toMatchObject({ value: mb(120) });
    expect(metrics.get('mem.pss.peak')).toMatchObject({ value: mb(90) });
    expect(metrics.get('mem.pss.mean')).toMatchObject({ value: mb(90) });
    expect(metrics.get('mem.samples')).toMatchObject({ value: 1 });
    expect(result.evidence).toEqual([]);
  });

  it('keeps input order for equal timestamps (stable sort)', async () => {
    // The comparator returns 0 for equal ts, and Array.prototype.sort is
    // stable (ES2019+), so the first/last selection follows input order.
    const growth = await new MemoryAnalyzer().run(
      makeCtx({ procfs: [sample(7, mb(100)), sample(7, mb(150))] }),
    );
    expect(growth.evidence[0].signals).toEqual({
      firstRssBytes: mb(100),
      lastRssBytes: mb(150),
      deltaBytes: mb(50),
      growthPercent: 50,
    });

    const shrinking = await new MemoryAnalyzer().run(
      makeCtx({ procfs: [sample(7, mb(150)), sample(7, mb(100))] }),
    );
    expect(shrinking.evidence).toEqual([]);
  });

  it('drops non-finite RSS values without emitting NaN', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [
          sample(1, Number.NaN),
          sample(2, mb(100)),
          sample(3, Number.POSITIVE_INFINITY),
          sample(4, mb(150)),
        ],
      }),
    );

    for (const entry of result.metrics) {
      expect(Number.isFinite(entry.value as number)).toBe(true);
    }
    const metrics = byId(result);
    expect(metrics.get('mem.rss.peak')).toMatchObject({
      value: mb(150),
      provenance: { collector: 'procfs', rows: 2, device: 'emu-memory' },
    });
    expect(metrics.get('mem.rss.mean')).toMatchObject({ value: mb(125) });
    // mem.samples describes capture volume, not the finite series.
    expect(metrics.get('mem.samples')).toMatchObject({ value: 4 });
    expect(result.evidence[0].signals).toEqual({
      firstRssBytes: mb(100),
      lastRssBytes: mb(150),
      deltaBytes: mb(50),
      growthPercent: 50,
    });
  });

  it('takes the no_data branch when every RSS value is non-finite', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [
          sample(1, Number.NaN),
          sample(2, Number.POSITIVE_INFINITY),
        ],
      }),
    );

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('no_data');
    expect(result.evidence[0].explain).toContain('ohos-perf collect --procfs');
  });

  it('ignores a non-finite PSS value and emits no NaN', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [
          sample(1, mb(100), Number.NaN),
          sample(2, mb(120), mb(60)),
        ],
      }),
    );

    for (const entry of result.metrics) {
      expect(Number.isFinite(entry.value as number)).toBe(true);
    }
    const metrics = byId(result);
    expect(metrics.get('mem.pss.peak')).toMatchObject({
      value: mb(60),
      provenance: { collector: 'procfs', rows: 1, device: 'emu-memory' },
    });
    expect(metrics.get('mem.pss.mean')).toMatchObject({ value: mb(60) });
  });

  it('omits PSS metrics when every smaps value is non-finite', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({
        procfs: [sample(1, mb(100), Number.NaN), sample(2, mb(120), Number.NaN)],
      }),
    );
    expect(result.metrics.map((entry) => entry.id)).toEqual([
      'mem.rss.mean',
      'mem.rss.peak',
      'mem.samples',
    ]);
  });

  it('sorts a copy of the samples by ts and never mutates the context array', async () => {
    const first = sample(1, mb(100), mb(80));
    const second = sample(2, mb(150));
    const third = sample(3, mb(120), mb(60));
    const shuffled: ProcfsSample[] = [third, first, second];
    // Sorting the context array in place would throw on a frozen array.
    Object.freeze(shuffled);

    const analyzer = new MemoryAnalyzer();
    const expected = await analyzer.run(
      makeCtx({ procfs: [first, second, third] }),
    );
    const actual = await analyzer.run(makeCtx({ procfs: shuffled }));

    expect(actual).toEqual(expected);
    // First/last come from ts order, not array order: 100 MB -> 120 MB.
    expect(actual.evidence[0].signals).toEqual({
      firstRssBytes: 104857600,
      lastRssBytes: 125829120,
      deltaBytes: 20971520,
      growthPercent: 20,
    });
    expect(shuffled.map((entry) => entry.ts)).toEqual([3, 1, 2]);
  });

  it('rounds means to the nearest byte', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({ procfs: [sample(1, 1), sample(2, 2)] }),
    );
    expect(byId(result).get('mem.rss.mean')).toMatchObject({ value: 2 });
  });

  it('guards the growth percentage when the first RSS is zero', async () => {
    const result = await new MemoryAnalyzer().run(
      makeCtx({ procfs: [sample(1, 0), sample(2, 5)] }),
    );
    expect(result.evidence[0].signals).toEqual({
      firstRssBytes: 0,
      lastRssBytes: 5,
      deltaBytes: 5,
      growthPercent: 0,
    });
  });

  it('returns one no_data evidence and no metrics when procfs is absent', async () => {
    const result = await new MemoryAnalyzer().run(makeCtx());

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    expect(item.kind).toBe('no_data');
    expect(item.severity).toBe('info');
    expect(item.subject).toEqual({ process: 'com.demo' });
    expect(item.window).toEqual(WINDOW);
    expect(item.signals).toEqual({});
    expect(item.explain).toContain('ohos-perf collect --procfs');
    expect(item.drillDown).toEqual([]);
  });

  it('treats an empty procfs array as no data and emits no metrics', async () => {
    const result = await new MemoryAnalyzer().run(makeCtx({ procfs: [] }));

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('no_data');
    expect(result.evidence[0].explain).toContain('ohos-perf collect --procfs');
  });

  it('uses the first non-empty app process name, falling back to the package', async () => {
    const samples = [sample(1, mb(100)), sample(2, mb(120))];

    const named = await new MemoryAnalyzer().run(
      makeCtx({ procfs: samples, processNames: ['', 'com.demo:remote'] }),
    );
    expect(named.evidence[0].subject).toEqual({ process: 'com.demo:remote' });

    const fallback = await new MemoryAnalyzer().run(
      makeCtx({ procfs: samples, processNames: [''] }),
    );
    expect(fallback.evidence[0].subject).toEqual({ process: 'com.demo' });
  });
});
