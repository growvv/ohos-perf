import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OhosPerfError } from '../src/errors';
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

  it('opens read-only', () => {
    const db = openDb(dbPath);
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

  it('throws a wrapped error with the path and cause for an unopenable database', () => {
    const missing = join(dir, 'does-not-exist', 'missing.db');
    let thrown: unknown;
    try {
      openDb(missing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OhosPerfError);
    const err = thrown as OhosPerfError;
    expect(err.message).toContain(missing);
    expect(err.code).toBe('DB_OPEN_FAILED');
    expect(err.cause).toBeInstanceOf(Error);
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

  it('counts a user table whose name starts with sqlitefoo but not sqlite internals', () => {
    const path = join(dir, 'like-escape.db');
    const d = new DatabaseSync(path);
    // `_` is a LIKE wildcard: without ESCAPE this would also hide `sqlitefoo`.
    d.exec('CREATE TABLE sqlitefoo(id INT)');
    d.exec('INSERT INTO sqlitefoo VALUES (1), (2)');
    d.exec('CREATE TABLE autoinc(id INTEGER PRIMARY KEY AUTOINCREMENT)');
    d.exec('INSERT INTO autoinc DEFAULT VALUES');
    d.close();

    const db = openDb(path);
    const counts = tableRowCounts(db);
    expect(counts).toEqual({ autoinc: 1, sqlitefoo: 2 });
    expect(counts).not.toHaveProperty('sqlite_sequence');
    db.close();
  });

  it('keeps integer-like table names in sorted order', () => {
    const path = join(dir, 'numeric-names.db');
    const d = new DatabaseSync(path);
    d.exec('CREATE TABLE "10"(id INT)');
    d.exec('CREATE TABLE "2"(id INT)');
    d.exec('CREATE TABLE "9"(id INT)');
    d.close();

    const db = openDb(path);
    const counts = tableRowCounts(db);
    expect(Object.keys(counts)).toEqual(['10', '2', '9']);
    expect(JSON.stringify(counts)).toBe('{"10":0,"2":0,"9":0}');
    db.close();
  });

  it('keeps a table literally named __proto__ as an own property', () => {
    const path = join(dir, 'proto.db');
    const d = new DatabaseSync(path);
    d.exec('CREATE TABLE "__proto__"(id INT)');
    d.exec('INSERT INTO "__proto__" VALUES (1)');
    d.close();

    const db = openDb(path);
    const counts = tableRowCounts(db);
    expect(Object.keys(counts)).toEqual(['__proto__']);
    expect(Object.prototype.hasOwnProperty.call(counts, '__proto__')).toBe(true);
    expect(counts['__proto__']).toBe(1);
    db.close();
  });
});
