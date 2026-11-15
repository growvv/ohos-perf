import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';

let dir: string;
let db: QueryHandle;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-frames-'));
  const p = join(dir, 't.db');
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  d.exec(`INSERT INTO frame_slice VALUES
    (0, 100, 10, 17, 44, 94, 318000, '', 0, 0, 'actural', 0, 0, 0),
    (1, 90,  10, 17, 44, 94, 200000, '', 0, 1, 'expect',  NULL, 0, 0),
    (2, 300, 11, 17, 44, 95, 900000, '', 0, 0, 'actural', 1, 0, 1),
    (3, 400, 12, 17, 44, 96, 100000, '', 0, 0, 'actural', 2, 0, 2),
    (4, 500, 12, 17, 44, 96, 100000, '', 0, 1, 'expect', 0, 0, 3)`);
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

const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
  callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
  flag INT, depth INT, frame_no INT)`;

describe('FrameQuery', () => {
  it('excludes rows with null flag (incomplete data)', () => {
    const q = new FrameQuery(db);
    expect(q.all().map((f) => f.id)).toEqual([0, 2, 3, 4]);
  });

  it('filters by flag semantics', () => {
    const q = new FrameQuery(db);
    expect(q.stuttered().map((f) => f.id)).toEqual([2]);
    expect(q.empty().map((f) => f.id)).toEqual([3]);
  });

  it('filters by type', () => {
    const q = new FrameQuery(db);
    expect(q.actual().map((f) => f.id)).toEqual([0, 2, 3]);
    expect(q.expect().map((f) => f.id)).toEqual([4]);
  });

  it('expect() excludes rows whose flag is null', () => {
    const q = new FrameQuery(db);
    // Real data: 161/169 expect frames have a NULL flag. Row 1 is that exemplar
    // and must be absent from expect(); only the flag-bearing row 4 survives.
    expect(q.expect().map((f) => f.id)).toEqual([4]);
    expect(q.expect().every((f) => f.flag !== null)).toBe(true);
  });

  it('applies time range on ts, inclusive at both ends', () => {
    const q = new FrameQuery(db);
    expect(q.all({ startNs: 200, endNs: 350 }).map((f) => f.id)).toEqual([2]);
    expect(q.all({ startNs: 300, endNs: 400 }).map((f) => f.id)).toEqual([2, 3]);
  });

  it('applies time range to the filtered accessors too', () => {
    const q = new FrameQuery(db);
    expect(q.stuttered({ startNs: 0, endNs: 250 }).map((f) => f.id)).toEqual([]);
    expect(q.stuttered({ startNs: 250, endNs: 350 }).map((f) => f.id)).toEqual([2]);
    expect(q.actual({ startNs: 350, endNs: 1000 }).map((f) => f.id)).toEqual([3]);
  });

  it('computes stats over the same row set as all(), with actual-only buckets', () => {
    const q = new FrameQuery(db);
    // Same `flag IS NOT NULL` filter as all(), so the row set matches HapRay
    // get_frame_statistics -> get_frames_data. Row 1 is counted nowhere.
    // Row 4 is an expect frame with flag 0, so it is in total/expect but not
    // in the normal bucket: flag buckets are actual (type 0) frames only,
    // deliberately diverging from HapRay's type-agnostic buckets (see stats()).
    expect(q.stats()).toEqual({
      total: 4, actual: 3, expect: 1, stuttered: 1, empty: 1, normal: 1,
    });
  });

  it('excludes expect rows from the empty bucket (expect + flag 2)', () => {
    // The real trace has exactly this shape: 8 type=1 flag=2 rows. Flag
    // semantics describe rendered frames, so empty()/stats().empty must not
    // count them even though total/expect do.
    const mixed = withDb('expect-flag2.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 200, 11, 17, 44, 95, 100000, '', 0, 1, 'expect', 2, 0, 1),
        (2, 300, 12, 17, 44, 96, 100000, '', 0, 0, 'actural', 2, 0, 2)`);
    });
    try {
      const q = new FrameQuery(mixed);
      expect(q.empty().map((f) => f.id)).toEqual([2]);
      const stats = q.stats();
      // The expect row is counted in total and expect ...
      expect(stats.total).toBe(3);
      expect(stats.expect).toBe(1);
      // ... but not in the empty bucket, which is actual-only.
      expect(stats.empty).toBe(1);
      expect(stats).toEqual({
        total: 3, actual: 2, expect: 1, stuttered: 0, empty: 1, normal: 1,
      });
    } finally {
      mixed.close();
    }
  });

  it('excludes expect rows from the stuttered bucket (expect + flag 1)', () => {
    // No such row exists on the measured trace, but the type filter is load
    // bearing: without it a future capture that flags an expect frame would
    // inflate stuttered and the jank rate. Pin the shape explicitly.
    const mixed = withDb('expect-flag1.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 1, 0, 0),
        (1, 200, 11, 17, 44, 95, 100000, '', 0, 1, 'expect', 1, 0, 1)`);
    });
    try {
      const q = new FrameQuery(mixed);
      expect(q.stuttered().map((f) => f.id)).toEqual([0]);
      expect(q.stats()).toEqual({
        total: 2, actual: 1, expect: 1, stuttered: 1, empty: 0, normal: 0,
      });
    } finally {
      mixed.close();
    }
  });

  it('counts flag 3 in total but in no flag bucket', () => {
    // Flag 3 is RS-App abnormal. It is deliberately unbucketed (pinned here so
    // a future `abnormal` field is a conscious change, not an accident): on the
    // measured trace 10 of 169 actual rows are flag 3, so
    // stuttered + empty + normal = 159 = actual - 10, not 169.
    const q3 = withDb('flag3.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 200, 11, 17, 44, 95, 100000, '', 0, 0, 'actural', 3, 0, 1)`);
    });
    try {
      expect(new FrameQuery(q3).stats()).toEqual({
        total: 2, actual: 2, expect: 0, stuttered: 0, empty: 0, normal: 1,
      });
    } finally {
      q3.close();
    }
  });

  it('computes zeroed stats for an empty window', () => {
    const q = new FrameQuery(db);
    expect(q.stats({ startNs: 10_000, endNs: 20_000 })).toEqual({
      total: 0, actual: 0, expect: 0, stuttered: 0, empty: 0, normal: 0,
    });
  });

  it('maps camelCase fields from snake_case columns', () => {
    const q = new FrameQuery(db);
    const f = q.all()[0];
    expect(f.typeDesc).toBe('actural');
    expect(f.callstackId).toBe(94);
    // Whole-object pin: catches any field swap or missed rename.
    expect(f).toEqual({
      id: 0,
      ts: 100,
      vsync: 10,
      ipid: 17,
      itid: 44,
      callstackId: 94,
      dur: 318000,
      src: '',
      dst: 0,
      type: 0,
      typeDesc: 'actural',
      flag: 0,
      depth: 0,
      frameNo: 0,
    });
  });

  it('returns plain objects, not sqlite null-prototype rows', () => {
    const q = new FrameQuery(db);
    const f = q.all()[0];
    expect(Object.getPrototypeOf(f)).toBe(Object.prototype);
  });

  it('orders by ts ascending even when ids descend', () => {
    const ordered = withDb('ordering.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 400, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 300, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 1),
        (2, 200, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 2),
        (3, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 3)`);
    });
    try {
      const q = new FrameQuery(ordered);
      expect(q.all().map((f) => f.id)).toEqual([3, 2, 1, 0]);
      expect(q.actual().map((f) => f.id)).toEqual([3, 2, 1, 0]);
      expect(q.stats().total).toBe(4);
    } finally {
      ordered.close();
    }
  });
});

describe('FrameQuery.mapped', () => {
  it('returns [] when frame_maps is absent instead of throwing', () => {
    const noMaps = withDb('mapped-nomaps.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0)`);
    });
    try {
      expect(new FrameQuery(noMaps).mapped()).toEqual([]);
    } finally {
      noMaps.close();
    }
  });

  it('returns [] when frame_maps is empty instead of throwing', () => {
    const empty = withDb('mapped-empty.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
    });
    try {
      expect(new FrameQuery(empty).mapped()).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it('links same-type frames across processes and sorts by src.ts', () => {
    const cross = withDb('mapped-cross.db', (d) => {
      d.exec(FRAME_DDL);
      // ipid 17 = app, ipid 26 = render_service. Every mapping links rows of
      // the same type, matching the measured trace. The two ends sit in
      // separate vsync domains there (app 3975 vs render_service 6130), so the
      // fixture gives them distinct vsync values too.
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 150, 30, 26, 64, 95, 100000, '', 0, 0, 'actural', 1, 0, 1),
        (2, 300, 11, 17, 44, 96, 100000, '', 0, 1, 'expect', 0, 0, 2),
        (3, 350, 31, 26, 64, 97, 100000, '', 0, 1, 'expect', 0, 0, 3),
        (4, 500, 12, 17, 44, 98, 100000, '', 0, 0, 'actural', 0, 0, 4),
        (5, 550, 32, 26, 64, 99, 100000, '', 0, 0, 'actural', 0, 0, 5)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
      // Deliberately out of ts order to prove the sort is explicit.
      d.exec(`INSERT INTO frame_maps VALUES
        (0, 4, 5),
        (1, 0, 1),
        (2, 2, 3)`);
    });
    try {
      const mapped = new FrameQuery(cross).mapped();
      expect(mapped.map((m) => [m.src.id, m.dst.id])).toEqual([
        [0, 1], // src.ts 100
        [2, 3], // src.ts 300
        [4, 5], // src.ts 500
      ]);
      // The two ends are the same type in different processes, not an
      // actual/expect pair, and they are not joined by vsync either.
      expect(mapped[0].src.ipid).toBe(17);
      expect(mapped[0].dst.ipid).toBe(26);
      expect(mapped[0].src.type).toBe(mapped[0].dst.type);
      expect(mapped[0].src.vsync).not.toBe(mapped[0].dst.vsync);
      expect(mapped[0].src).toEqual({
        id: 0,
        ts: 100,
        vsync: 10,
        ipid: 17,
        itid: 44,
        callstackId: 94,
        dur: 100000,
        src: '',
        dst: 0,
        type: 0,
        typeDesc: 'actural',
        flag: 0,
        depth: 0,
        frameNo: 0,
      });
    } finally {
      cross.close();
    }
  });

  it('skips mappings that reference a null-flag or missing row', () => {
    const sparse = withDb('mapped-sparse.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 150, 10, 26, 64, 95, 100000, '', 0, 1, 'expect', NULL, 0, 1),
        (2, 200, 11, 17, 44, 96, 100000, '', 0, 0, 'actural', 0, 0, 2),
        (3, 250, 11, 26, 64, 97, 100000, '', 0, 0, 'actural', 0, 0, 3),
        (4, 300, 11, 26, 64, 98, 100000, '', 0, 1, 'expect',  NULL, 0, 4)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
      d.exec(`INSERT INTO frame_maps VALUES
        (0, 0, 1),
        (1, 2, 3),
        (2, 99, 3),
        (3, 4, 3)`);
    });
    try {
      // (0, 0, 1): dst row 1 has a NULL flag, so it has no Frame.
      // (2, 99, 3): row 99 does not exist.
      // (3, 4, 3): src row 4 has a NULL flag — the src-side guard.
      expect(new FrameQuery(sparse).mapped().map((m) => [m.src.id, m.dst.id])).toEqual([
        [2, 3],
      ]);
    } finally {
      sparse.close();
    }
  });
});
