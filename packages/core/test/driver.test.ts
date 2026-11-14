import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, tableRowCounts } from '../src/db/driver';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-'));
  dbPath = join(dir, 't.db');
  const d = new DatabaseSync(dbPath);
  d.exec('CREATE TABLE frame_slice(id INT, ts INT, flag INT)');
  d.exec('INSERT INTO frame_slice VALUES (0, 100, 0), (1, 200, 1)');
  d.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('openDb', () => {
  it('queries rows with params', () => {
    const db = openDb(dbPath);
    const rows = db.query<{ ts: number }>('SELECT ts FROM frame_slice WHERE flag = ? ORDER BY ts', [0]);
    expect(rows).toEqual([{ ts: 100 }]);
    db.close();
  });

  it('reports row counts per table', () => {
    const db = openDb(dbPath);
    expect(tableRowCounts(db)).toEqual({ frame_slice: 2 });
    db.close();
  });

  it('exposes the db path', () => {
    const db = openDb(dbPath);
    expect(db.path).toBe(dbPath);
    db.close();
  });

  it('opens read-only by default', () => {
    const db = openDb(dbPath);
    expect(db.mode).toBe('read-only');
    // A writable connection would succeed here; a read-only one must refuse.
    expect(() => db.query('INSERT INTO frame_slice VALUES (9, 900, 9)')).toThrow();
    db.close();
  });

  it('defaults params to an empty array', () => {
    const db = openDb(dbPath);
    expect(db.query<{ n: number }>('SELECT COUNT(*) AS n FROM frame_slice')).toEqual([{ n: 2 }]);
    db.close();
  });

  it('closes idempotently', () => {
    const db = openDb(dbPath);
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe('tableRowCounts', () => {
  it('inserts keys in sorted order and quotes reserved table names', () => {
    const path = join(dir, 'reserved.db');
    const d = new DatabaseSync(path);
    d.exec('CREATE TABLE "group"(id INT)');
    d.exec('CREATE TABLE "index"(id INT)');
    d.exec('CREATE TABLE "aaa"(id INT)');
    d.exec('INSERT INTO "group" VALUES (1), (2), (3)');
    d.exec('INSERT INTO "index" VALUES (1)');
    d.exec('INSERT INTO "aaa" VALUES (1), (2)');
    d.close();

    const db = openDb(path);
    const counts = tableRowCounts(db);
    expect(counts).toEqual({ aaa: 2, group: 3, index: 1 });
    expect(Object.keys(counts)).toEqual(['aaa', 'group', 'index']);
    expect(JSON.stringify(counts)).toBe('{"aaa":2,"group":3,"index":1}');
    db.close();
  });

  it('excludes sqlite internal tables', () => {
    const path = join(dir, 'auto.db');
    const d = new DatabaseSync(path);
    d.exec('CREATE TABLE frame_slice(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT)');
    d.exec('INSERT INTO frame_slice(ts) VALUES (1)');
    d.close();

    const db = openDb(path);
    expect(tableRowCounts(db)).toEqual({ frame_slice: 1 });
    db.close();
  });
});

describe('read-only fallback', () => {
  it('retries without readOnly when the open error mentions readonly', async () => {
    vi.resetModules();
    const modes: boolean[] = [];
    vi.doMock('../src/db/sqlite', () => ({
      DatabaseSync: class {
        constructor(_path: string, opts?: { readOnly?: boolean }) {
          modes.push(Boolean(opts?.readOnly));
          if (opts?.readOnly) {
            throw new Error('unable to open database file: readonly');
          }
        }
        prepare() {
          return { all: () => [] };
        }
        close() {}
      },
    }));

    try {
      const { openDb: openWithMock } = await import('../src/db/driver');
      const db = openWithMock('ignored.db');
      expect(db.mode).toBe('read-write');
      expect(modes).toEqual([true, false]);
      db.close();
    } finally {
      vi.doUnmock('../src/db/sqlite');
      vi.resetModules();
    }
  });

  it('rethrows unrelated open errors without retrying', async () => {
    vi.resetModules();
    const modes: boolean[] = [];
    vi.doMock('../src/db/sqlite', () => ({
      DatabaseSync: class {
        constructor(_path: string, opts?: { readOnly?: boolean }) {
          modes.push(Boolean(opts?.readOnly));
          throw new Error('unable to open database file');
        }
        close() {}
      },
    }));

    try {
      const { openDb: openWithMock } = await import('../src/db/driver');
      expect(() => openWithMock('missing.db')).toThrow('unable to open database file');
      expect(modes).toEqual([true]);
    } finally {
      vi.doUnmock('../src/db/sqlite');
      vi.resetModules();
    }
  });
});
