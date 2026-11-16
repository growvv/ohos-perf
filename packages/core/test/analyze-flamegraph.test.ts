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
import { FlamegraphAnalyzer } from '../src/analyze/flamegraph';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

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
const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;

/** App pid 9000 owns perf threads 500 and 501; pid 9001 owns 502. */
function perfDb(name: string, withSamples: boolean): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(PERF_THREAD_DDL);
  d.exec(`INSERT INTO perf_thread VALUES
    (0, 500, 9000, 'main'),
    (1, 501, 9000, 'worker'),
    (2, 502, 9001, 'other')`);
  d.exec(PERF_SAMPLE_DDL);
  d.exec(PERF_CALLCHAIN_DDL);
  d.exec(PERF_FILES_DDL);
  d.exec(`INSERT INTO perf_files VALUES
    (0, 100, 7, 'Foo()', '/lib/libfoo.so'),
    (1, 101, 1, 'Bar()', '/lib/libbar.so'),
    (2, 102, 3, 'Baz()', '/lib/libbaz.so')`);

  if (withSamples) {
    // App weights: 5+7 on chain 10, 3 on chain 11 -> 15. Other process: 4 on
    // chain 12 -> total 19.
    d.exec(`INSERT INTO perf_sample VALUES
      (0, 10, 1000, 500, 5, 1, 1000, 0, 'S'),
      (1, 10, 1100, 500, 7, 1, 1100, 0, 'S'),
      (2, 11, 1200, 501, 3, 1, 1200, 0, 'S'),
      (3, 12, 1300, 502, 4, 1, 1300, 0, 'S')`);
    d.exec(`INSERT INTO perf_callchain VALUES
      (0, 10, 0, 0, 0, 0, 100, 7, 'raw0', 0, 0),
      (1, 10, 1, 0, 0, 0, 101, 1, 'raw1', 0, 0),
      (2, 10, 2, 0, 0, 0, NULL, NULL, 'raw2', 0, 0),
      (3, 10, 3, 0, 0, 0, NULL, NULL, 'raw3', 0, 0),
      (4, 11, 0, 0, 0, 0, 102, 3, 'raw4', 0, 0),
      (5, 12, 0, 0, 0, 0, NULL, NULL, 'other', 0, 0)`);
  }
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
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-flamegraph-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('FlamegraphAnalyzer', () => {
  it('weights stacks by event_count and names the hottest leaf symbol', async () => {
    const db = perfDb('perf.db', true);
    try {
      const r = await new FlamegraphAnalyzer().run(ctxWith(db));
      expect(metricOf(r, 'flamegraph.samples.count').value).toBe(15);
      expect(metricOf(r, 'flamegraph.stacks.count').value).toBe(2);
      expect(metricOf(r, 'flamegraph.top.symbol').value).toBe('raw3');
      expect(metricOf(r, 'flamegraph.top.samples').value).toBe(12);
      expect(metricOf(r, 'flamegraph.app.share').value).toBeCloseTo(78.95, 2);
    } finally {
      db.close();
    }
  });

  it('emits the documented degraded proxy when the perf database has no samples', async () => {
    const db = perfDb('empty.db', false);
    try {
      const r = await new FlamegraphAnalyzer().run(ctxWith(db));
      expect(r.metrics.map((m) => m.id)).toEqual(['flamegraph.degraded']);
      expect(r.metrics[0].fidelity).toBe('proxy');
      expect(r.metrics[0].degraded?.reason).toContain('--hiperf');
    } finally {
      db.close();
    }
  });

  it('omits the top-stack metrics when no app thread has a sample', async () => {
    // The only samples belong to pid 9001, so the app's share is 0 and there is
    // no stack to name.
    const db = perfDb('no-app-samples.db', true);
    try {
      const r = await new FlamegraphAnalyzer().run({
        ...ctxWith(db),
        app: { packageName: 'com.demo', pids: [9999], processNames: ['com.demo'] },
      });
      expect(metricOf(r, 'flamegraph.samples.count').value).toBe(0);
      expect(metricOf(r, 'flamegraph.app.share').value).toBe(0);
      expect(r.metrics.map((m) => m.id)).not.toContain('flamegraph.top.symbol');
      expect(r.metrics.map((m) => m.id)).not.toContain('flamegraph.top.samples');
    } finally {
      db.close();
    }
  });

  it('scopes the sample totals to the analysis window, like the stacks', async () => {
    // Samples at 1000..1300. A window of [0, 1150] holds only the first two,
    // weights 5 and 7; the other process's sample at 1300 is outside it. A
    // share computed over the whole table would report 12/19 = 63.2%.
    const db = perfDb('windowed.db', true);
    try {
      const r = await new FlamegraphAnalyzer().run({
        ...ctxWith(db),
        window: { startNs: 0, endNs: 1150 },
      });
      expect(metricOf(r, 'flamegraph.samples.count').value).toBe(12);
      expect(metricOf(r, 'flamegraph.app.share').value).toBe(100);
      expect(metricOf(r, 'flamegraph.top.samples').value).toBe(12);
    } finally {
      db.close();
    }
  });

  it('reports the real stack count, not the number of stacks it kept', async () => {
    // 25 distinct chains, so the top-20 cut hides five. `stacks.count` is the
    // count of distinct folded stacks, not the payload's length.
    const path = join(dir, 'many-stacks.db');
    const d = new DatabaseSync(path);
    d.exec(PERF_THREAD_DDL);
    d.exec(`INSERT INTO perf_thread VALUES (0, 500, 9000, 'main')`);
    d.exec(PERF_SAMPLE_DDL);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(PERF_FILES_DDL);
    for (let i = 0; i < 25; i++) {
      d.exec(`INSERT INTO perf_files VALUES (${i}, ${1000 + i}, 1, 'Fn${i}()', '/lib/lib.so')`);
      d.exec(`INSERT INTO perf_callchain VALUES (${i}, ${100 + i}, 0, 0, 0, 0, ${1000 + i}, ${i}, 'raw', 0, 0)`);
      d.exec(`INSERT INTO perf_sample VALUES (${i}, ${100 + i}, ${1000 + i}, 500, ${25 - i}, 1, ${1000 + i}, 0, 'S')`);
    }
    d.close();
    const many = openDb(path);
    try {
      const r = await new FlamegraphAnalyzer().run(ctxWith(many));
      expect(metricOf(r, 'flamegraph.stacks.count').value).toBe(25);
      expect(metricOf(r, 'flamegraph.top.symbol').value).toBe('Fn0()');
    } finally {
      many.close();
    }
  });

  it('degrades when the context carries no perf query', async () => {
    const db = perfDb('no-query.db', true);
    try {
      const r = await new FlamegraphAnalyzer().run({ ...ctxWith(db), perf: undefined });
      expect(r.metrics.map((m) => m.id)).toEqual(['flamegraph.degraded']);
    } finally {
      db.close();
    }
  });
});
