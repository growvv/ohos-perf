import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import { FaultTreeAnalyzer } from '../src/analyze/fault-tree';

/**
 * The fault tree's `ipc_binder` section when the context carries no
 * `BinderAnalysis`.
 *
 * That is the path every real `analyze` takes: nothing in the CLI or the
 * engine sets `ctx.binderAnalysis`, so the analyzer derives the analysis
 * itself from the trace. The other tests inject one directly, which exercises
 * only the half that a user never reaches.
 *
 * The two behaviours worth pinning are that the derived section reports the
 * trace's real numbers, and that it stays absent when the trace has no binder
 * events at all — the `hasTable` guard must not turn "no data" into "zero".
 */

const MS = 1_000_000;
const START = 1_000_000_000;

let dir: string;
let withBinder: QueryHandle;
let withoutBinder: QueryHandle;

/**
 * `args` and `data_dict` exist, and one request/reply pair is 3 ms apart on
 * the app's own thread. The `hasTable(db, 'args')` guard therefore passes and
 * the transaction is the app's.
 */
const DDL = `
  CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT);
  CREATE TABLE thread(id INT, tid INT, name TEXT, ipid INT);
  CREATE TABLE callstack(id INT, ts INT, dur INT, callid INT, cat TEXT, name TEXT,
    argsetid INT);
  CREATE TABLE args(id INT, key INT, datatype INT, value INT, argset INT);
  CREATE TABLE data_dict(id INT, data TEXT);
  CREATE TABLE trace_range(start_ts INT, end_ts INT);
`;

function seed(path: string, withEvents: boolean): QueryHandle {
  const d = new DatabaseSync(path);
  d.exec(DDL);
  d.exec(`
    INSERT INTO process VALUES (0, 100, 5000, 'com.demo'), (1, 200, 6000, 'render_service');
    INSERT INTO thread VALUES (10, 5000, 'main', 100), (20, 6001, 'RSThread', 200);
    INSERT INTO data_dict VALUES
      (1, 'transaction id'), (2, 'calling tid'), (4, 'destination process');
    INSERT INTO trace_range VALUES (${START}, ${START + 10 * MS});
  `);
  if (withEvents) {
    d.exec(`
      INSERT INTO args VALUES
        (1, 1, 0, 7, 1), (2, 2, 0, 5000, 1),
        (3, 1, 0, 7, 2), (4, 4, 0, 5000, 2);
      INSERT INTO callstack VALUES
        (1, ${START}, 0, 10, 'binder', 'H:binder transaction', 1),
        (2, ${START + 3 * MS}, 0, 20, 'binder', 'H:binder reply', 2);
    `);
  }
  d.close();
  return openDb(path);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fault-binder-self-'));
  withBinder = seed(join(dir, 'with.db'), true);
  withoutBinder = seed(join(dir, 'without.db'), false);
});

afterAll(() => {
  withBinder.close();
  withoutBinder.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function ctxFor(db: QueryHandle) {
  return {
    db,
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    app: { packageName: 'com.demo', pids: [5000], processNames: ['com.demo'] },
    window: { startNs: START, endNs: START + 9 * MS },
    caps: new CapabilityMatrix([
      {
        id: 'trace.binder' as const,
        available: true,
        fidelity: 'exact' as const,
        probe: { command: 'probe', stdout: '', stderr: '', code: 0 },
      },
    ]),
    deviceId: 'emu-test',
    // Deliberately absent: the analyzer must derive the analysis itself.
  };
}

describe('fault tree ipc_binder, derived from the trace', () => {
  it('reports the transaction the trace contains, without being handed an analysis', async () => {
    const result = await new FaultTreeAnalyzer().run(ctxFor(withBinder) as never);
    const byId = new Map(result.metrics.map((m) => [m.id, m]));

    expect(byId.get('fault.ipc_binder.transactions.count')!.value).toBe(1);
    // 3 ms between the request and the reply.
    expect(byId.get('fault.ipc_binder.latency.avg')!.value).toBe(3);
    expect(byId.get('fault.ipc_binder.latency.max')!.value).toBe(3);
    expect(byId.get('fault.ipc_binder.latency.avg')!.unit).toBe('ms');
  });

  it('omits the section when the trace has the tables but no binder events', async () => {
    // `args` exists, so the guard passes and the analysis runs — it simply
    // finds nothing. The section must be absent rather than three zeros.
    const result = await new FaultTreeAnalyzer().run(ctxFor(withoutBinder) as never);
    expect(result.metrics.some((m) => m.id.startsWith('fault.ipc_binder.'))).toBe(false);
  });
});
