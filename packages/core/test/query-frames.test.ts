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

  it('computes stats with HapRay-compatible counts', () => {
    const q = new FrameQuery(db);
    // Same `flag IS NOT NULL` filter as all(), mirroring HapRay
    // get_frame_statistics -> get_frames_data. Row 1 is counted nowhere.
    expect(q.stats()).toEqual({
      total: 4, actual: 3, expect: 1, stuttered: 1, empty: 1, normal: 2,
    });
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

describe('FrameQuery.pairs', () => {
  it('returns [] when frame_maps is absent instead of throwing', () => {
    const noMaps = withDb('pairs-nomaps.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0)`);
    });
    try {
      expect(new FrameQuery(noMaps).pairs()).toEqual([]);
    } finally {
      noMaps.close();
    }
  });

  it('returns [] when frame_maps is empty instead of throwing', () => {
    const empty = withDb('pairs-empty.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
    });
    try {
      expect(new FrameQuery(empty).pairs()).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it('resolves mappings into actual/expect pairs and sorts by actual.ts', () => {
    const paired = withDb('pairs.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 150, 10, 17, 44, 94, 100000, '', 0, 1, 'expect', 0, 0, 1),
        (2, 200, 11, 17, 44, 95, 100000, '', 0, 0, 'actural', 1, 0, 2),
        (3, 250, 11, 17, 44, 95, 100000, '', 0, 1, 'expect', NULL, 0, 3),
        (4, 300, 12, 17, 44, 96, 100000, '', 0, 1, 'expect', 0, 0, 4),
        (5,  50,  9, 17, 44, 93, 100000, '', 0, 0, 'actural', 0, 0, 5),
        (6, 350, 12, 17, 44, 96, 100000, '', 0, 1, 'expect', 0, 0, 6)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
      d.exec(`INSERT INTO frame_maps VALUES
        (0, 0, 1),
        (1, 2, 0),
        (2, 3, 4),
        (3, 5, 4),
        (4, 4, 2),
        (5, 99, 0),
        (6, 4, 6)`);
    });
    try {
      const pairs = new FrameQuery(paired).pairs();
      expect(pairs.map((p) => [p.actual.id, p.expect?.id])).toEqual([
        [5, 4], // src actual, dst expect
        [0, 1], // src actual, dst expect
        [2, 0], // both type=0: src anchors actual, dst is the counterpart
        [2, 4], // src expect, dst actual: actual is the dst row
        [4, 6], // both type=1: src anchors actual, dst is the counterpart
      ]);
      // Sorted by actual.ts (50, 100, 200, 200, 300); the 200/200 tie keeps
      // frame_maps.id order (mapping 1 before mapping 4).
      expect(pairs.map((p) => p.actual.ts)).toEqual([50, 100, 200, 200, 300]);
      // Dropped rather than throwing:
      //  (2, 3, 4) names row 3, whose flag is NULL and so has no Frame;
      //  (5, 99, 0) names a row that does not exist.
    } finally {
      paired.close();
    }
  });

  it('skips mappings that reference a null-flag frame', () => {
    const paired = withDb('pairs-nullflag.db', (d) => {
      d.exec(FRAME_DDL);
      d.exec(`INSERT INTO frame_slice VALUES
        (0, 100, 10, 17, 44, 94, 100000, '', 0, 0, 'actural', 0, 0, 0),
        (1, 150, 10, 17, 44, 94, 100000, '', 0, 1, 'expect', NULL, 0, 1)`);
      d.exec('CREATE TABLE frame_maps(id INT, src_row INT, dst_row INT)');
      d.exec('INSERT INTO frame_maps VALUES (0, 0, 1)');
    });
    try {
      // The expect side is the real-world NULL-flag case: it cannot be a Frame.
      expect(new FrameQuery(paired).pairs()).toEqual([]);
    } finally {
      paired.close();
    }
  });
});
