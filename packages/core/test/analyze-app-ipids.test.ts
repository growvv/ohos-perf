import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/driver';
import { ProcessQuery } from '../src/query/process';
import { resolveAppIpids } from '../src/analyze/context';
import type { AppIdentity } from '../src/types';

/**
 * The trace records the kernel's `comm`, which is at most 15 characters, so a
 * bundle like `com.hefengbao.jingmo.hw` lands in `process.name` as
 * `ngbao.jingmo.hw`. A capture that did not also record `pids` therefore had
 * no way back to the app's rows, and every app-attributed analyzer reported
 * `no_data` on a trace that was full of the app.
 *
 * This is the measured case: a 6 s hitrace of the jingmo app on the emulator,
 * captured without procfs, holds pid 13549 under the truncated name.
 */
const APP = 'com.hefengbao.jingmo.hw';

let dir: string;
/** Open handles are closed before the directory is removed: Windows refuses
 *  to unlink a file a SQLite handle still has open. */
const opened: Array<{ close(): void }> = [];

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;

function dbWith(rows: ReadonlyArray<[ipid: number, pid: number, name: string]>) {
  const path = join(dir, `p-${Math.random().toString(36).slice(2)}.db`);
  const d = new DatabaseSync(path);
  d.exec(PROCESS_DDL);
  const insert = d.prepare(
    'INSERT INTO process(id, ipid, pid, name, start_ts, switch_count, thread_count, slice_count, mem_count)'
    + ' VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0)',
  );
  for (const [index, [ipid, pid, name]] of rows.entries()) insert.run(index + 1, ipid, pid, name);
  d.close();
  const handle = openDb(path);
  opened.push(handle);
  return new ProcessQuery(handle);
}

function app(overrides: Partial<AppIdentity> = {}): AppIdentity {
  return { packageName: APP, pids: [], processNames: [APP], ...overrides };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-app-ipids-'));
});

afterAll(() => {
  for (const handle of opened) handle.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('resolveAppIpids', () => {
  it('resolves a recorded pid', () => {
    const processes = dbWith([[7, 13549, 'ngbao.jingmo.hw']]);
    expect(resolveAppIpids(processes, app({ pids: [13549] }))).toEqual([7]);
  });

  it('falls back to the comm-truncated process name when no pid was recorded', () => {
    const processes = dbWith([[7, 13549, 'ngbao.jingmo.hw']]);
    expect(resolveAppIpids(processes, app())).toEqual([7]);
  });

  it('finds every process of a multi-process app', () => {
    const processes = dbWith([
      [4, 101, 'com.example.app'],
      [9, 202, 'com.example.app:remote'],
      [11, 303, 'com.example.other'],
    ]);
    expect(resolveAppIpids(processes, app({ packageName: 'com.example.app', processNames: ['com.example.app'] })))
      .toEqual([4, 9]);
  });

  it('does not treat a short or unrelated suffix as the app', () => {
    const processes = dbWith([[3, 10, 'hw'], [5, 20, 'com.other.app']]);
    expect(resolveAppIpids(processes, app())).toEqual([]);
  });

  it('keeps the pid route authoritative when it resolves', () => {
    const processes = dbWith([[7, 13549, 'ngbao.jingmo.hw'], [8, 99, 'com.example.app']]);
    // The pid names a row the name route would also find; the second row is
    // a different process that merely shares the app's recorded name.
    expect(resolveAppIpids(processes, app({ pids: [99] }))).toEqual([8]);
  });
});
