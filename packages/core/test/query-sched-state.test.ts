import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { InstantQuery, SchedQuery } from '../src/query/sched';
import { ThreadStateQuery } from '../src/query/thread-state';
import { ThreadQuery } from '../src/query/process';

let dir: string;
let db: QueryHandle;

const SCHED_DDL = `CREATE TABLE sched_slice(id INT, ts INT, dur INT, ts_end INT, cpu INT,
  itid INT, ipid INT, end_state TEXT, priority INT, arg_setid INT)`;
// `instant` and `thread_state` have no `id` column in the P1 trace schema.
const THREAD_STATE_DDL = `CREATE TABLE thread_state(ts INT, dur INT, cpu INT, itid INT,
  tid INT, pid INT, state TEXT, arg_setid INT)`;
const INSTANT_DDL = `CREATE TABLE instant(ts INT, name TEXT, ref INT, wakeup_from INT,
  ref_type TEXT, value REAL)`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-sched-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(SCHED_DDL);
  d.exec(`INSERT INTO sched_slice VALUES
    (0, 300, 10, 310, 2, 50, 19, 'S', 5, 7),
    (1, 100, NULL, NULL, NULL, 44, NULL, NULL, NULL, NULL),
    (2, 100, 5, 105, 1, 44, 17, 'R', 3, 4),
    (3, 500, 1, 501, 0, 50, 17, 'D', 0, 0)`);
  d.exec(THREAD_STATE_DDL);
  d.exec(`INSERT INTO thread_state VALUES
    (200, 70, 1, 44, 4001, 500, 'S', 9),
    (100, 30, 0, 44, 4002, 500, 'R', 8),
    (100, NULL, NULL, 50, NULL, NULL, NULL, NULL),
    (100, 10, 0, 50, 1, 2, 'D', 3)`);
  d.exec(INSTANT_DDL);
  d.exec(`INSERT INTO instant VALUES
    (100, 'sched_wakeup', 44, 50, 'itid', 0),
    (50, 'sched_waking', 44, 51, 'itid', NULL),
    (100, 'sched_wakeup', 44, 49, 'itid', 0),
    (75, 'sched_switch', 44, 50, 'itid', 0),
    (80, 'sched_wakeup', 44, 50, 'pid', 0),
    (90, 'sched_wakeup', 44, NULL, 'itid', 0),
    (95, 'sched_wakeup', NULL, 50, 'itid', 0)`);
  d.close();
  db = openDb(p);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

/** Builds a throwaway trace db from raw SQL, for tests that need their own schema. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  build(d);
  d.close();
  return openDb(p);
}

describe('SchedQuery', () => {
  it('maps camelCase fields from snake_case columns', () => {
    const row = new SchedQuery(db).all().find((s) => s.id === 0);
    expect(row).toEqual({
      id: 0,
      ts: 300,
      dur: 10,
      tsEnd: 310,
      cpu: 2,
      itid: 50,
      ipid: 19,
      endState: 'S',
      priority: 5,
      argSetid: 7,
    });
  });

  it('normalises NULL numerics to 0 and NULL text to empty string', () => {
    const row = new SchedQuery(db).all().find((s) => s.id === 1);
    expect(row).toEqual({
      id: 1,
      ts: 100,
      dur: 0,
      tsEnd: 0,
      cpu: 0,
      itid: 44,
      ipid: 0,
      endState: '',
      priority: 0,
      argSetid: 0,
    });
  });

  it('orders by ts then id, not by insertion order', () => {
    expect(new SchedQuery(db).all().map((s) => s.id)).toEqual([1, 2, 0, 3]);
  });

  it('applies an inclusive time range', () => {
    expect(new SchedQuery(db).all({ startNs: 100, endNs: 300 }).map((s) => s.id))
      .toEqual([1, 2, 0]);
    expect(new SchedQuery(db).all({ startNs: 101, endNs: 299 })).toEqual([]);
  });

  it('filters by itid and keeps the ordering', () => {
    const q = new SchedQuery(db);
    expect(q.forItids([44]).map((s) => s.id)).toEqual([1, 2]);
    expect(q.forItids([50], { startNs: 200, endNs: 500 }).map((s) => s.id)).toEqual([0, 3]);
    expect(q.forItids([])).toEqual([]);
  });
});

describe('ThreadStateQuery', () => {
  it('orders by ts, itid, state', () => {
    const rows = new ThreadStateQuery(db).all();
    expect(rows.map((r) => [r.ts, r.itid, r.state])).toEqual([
      [100, 44, 'R'],
      [100, 50, ''],
      [100, 50, 'D'],
      [200, 44, 'S'],
    ]);
  });

  it('maps camelCase fields and normalises NULLs', () => {
    const rows = new ThreadStateQuery(db).all();
    expect(rows[0]).toEqual({
      ts: 100,
      dur: 30,
      cpu: 0,
      itid: 44,
      tid: 4002,
      pid: 500,
      state: 'R',
      argSetid: 8,
    });
    expect(rows[1]).toEqual({
      ts: 100,
      dur: 0,
      cpu: 0,
      itid: 50,
      tid: 0,
      pid: 0,
      state: '',
      argSetid: 0,
    });
  });

  it('applies an inclusive time range', () => {
    expect(new ThreadStateQuery(db).all({ startNs: 100, endNs: 100 }).map((r) => r.state))
      .toEqual(['R', '', 'D']);
    expect(new ThreadStateQuery(db).all({ startNs: 101, endNs: 199 })).toEqual([]);
  });

  it('filters by itid with an optional range', () => {
    const q = new ThreadStateQuery(db);
    expect(q.forItids([44]).map((r) => r.ts)).toEqual([100, 200]);
    expect(q.forItids([44], { startNs: 150, endNs: 250 }).map((r) => r.ts)).toEqual([200]);
    expect(q.forItids([])).toEqual([]);
  });
});

describe('InstantQuery.wakeups', () => {
  it('keeps only sched_wakeup/sched_waking itid events with both refs', () => {
    const events = new InstantQuery(db).wakeups({ startNs: 0, endNs: 1000 });
    expect(events).toEqual([
      { ts: 50, name: 'sched_waking', ref: 44, wakeupFrom: 51, refType: 'itid', value: 0 },
      { ts: 100, name: 'sched_wakeup', ref: 44, wakeupFrom: 49, refType: 'itid', value: 0 },
      { ts: 100, name: 'sched_wakeup', ref: 44, wakeupFrom: 50, refType: 'itid', value: 0 },
    ]);
  });

  it('orders by ts, ref, wakeup_from and honours the range', () => {
    const events = new InstantQuery(db).wakeups({ startNs: 0, endNs: 75 });
    expect(events.map((e) => [e.ts, e.wakeupFrom])).toEqual([[50, 51]]);
  });
});

describe('real trace smoke', () => {
  const EMU_BIG = 'spike/out/emu_big.db';
  const REAL_DEVICE = 'spike/out/real_device.db';

  it.skipIf(!existsSync(EMU_BIG))('counts sched/thread_state rows and per-pid threads in emu_big', () => {
    const real = openDb(EMU_BIG);
    try {
      expect(new SchedQuery(real).all()).toHaveLength(60053);
      expect(new ThreadStateQuery(real).all()).toHaveLength(121076);
      expect(new ThreadQuery(real).forPid(16702)).toHaveLength(21);
    } finally {
      real.close();
    }
  });

  it.skipIf(!existsSync(REAL_DEVICE))('resolves 18 threads for pid 6115 in real_device', () => {
    const real = openDb(REAL_DEVICE);
    try {
      expect(new ThreadQuery(real).forPid(6115)).toHaveLength(18);
    } finally {
      real.close();
    }
  });
});
