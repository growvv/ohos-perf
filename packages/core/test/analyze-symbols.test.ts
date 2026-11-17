import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { PerfQuery } from '../src/query/perf';
import { ProcessQuery } from '../src/query/process';
import { SymbolsAnalyzer } from '../src/analyze/symbols';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

/*
 * The `symbols` section: what the capture could name, and what it could not.
 *
 * The unresolved half is the point. A hotspot list that silently drops the
 * frames the recorder could not symbolize reads as "the app spent its time in
 * these functions"; the truth is that a measured capture left 9.43% of leaf
 * weight unnamed. This analyzer states both halves and names the fix.
 */

let dir: string;

const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
  thread_name TEXT)`;
const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
  thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT,
  thread_state TEXT)`;
const PERF_CALLCHAIN_DDL = `CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT,
  ip INT, vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
  source_file_id INT, line_number INT)`;
const PERF_FILES_DDL = `CREATE TABLE perf_files(id INT, file_id INT, serial_id INT,
  symbol TEXT, path TEXT)`;
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

/**
 * App pid 9000 owns threads 500 and 501; pid 9001 owns 502.
 *
 * App weight: chain 10 (5 + 7 = 12) on `dladdr`, chain 11 (3) on an
 * unresolved `libjdimage.so+0x1cce24`, chain 14 (2) on a second resolved
 * symbol `JDImageLoad`, chain 15 (1) on an unresolved frame with no file.
 * Resolved 14, unresolved 4, total 18.
 */
function symbolsDb(name: string): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES
    (0, 500, 9000, 'main'),
    (1, 501, 9000, 'worker'),
    (2, 502, 9001, 'other')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(`INSERT INTO perf_sample VALUES
    (0, 10, 1000, 500, 5, 1, 1000, 0, 'S'),
    (1, 10, 1100, 500, 7, 1, 1100, 0, 'S'),
    (2, 11, 1200, 501, 3, 1, 1200, 0, 'S'),
    (3, 12, 1300, 502, 9, 1, 1300, 0, 'S'),
    (4, 14, 1400, 500, 2, 1, 1400, 0, 'S'),
    (5, 15, 1500, 500, 1, 1, 1500, 0, 'S')`);
  d.exec(PERF_CALLCHAIN_DDL);
  d.exec(`INSERT INTO perf_callchain VALUES
    (0, 10, 0, 0, 0, 0, 2, 1, 488, 0, 0),
    (1, 11, 0, 0, 0, 0, 3, 9, 9800, 0, 0),
    (2, 12, 0, 0, 0, 0, NULL, NULL, NULL, 0, 0),
    (3, 14, 0, 0, 0, 0, 3, 0, 488, 0, 0),
    (4, 15, 0, 0, 0, 0, NULL, NULL, 9700, 0, 0)`);
  d.exec(PERF_FILES_DDL);
  d.exec(`INSERT INTO perf_files VALUES
    (0, 2, 0, 'dlopen', '/system/lib/ld-musl.so'),
    (1, 2, 1, 'dladdr', '/system/lib/ld-musl.so'),
    (2, 3, 0, 'JDImageLoad', '/lib/libjdimage.so')`);
  d.exec(DATA_DICT_DDL);
  d.exec(`INSERT INTO data_dict VALUES
    (488, 'start'),
    (9700, 'unknown.so+0x42'),
    (9800, 'libjdimage.so+0x1cce24')`);
  d.close();
  return openDb(path);
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'perf.samples', available: true, collector: 'hiperf', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(target: QueryHandle): AnalyzeContext {
  return {
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    perf: new PerfQuery(target),
    app: { packageName: 'com.demo', pids: [9000], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: Number.MAX_SAFE_INTEGER },
    caps: fullCaps(),
    deviceId: 'offline',
  };
}

function metricOf(r: AnalyzeResult, id: string): Metric {
  const found = r.metrics.find((m) => m.id === id);
  if (found === undefined) {
    throw new Error(`no metric ${id}; got ${r.metrics.map((m) => m.id).join(', ')}`);
  }
  return found;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-symbols-analyzer-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('SymbolsAnalyzer — metrics', () => {
  it('separates resolved weight from unresolved weight', async () => {
    const db = symbolsDb('metrics.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      expect(metricOf(r, 'symbol.samples.count').value).toBe(14);
      expect(metricOf(r, 'symbol.unresolved.count').value).toBe(4);
      // 4 of 18 = 22.22%, rounded to two decimals like every other share.
      expect(metricOf(r, 'symbol.unresolved.share').value).toBeCloseTo(22.22, 2);
    } finally {
      db.close();
    }
  });

  it('counts distinct resolved files and names the heaviest symbol', async () => {
    const db = symbolsDb('top.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      // ld-musl.so and libjdimage.so are the two resolved files; the frame with
      // no file resolves to nothing and is unresolved, so it adds no file.
      expect(metricOf(r, 'symbol.files.count').value).toBe(2);
      expect(metricOf(r, 'symbol.top.symbol').value).toBe('dladdr');
      expect(metricOf(r, 'symbol.top.samples').value).toBe(12);
    } finally {
      db.close();
    }
  });

  it('states provenance, fidelity and window on every metric', async () => {
    const db = symbolsDb('prov.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      for (const m of r.metrics) {
        expect(m.fidelity, m.id).toBe('exact');
        expect(m.provenance.collector, m.id).toBe('hiperf');
        expect(m.provenance.table, m.id).toBe('perf_callchain');
        expect(m.window, m.id).toEqual({ startNs: 0, endNs: Number.MAX_SAFE_INTEGER });
      }
    } finally {
      db.close();
    }
  });

  it('accounts for the whole window: resolved plus unresolved is eventCount', async () => {
    const db = symbolsDb('identity.db');
    try {
      const ctx = ctxWith(db);
      const r = await new SymbolsAnalyzer().run(ctx);
      const threadIds = ctx.perf!.threads([9000]).map((t) => t.threadId);
      const total = ctx.perf!.eventCount(threadIds, ctx.window);
      const resolved = Number(metricOf(r, 'symbol.samples.count').value);
      const unresolved = Number(metricOf(r, 'symbol.unresolved.count').value);
      expect(resolved + unresolved).toBe(total);
    } finally {
      db.close();
    }
  });

  it('sorts metrics by id so two runs agree byte for byte', async () => {
    const db = symbolsDb('sorted.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const ids = r.metrics.map((m) => m.id);
      expect(ids).toEqual([...ids].sort());
    } finally {
      db.close();
    }
  });
});

describe('SymbolsAnalyzer — evidence', () => {
  it('emits one symbol_stats item per resolved symbol, with a drill-down', async () => {
    const db = symbolsDb('stats-evidence.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const items = r.evidence.filter((e) => e.kind === 'symbol_stats');
      expect(items).toHaveLength(2);
      const top = items.find((e) => e.signals.symbol === 'dladdr')!;
      expect(top.signals).toEqual({
        symbol: 'dladdr',
        file: '/system/lib/ld-musl.so',
        samples: 12,
        share: expect.closeTo(66.67, 2),
      });
      expect(top.explain).toContain('dladdr');
      expect(top.explain).toContain('ld-musl.so');
      expect(top.drillDown[0]).toMatchObject({ tool: 'symbol.stats' });
    } finally {
      db.close();
    }
  });

  it('does not tell a reader to symbolize weight that has no frames at all', async () => {
    // A `perf_sample` whose chain has no `perf_callchain` rows is unresolved
    // weight, but `--so-dir` cannot help it: there is no address to symbolize.
    // The item has to say what actually happened instead of naming a flag.
    const path = join(dir, 'frame-less.db');
    const d = new DatabaseSync(path);
    d.exec(PERF_THREAD_DDL);
    d.exec(`INSERT INTO perf_thread VALUES (0, 500, 9000, 'main')`);
    d.exec(PERF_SAMPLE_DDL);
    d.exec(`INSERT INTO perf_sample VALUES
      (0, 10, 1000, 500, 5, 1, 1000, 0, 'S'),
      (1, 11, 1100, 500, 5, 1, 1100, 0, 'S')`);
    d.exec(PERF_CALLCHAIN_DDL);
    // Chain 10 has a frame; chain 11 has none.
    d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 2, 1, 488, 0, 0)`);
    d.exec(PERF_FILES_DDL);
    d.exec(`INSERT INTO perf_files VALUES (0, 2, 1, 'dladdr', '/system/lib/ld-musl.so')`);
    d.exec(DATA_DICT_DDL);
    d.exec(`INSERT INTO data_dict VALUES (488, 'start')`);
    d.close();
    const db = openDb(path);
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const item = r.evidence.find((e) => e.kind === 'unresolved_symbol')!;
      expect(item.signals).toEqual({ symbol: '', file: '', samples: 5 });
      expect(item.explain).not.toContain('--so-dir');
      expect(item.explain).toContain('no callchain frames');
      // The two halves still account for the whole window.
      expect(Number(metricOf(r, 'symbol.samples.count').value)).toBe(5);
      expect(Number(metricOf(r, 'symbol.unresolved.count').value)).toBe(5);
    } finally {
      db.close();
    }
  });

  it('names the missing table, not missing frames, when perf_files is absent', async () => {
    // The frames are there; the table that names them is not. Saying "no
    // callchain frames" would send a reader looking for a truncated
    // conversion that did not happen.
    const path = join(dir, 'no-perf-files.db');
    const d = new DatabaseSync(path);
    d.exec(PERF_THREAD_DDL);
    d.exec(`INSERT INTO perf_thread VALUES (0, 500, 9000, 'main')`);
    d.exec(PERF_SAMPLE_DDL);
    d.exec(`INSERT INTO perf_sample VALUES (0, 10, 1000, 500, 5, 1, 1000, 0, 'S')`);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 1, 0, 900, 0, 0)`);
    d.exec(DATA_DICT_DDL);
    d.exec(`INSERT INTO data_dict VALUES (900, 'main')`);
    d.close();
    const db = openDb(path);
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const item = r.evidence.find((e) => e.kind === 'unresolved_symbol')!;
      expect(item.explain).toContain('perf_files');
      expect(item.explain).not.toContain('no callchain frames');
      expect(item.explain).not.toContain('--so-dir');
    } finally {
      db.close();
    }
  });

  it('emits one unresolved_symbol item per unresolved leaf, naming the fix', async () => {
    const db = symbolsDb('unresolved-evidence.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const items = r.evidence.filter((e) => e.kind === 'unresolved_symbol');
      expect(items).toHaveLength(2);
      const jdimage = items.find((e) => e.signals.symbol === 'libjdimage.so+0x1cce24')!;
      expect(jdimage.signals).toEqual({
        symbol: 'libjdimage.so+0x1cce24',
        file: '/lib/libjdimage.so',
        samples: 3,
      });
      // The fix is a flag on the next capture; saying "unknown" and stopping
      // leaves the reader with nothing to do.
      expect(jdimage.explain).toContain('--so-dir');
      expect(jdimage.drillDown.map((d) => d.tool)).toContain('symbol.stats');
      expect(jdimage.drillDown.map((d) => d.tool)).toContain('frame.load.symbols');
      expect(jdimage.severity).toBe('warn');
    } finally {
      db.close();
    }
  });

  it('gives every evidence item a unique id when two symbols share a name', async () => {
    const db = symbolsDb('unique.db');
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      const ids = r.evidence.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      db.close();
    }
  });

  it('caps each evidence list at ten items, keeping the heaviest', async () => {
    const path = join(dir, 'many.db');
    const d = new DatabaseSync(path);
    d.exec(PERF_THREAD_DDL);
    d.exec(`INSERT INTO perf_thread VALUES (0, 500, 9000, 'main')`);
    d.exec(PERF_SAMPLE_DDL);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(PERF_FILES_DDL);
    for (let i = 0; i < 15; i++) {
      d.exec(`INSERT INTO perf_files VALUES (${i}, ${1000 + i}, 0, 'Fn${i}()', '/lib/lib${i}.so')`);
      d.exec(`INSERT INTO perf_callchain VALUES (${i}, ${100 + i}, 0, 0, 0, 0, ${1000 + i}, 0, NULL, 0, 0)`);
      d.exec(`INSERT INTO perf_sample VALUES (${i}, ${100 + i}, ${1000 + i}, 500, ${15 - i}, 1, ${1000 + i}, 0, 'S')`);
    }
    d.close();
    const many = openDb(path);
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(many));
      expect(r.evidence.filter((e) => e.kind === 'symbol_stats')).toHaveLength(10);
      // The heaviest is kept; the lightest is not.
      const symbols = r.evidence.filter((e) => e.kind === 'symbol_stats')
        .map((e) => e.signals.symbol);
      expect(symbols).toContain('Fn0()');
      expect(symbols).not.toContain('Fn14()');
    } finally {
      many.close();
    }
  });
});

describe('SymbolsAnalyzer — degradation', () => {
  it('emits one degraded proxy when there is no perf query', async () => {
    const db = symbolsDb('no-perf.db');
    try {
      const ctx = { ...ctxWith(db), perf: undefined };
      const r = await new SymbolsAnalyzer().run(ctx);
      expect(r.metrics).toHaveLength(1);
      expect(r.metrics[0]).toMatchObject({ id: 'symbols.degraded', fidelity: 'proxy' });
      expect(r.metrics[0].degraded?.reason).toContain('--hiperf');
      expect(r.evidence).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('emits one degraded proxy when the capture has no samples', async () => {
    const path = join(dir, 'no-samples.db');
    const d = new DatabaseSync(path);
    d.exec(PERF_THREAD_DDL);
    d.exec(PERF_SAMPLE_DDL);
    d.close();
    const db = openDb(path);
    try {
      const r = await new SymbolsAnalyzer().run(ctxWith(db));
      expect(r.metrics).toHaveLength(1);
      expect(r.metrics[0]).toMatchObject({ id: 'symbols.degraded', fidelity: 'proxy' });
      expect(r.evidence).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('requires the perf.samples capability', () => {
    expect(new SymbolsAnalyzer().requires).toEqual(['perf.samples']);
    expect(new SymbolsAnalyzer().id).toBe('symbols');
  });
});
