import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import {
  ComponentReuseAnalyzer,
  computeComponentReuse,
  round2HalfEven,
  type ComponentReuse,
} from '../src/analyze/components';
import type { AnalyzeContext, AnalyzeResult } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';

let dir: string;

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/hapray/', import.meta.url));
const SYNTHETIC_SQL = join(FIXTURE_DIR, 'components.synthetic.sql');

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const THREAD_DDL = `CREATE TABLE thread(id INT, itid INT, tid INT, name TEXT,
  start_ts INT, end_ts INT, ipid INT, is_main_thread INT, switch_count INT)`;
const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT,
  type_desc TEXT, flag INT, depth INT, frame_no INT)`;

/** The committed HapRay golden this port must reproduce exactly. */
function golden(): ComponentReuse {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'components.components.json'), 'utf8'),
  ) as ComponentReuse;
}

/** Applies the synthetic fixture SQL, plus optional extra statements. */
function syntheticDb(name: string, extra?: (d: DatabaseSync) => void): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  d.exec(readFileSync(SYNTHETIC_SQL, 'utf8'));
  extra?.(d);
  d.close();
  return openDb(path);
}

function fullCaps(): CapabilityMatrix {
  return new CapabilityMatrix([
    { id: 'trace.ark', available: true, collector: 'hitrace', fidelity: 'exact',
      probe: { command: 'p', stdout: '', stderr: '', code: 0 } },
  ]);
}

function ctxWith(target: QueryHandle, pids: number[] = []): AnalyzeContext {
  return {
    db: target,
    frames: new FrameQuery(target),
    processes: new ProcessQuery(target),
    app: { packageName: 'com.demo', pids, processNames: ['com.demo'] },
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
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-components-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('computeComponentReuse', () => {
  it('matches the HapRay component-reuse golden', () => {
    const db = syntheticDb('golden.db');
    try {
      expect(computeComponentReuse(db, { ipids: [] })).toEqual(golden());
    } finally {
      db.close();
    }
  });

  it('excludes another process’s builds when the app is known', () => {
    // The fixture's rows all belong to thread 44 (ipid 17). One extra build
    // for thread 45 (ipid 18) must not reach the ipid-17 answer.
    const db = syntheticDb('scoped.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0),
        (1, 18, 5000, 'other', 0, 0, 1, 0, 0)`);
      d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'com.demo', 0, 0, 17, 1, 0),
        (45, 45, 450, 'other', 0, 0, 18, 1, 0)`);
      d.exec(`INSERT INTO callstack VALUES
        (7, 1007, 10, 45, 'App', 'H:CustomNode:BuildItem [ItemView][self:91][parent:-1]',
         1, 0, 0, 0, '', '', '', '', '', '', '', '', 0)`);
    });
    try {
      expect(computeComponentReuse(db, { ipids: [17] }).total_builds).toBe(4);
      expect(computeComponentReuse(db, { ipids: [18] }).total_builds).toBe(1);
      expect(computeComponentReuse(db, { ipids: [18] }).max_component).toBe('ItemView');
    } finally {
      db.close();
    }
  });

  it('returns an empty result for a trace with no component builds', () => {
    const db = syntheticDb('empty.db', (d) => {
      d.exec('DELETE FROM callstack');
    });
    try {
      expect(computeComponentReuse(db, { ipids: [] })).toEqual({
        max_component: '',
        total_builds: 0,
        recycled_builds: 0,
        reusability_ratio: 0,
        details: {},
      });
    } finally {
      db.close();
    }
  });

  it('names a recycle-only component by the token after the prefix', () => {
    // HapRay's fallback: `name.split(' ')[1]`. A recycle row with no token at
    // all becomes 'Unknown' rather than crashing.
    const db = syntheticDb('recycle-only.db', (d) => {
      d.exec('DELETE FROM callstack');
      d.exec(`INSERT INTO callstack VALUES
        (0, 1000, 10, 44, 'App', 'H:CustomNode:BuildRecycle Grid', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0),
        (1, 1001, 10, 44, 'App', 'H:CustomNode:BuildRecycle', 1, 0, 0, 0, '', '', '', '', '', '', '', '', 0)`);
    });
    try {
      const result = computeComponentReuse(db, { ipids: [] });
      expect(result.details).toEqual({ Grid: [1, 1], Unknown: [1, 1] });
      // First strict maximum wins: `Grid` was seen first.
      expect(result.max_component).toBe('Grid');
      expect(result.reusability_ratio).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('round2HalfEven', () => {
  it('rounds the ratio the way Python’s round(x, 2) does', () => {
    expect(round2HalfEven(0.125)).toBe(0.12);
    expect(round2HalfEven(0.375)).toBe(0.38);
    expect(round2HalfEven(2.675)).toBe(2.67);
    expect(round2HalfEven(0.5)).toBe(0.5);
  });
});

describe('ComponentReuseAnalyzer', () => {
  /** The golden fixture plus the process/thread rows that identify the app. */
  function appDb(name: string): QueryHandle {
    return syntheticDb(name, (d) => {
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'com.demo', 0, 0, 17, 1, 0)`);
    });
  }

  it('reports the max component’s builds, recycled builds and reuse rate', async () => {
    const db = appDb('analyzer.db');
    try {
      const r = await new ComponentReuseAnalyzer().run(ctxWith(db, [4999]));
      expect(metricOf(r, 'components.builds.count').value).toBe(4);
      expect(metricOf(r, 'components.recycled.count').value).toBe(2);
      expect(metricOf(r, 'components.reuse.rate').value).toBe(50);
      expect(metricOf(r, 'components.top.name').value).toBe('ItemView');
      expect(r.evidence).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('degrades instead of counting every process’s builds when the app is unknown', async () => {
    // `computeComponentReuse` treats an empty scope as "match everything",
    // which is what makes the parity golden reproducible. The analyzer must not
    // pass that through: without a resolved app, another process's builds are
    // not this app's, and labelling them `exact` is the bug.
    const db = syntheticDb('analyzer-unscoped.db');
    try {
      const r = await new ComponentReuseAnalyzer().run(ctxWith(db));
      expect(r.metrics.map((m) => m.id)).toEqual(['components.degraded']);
      expect(metricOf(r, 'components.degraded').fidelity).toBe('proxy');
      expect(metricOf(r, 'components.degraded').degraded?.reason).toContain('no app process');
    } finally {
      db.close();
    }
  });

  it('reports no reuse rate when nothing was built', async () => {
    const db = syntheticDb('analyzer-empty.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(THREAD_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(`INSERT INTO thread VALUES (44, 44, 440, 'com.demo', 0, 0, 17, 1, 0)`);
      d.exec('DELETE FROM callstack');
    });
    try {
      const r = await new ComponentReuseAnalyzer().run(ctxWith(db, [4999]));
      expect(metricOf(r, 'components.builds.count').value).toBe(0);
      const ids = r.metrics.map((m) => m.id);
      expect(ids).not.toContain('components.reuse.rate');
      expect(ids).not.toContain('components.top.name');
    } finally {
      db.close();
    }
  });

  it('degrades instead of crashing when the context has no database', async () => {
    const db = syntheticDb('analyzer-nodb.db');
    try {
      const r = await new ComponentReuseAnalyzer().run({ ...ctxWith(db), db: undefined });
      expect(metricOf(r, 'components.degraded').fidelity).toBe('proxy');
    } finally {
      db.close();
    }
  });
});
