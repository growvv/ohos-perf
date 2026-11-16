import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { MemMeasureQuery } from '../src/query/mem-measure';

let dir: string;
const opened: QueryHandle[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-memmeasure-'));
});
afterAll(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const FILTER_DDL = 'CREATE TABLE process_measure_filter(id INT, name TEXT, ipid INT)';
const MEASURE_DDL = 'CREATE TABLE process_measure(type INT, ts INT, dur INT, value INT, filter_id INT)';

/**
 * A trace db carrying the two memory-plugin tables.
 *
 * The defaults are the measured shape: `process_measure.ts` is µs-since-boot
 * (817469134282415 for a ~3 s capture is minutes of uptime, not nanoseconds).
 */
function dbWith(
  measures: Array<{ ts?: number; dur?: number; value?: number; filterId?: number }> = [{}],
  filters: Array<{ id: number; name: string; ipid: number }> = [
    { id: 1, name: 'mem.rss', ipid: 42 },
  ],
): QueryHandle {
  const path = join(dir, `m${opened.length}.db`);
  const db = new DatabaseSync(path);
  db.exec(FILTER_DDL);
  db.exec(MEASURE_DDL);
  const insertFilter = db.prepare('INSERT INTO process_measure_filter VALUES (?, ?, ?)');
  for (const filter of filters) insertFilter.run(filter.id, filter.name, filter.ipid);
  const insertMeasure = db.prepare('INSERT INTO process_measure VALUES (?, ?, ?, ?, ?)');
  for (const row of measures) {
    insertMeasure.run(0, row.ts ?? 1000, row.dur ?? 1000, row.value ?? 1234, row.filterId ?? 1);
  }
  db.close();
  const handle = openDb(path);
  opened.push(handle);
  return handle;
}

/** A trace db with no `process_measure` tables at all (an ftrace-only capture). */
function emptyDb(): QueryHandle {
  const path = join(dir, `e${opened.length}.db`);
  new DatabaseSync(path).close();
  const handle = openDb(path);
  opened.push(handle);
  return handle;
}

describe('MemMeasureQuery', () => {
  it('converts microsecond timestamps to nanoseconds', () => {
    // process_measure stores µs-since-boot; a consumer comparing against trace
    // `ts` (ns) would put every row outside the window without this.
    const q = new MemMeasureQuery(dbWith([{ ts: 817469134282415, dur: 505478125 }]));
    const [row] = q.all();
    expect(row.tsNs).toBe(817469134282415 * 1000);
    expect(row.durNs).toBe(505478125 * 1000);
  });

  it('joins the filter name so a row is readable without a second query', () => {
    const [row] = new MemMeasureQuery(dbWith([{ filterId: 1 }])).all();
    expect(row.name).toBe('mem.rss');
    expect(row.ipid).toBe(42);
    expect(row.value).toBe(1234);
  });

  it('returns [] when the scene has no process_measure table', () => {
    expect(new MemMeasureQuery(emptyDb()).all()).toEqual([]);
    expect(new MemMeasureQuery(emptyDb()).forPids([42])).toEqual([]);
    expect(new MemMeasureQuery(emptyDb()).filters()).toEqual([]);
    expect(new MemMeasureQuery(emptyDb()).hasTable()).toBe(false);
  });

  it('orders rows by ts then filter_id', () => {
    const q = new MemMeasureQuery(dbWith(
      [
        { ts: 2000, filterId: 2 },
        { ts: 1000, filterId: 2 },
        { ts: 1000, filterId: 1 },
      ],
      [
        { id: 2, name: 'mem.rss.anon', ipid: 42 },
        { id: 1, name: 'mem.rss', ipid: 42 },
      ],
    ));
    expect(q.all().map((row) => [row.tsNs, row.filterId])).toEqual([
      [1_000_000, 1],
      [1_000_000, 2],
      [2_000_000, 2],
    ]);
  });

  it('filters by pid on the filter table and returns [] for an empty list', () => {
    const q = new MemMeasureQuery(dbWith(
      [{ ts: 1000, filterId: 1 }, { ts: 1000, filterId: 2 }],
      [
        { id: 1, name: 'mem.rss', ipid: 42 },
        { id: 2, name: 'mem.rss', ipid: 43 },
      ],
    ));
    expect(q.forPids([43]).map((row) => row.ipid)).toEqual([43]);
    expect(q.forPids([])).toEqual([]);
  });

  it('compares a nanosecond range against the converted timestamp', () => {
    // A raw-SQL comparison would see ts=1000 <= endNs=1_000_001 and wrongly
    // include the row; the bound is ns and the stored value is µs.
    const q = new MemMeasureQuery(dbWith([{ ts: 1000 }]));
    expect(q.all({ startNs: 1_000_000, endNs: 1_000_000 })).toHaveLength(1);
    expect(q.all({ startNs: 1_000_001, endNs: 2_000_000 })).toEqual([]);
  });

  it('lists the filters ordered by id', () => {
    const q = new MemMeasureQuery(dbWith([{}], [
      { id: 9, name: 'mem.vm.size', ipid: 42 },
      { id: 3, name: 'mem.rss', ipid: 42 },
    ]));
    expect(q.filters()).toEqual([
      { id: 3, name: 'mem.rss', ipid: 42 },
      { id: 9, name: 'mem.vm.size', ipid: 42 },
    ]);
  });
});
