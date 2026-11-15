import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { StartupQuery } from '../src/query/startup';
import { CapabilityMatrix } from '../src/device/capability';
import { StartupAnalyzer } from '../src/analyze/startup';
import type { AnalyzeContext } from '../src/analyze/types';
import type { Metric } from '../src/report/metric';
import { createSceneLayout } from '../src/ingest/scene';
import {
  readSceneMetadata,
  writeSceneMetadata,
  type SceneMetadata,
} from '../src/ingest/metadata';

const PROBE = { command: 'probe', stdout: '', stderr: '', code: 0 };
const WINDOW = { startNs: 0, endNs: 4_000_000_000 };
const STARTED_AT_NS = 1_000_000_000;

const PROCESS_DDL = `CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT,
  start_ts INT, switch_count INT, thread_count INT, slice_count INT, mem_count INT)`;
const FRAME_DDL = `CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT,
  itid INT, callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
  flag INT, depth INT, frame_no INT)`;
const STARTUP_DDL = `CREATE TABLE app_startup(id INT, call_id INT, ipid INT,
  tid INT, start_time INT, end_time INT, start_name INT, packed_name TEXT)`;

/** One `frame_slice` row; every column is spelled out so the query sees a Frame. */
function frame(
  id: number,
  ts: number,
  dur: number,
  type: number,
  ipid = 17,
  flag = 0,
): string {
  return `(${id}, ${ts}, ${id}, ${ipid}, 44, 0, ${dur}, '', 0, ${type},` +
    ` '${type === 0 ? 'actural' : 'expect'}', ${flag}, 0, ${id})`;
}

function metadata(overrides: Partial<SceneMetadata> = {}): SceneMetadata {
  return {
    version: 1,
    app: { packageName: 'com.demo', processNames: ['com.demo'] },
    pids: [4999],
    deviceId: 'emu-startup',
    ...overrides,
  };
}

let dir: string;
const handles: QueryHandle[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-startup-'));
});

afterAll(() => {
  for (const handle of handles) handle.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Builds a throwaway trace db from raw SQL and keeps its handle for cleanup. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const path = join(dir, name);
  const d = new DatabaseSync(path);
  build(d);
  d.close();
  const handle = openDb(path);
  handles.push(handle);
  return handle;
}

function makeCtx(
  db: QueryHandle,
  opts: {
    pids?: number[];
    metadata?: SceneMetadata;
    withStartup?: boolean;
    processNames?: string[];
  } = {},
): AnalyzeContext {
  return {
    frames: new FrameQuery(db),
    processes: new ProcessQuery(db),
    ...(opts.withStartup === false ? {} : { startup: new StartupQuery(db) }),
    ...(opts.metadata === undefined ? {} : { metadata: opts.metadata }),
    app: {
      packageName: 'com.demo',
      pids: opts.pids ?? [4999],
      processNames: opts.processNames ?? ['com.demo'],
    },
    window: WINDOW,
    caps: new CapabilityMatrix([
      { id: 'trace.frames', available: true, fidelity: 'exact', probe: PROBE },
    ]),
    deviceId: 'emu-startup',
  };
}

function byId(result: { metrics: Metric[] }): Map<string, Metric> {
  return new Map(result.metrics.map((entry) => [entry.id, entry]));
}

/** `process` + `frame_slice` with no startup rows, for the fallback branches. */
function fallbackDb(name: string, frames: string[] = []): QueryHandle {
  return withDb(name, (d) => {
    d.exec(PROCESS_DDL);
    d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
    d.exec(FRAME_DDL);
    if (frames.length > 0) {
      d.exec(`INSERT INTO frame_slice VALUES ${frames.join(',')}`);
    }
  });
}

describe('StartupAnalyzer', () => {
  it('is registered under the documented identity', () => {
    const analyzer = new StartupAnalyzer();
    expect(analyzer.id).toBe('startup');
    expect(analyzer.requires).toEqual(['trace.frames']);
  });

  it('reports the count and full span of app_startup rows as exact', async () => {
    const db = withDb('branch1.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 17, 44, 1000000000, 2500000000, 7, 'packed'),
        (1, 2, 17, 45, 2000000000, 3000000000, 8, 'packed')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));

    expect(result.metrics.map((entry) => entry.id)).toEqual([
      'startup.count',
      'startup.duration',
    ]);
    const metrics = byId(result);
    expect(metrics.get('startup.count')).toMatchObject({
      value: 2,
      unit: 'count',
      fidelity: 'exact',
      provenance: {
        collector: 'hitrace+streamer',
        table: 'app_startup',
        rows: 2,
        device: 'emu-startup',
      },
    });
    expect(metrics.get('startup.duration')).toMatchObject({
      value: 2000,
      unit: 'ms',
      fidelity: 'exact',
      provenance: {
        collector: 'hitrace+streamer',
        table: 'app_startup',
        rows: 2,
        device: 'emu-startup',
      },
    });
    for (const entry of result.metrics) {
      expect('window' in entry).toBe(false);
      expect('degraded' in entry).toBe(false);
    }
    expect(result.evidence).toEqual([]);
  });

  it('computes 1500 ms for a single row from 1e9 to 2.5e9', async () => {
    const db = withDb('branch1-single.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 17, 44, 1000000000, 2500000000, 7, 'packed')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));
    const metrics = byId(result);
    expect(metrics.get('startup.count')).toMatchObject({ value: 1 });
    expect(metrics.get('startup.duration')).toMatchObject({ value: 1500 });
  });

  it('never treats an app pid as an ipid when selecting startup rows', async () => {
    // The app pid is 4999 and its ipid is 17. A row whose `ipid` is 4999
    // belongs to some other process and must not be counted; the row with
    // `end_time < start_time` is invalid and must be dropped.
    const db = withDb('branch1-pid-vs-ipid.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 17, 44, 1000000000, 2500000000, 7, 'packed'),
        (1, 2, 4999, 45, 5000000000, 6000000000, 8, 'pid-not-ipid'),
        (2, 3, 17, 46, 7000000000, 6000000000, 9, 'inverted')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));
    const metrics = byId(result);
    expect(metrics.get('startup.count')).toMatchObject({
      value: 1,
      provenance: { table: 'app_startup', rows: 1 },
    });
    expect(metrics.get('startup.duration')).toMatchObject({ value: 1500 });
  });

  it('counts a row when the resolved ipid happens to equal the app pid', async () => {
    const db = withDb('branch1-ipid-equals-pid.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 5000, 5000, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 5000, 44, 1000000000, 2000000000, 7, 'packed')`);
    });

    const result = await new StartupAnalyzer().run(
      makeCtx(db, { pids: [5000] }),
    );
    expect(byId(result).get('startup.count')).toMatchObject({ value: 1 });
    expect(byId(result).get('startup.duration')).toMatchObject({ value: 1000 });
  });

  it('ignores a process row whose ipid is NULL', async () => {
    // The query layer maps a NULL `ipid` to 0. Numeric 0 means "absent", so
    // neither the app pid nor a startup row with ipid 0 may be attributed.
    const db = withDb('branch1-null-ipid.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 0, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 0, 44, 1000000000, 2500000000, 7, 'null-ipid')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('startup');
  });

  it('drops a startup row whose start_time is NULL (0)', async () => {
    const db = withDb('branch1-zero-start.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 17, 44, 0, 2500000000, 7, 'null-start'),
        (1, 2, 17, 45, 1000000000, 2000000000, 8, 'packed')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));
    const metrics = byId(result);
    expect(metrics.get('startup.count')).toMatchObject({ value: 1 });
    expect(metrics.get('startup.duration')).toMatchObject({ value: 1000 });
  });

  it('uses the maximum end_time even when it is not the last row by start_time', async () => {
    // The longest end belongs to the first row. A `lastRow.endTime -
    // firstRow.startTime` implementation would report 2000 ms, not 2500.
    const db = withDb('branch1-span.db', (d) => {
      d.exec(PROCESS_DDL);
      d.exec(`INSERT INTO process VALUES (0, 17, 4999, 'com.demo', 0, 0, 1, 0, 0)`);
      d.exec(STARTUP_DDL);
      d.exec(`INSERT INTO app_startup VALUES
        (0, 1, 17, 44, 1000000000, 3500000000, 7, 'long'),
        (1, 2, 17, 45, 2500000000, 3000000000, 8, 'short')`);
    });

    const result = await new StartupAnalyzer().run(makeCtx(db));
    expect(byId(result).get('startup.duration')).toMatchObject({ value: 2500 });
  });

  it('derives an approximate duration from the marker and first actual frame', async () => {
    const db = fallbackDb('branch2.db', [
      // An actual frame before the marker and an expect frame after it must
      // both be ignored; the first actual frame at/after the marker wins.
      frame(0, 800_000_000, 10_000_000, 0),
      frame(1, 1_100_000_000, 10_000_000, 1),
      frame(2, 1_200_000_000, 50_000_000, 0),
      frame(3, 1_300_000_000, 10_000_000, 0),
    ]);

    const result = await new StartupAnalyzer().run(
      makeCtx(db, { metadata: metadata({ startedAtNs: STARTED_AT_NS }) }),
    );

    expect(result.metrics.map((entry) => entry.id)).toEqual(['startup.duration']);
    const duration = result.metrics[0];
    expect(duration).toMatchObject({
      value: 250,
      unit: 'ms',
      fidelity: 'approximate',
      degraded: {
        reason: 'app_startup table is empty; derived from start marker and first frame',
        fallback: 'marker-to-first-frame',
      },
      provenance: {
        collector: 'hitrace+streamer',
        table: 'frame_slice',
        rows: 1,
        device: 'emu-startup',
      },
    });
    expect('window' in duration).toBe(false);
    expect(result.evidence).toEqual([]);
  });

  it('reports no_data instead of a negative duration for a corrupt frame', async () => {
    // The first actual frame after the marker ends before it (negative dur).
    // A negative startup time must never be reported as a measurement.
    const db = fallbackDb('branch2-negative-dur.db', [
      frame(0, 1_200_000_000, -500_000_000, 0),
    ]);

    const result = await new StartupAnalyzer().run(
      makeCtx(db, { metadata: metadata({ startedAtNs: STARTED_AT_NS }) }),
    );

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('startup');
    expect(result.evidence[0].explain).toContain('invalid duration');
    expect(result.evidence[0].explain).toContain('startedAtNs');
  });

  it('derives the fallback without ctx.startup being supplied', async () => {
    const db = fallbackDb('branch2-no-startup-query.db', [
      frame(0, 1_200_000_000, 50_000_000, 0),
    ]);

    const result = await new StartupAnalyzer().run(
      makeCtx(db, {
        withStartup: false,
        metadata: metadata({ startedAtNs: STARTED_AT_NS }),
      }),
    );
    expect(byId(result).get('startup.duration')).toMatchObject({ value: 250 });
  });

  it('reports no_data when the marker has no actual frame after it', async () => {
    // Only expect frames follow the marker; actual frames exist only before it.
    const db = fallbackDb('branch2-expect-only.db', [
      frame(0, 800_000_000, 10_000_000, 0),
      frame(1, 1_100_000_000, 10_000_000, 1),
      frame(2, 1_300_000_000, 10_000_000, 1),
    ]);

    const result = await new StartupAnalyzer().run(
      makeCtx(db, { metadata: metadata({ startedAtNs: STARTED_AT_NS }) }),
    );

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    expect(item.kind).toBe('startup');
    expect(item.severity).toBe('info');
    expect(item.subject).toEqual({ process: 'com.demo' });
    expect(item.window).toEqual(WINDOW);
    expect(item.signals).toEqual({});
    expect(item.drillDown).toEqual([]);
    expect(item.explain).toContain('startedAtNs');
    expect(item.explain).toContain('actual frame');
  });

  it('reports no_data when neither startup rows nor a start marker exist', async () => {
    const db = fallbackDb('branch3.db');

    const result = await new StartupAnalyzer().run(makeCtx(db));

    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    const [item] = result.evidence;
    expect(item.kind).toBe('startup');
    expect(item.severity).toBe('info');
    expect(item.subject).toEqual({ process: 'com.demo' });
    expect(item.window).toEqual(WINDOW);
    expect(item.signals).toEqual({});
    expect(item.drillDown).toEqual([]);
    expect(item.explain).toContain('app_startup');
    expect(item.explain).toContain('startedAtNs');
  });

  it.each([
    ['metadata is absent', undefined],
    ['startedAtNs is absent', metadata()],
    ['startedAtNs is zero', metadata({ startedAtNs: 0 })],
    ['startedAtNs is negative', metadata({ startedAtNs: -1 })],
    ['startedAtNs is NaN', metadata({ startedAtNs: Number.NaN })],
    ['startedAtNs is Infinity', metadata({ startedAtNs: Number.POSITIVE_INFINITY })],
  ])('takes the no_data branch when %s', async (_label, meta) => {
    const db = fallbackDb(`branch3-${String(_label).replace(/\W+/g, '-')}.db`, [
      frame(0, 1_200_000_000, 50_000_000, 0),
    ]);

    const result = await new StartupAnalyzer().run(
      makeCtx(db, { metadata: meta }),
    );
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('startup');
    expect(result.evidence[0].explain).toContain('app_startup');
    expect(result.evidence[0].explain).toContain('startedAtNs');
  });

  it('treats a zero start marker as no marker, not a duration', async () => {
    // A frame follows uptime 0, so an accepted marker would derive a huge
    // approximate duration (the M3 defect). With the marker dropped, the
    // analyzer reports the no-marker evidence instead.
    const db = fallbackDb('branch2-zero-marker.db', [
      frame(0, 1_200_000_000, 50_000_000, 0),
    ]);
    const result = await new StartupAnalyzer().run(
      makeCtx(db, { metadata: metadata({ startedAtNs: 0 }) }),
    );
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].kind).toBe('startup');
    expect(result.evidence[0].explain).toContain('no startup data');
  });

  it('uses the first non-empty app process name, falling back to the package', async () => {
    const db = fallbackDb('branch3-name.db');

    const named = await new StartupAnalyzer().run(
      makeCtx(db, { processNames: ['', 'com.demo:remote'] }),
    );
    expect(named.evidence[0].subject).toEqual({ process: 'com.demo:remote' });

    const fallback = await new StartupAnalyzer().run(
      makeCtx(db, { processNames: [''] }),
    );
    expect(fallback.evidence[0].subject).toEqual({ process: 'com.demo' });
  });
});

describe('scene metadata', () => {
  function layout(name: string) {
    return createSceneLayout(join(dir, name));
  }

  it('round-trips every field and creates the scene root', () => {
    const l = layout('meta-roundtrip');
    const meta = metadata({
      startedAtNs: STARTED_AT_NS,
      capture: { startedAtMs: 1_700_000_000_000, durationMs: 10_000, collectors: ['hitrace'] },
    });

    writeSceneMetadata(l, meta);

    expect(readSceneMetadata(l)).toEqual(meta);
    expect(readFileSync(l.metadataFile, 'utf8')).toBe(
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    expect(l.metadataFile).toBe(join(l.root, 'scene.json'));
  });

  it('returns undefined when the file is missing', () => {
    expect(readSceneMetadata(layout('meta-missing'))).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    const l = layout('meta-malformed');
    writeSceneMetadata(l, metadata());
    writeFileSync(l.metadataFile, '{not json');
    expect(readSceneMetadata(l)).toBeUndefined();
  });

  it('returns undefined for a wrong version', () => {
    const l = layout('meta-version');
    writeSceneMetadata(l, metadata());
    writeFileSync(l.metadataFile, JSON.stringify({ ...metadata(), version: 2 }));
    expect(readSceneMetadata(l)).toBeUndefined();
  });

  it('returns undefined for a non-object document', () => {
    for (const text of ['[]', '42', 'null', '"scene"']) {
      const l = layout(`meta-non-object-${text.length}`);
      writeSceneMetadata(l, metadata());
      writeFileSync(l.metadataFile, text);
      expect(readSceneMetadata(l), text).toBeUndefined();
    }
  });

  it('returns undefined for a version-1 object missing required fields', () => {
    const docs: unknown[] = [
      { version: 1 },
      { version: 1, app: { packageName: 'com.demo', processNames: ['com.demo'] } },
      { ...metadata(), pids: '4999' },
      { ...metadata(), app: { packageName: 'com.demo', processNames: [7] } },
      { ...metadata(), deviceId: 7 },
    ];
    docs.forEach((doc, index) => {
      const l = layout(`meta-shape-${index}`);
      writeSceneMetadata(l, metadata());
      writeFileSync(l.metadataFile, JSON.stringify(doc));
      expect(readSceneMetadata(l), JSON.stringify(doc)).toBeUndefined();
    });
  });

  it('treats a non-finite or negative startedAtNs as absent without rewriting the file', () => {
    for (const startedAtNs of [-5, null, '1e9']) {
      const l = layout(`meta-marker-${String(startedAtNs).replace(/\W+/g, '-')}`);
      writeSceneMetadata(l, metadata());
      const text = JSON.stringify({ ...metadata(), startedAtNs }, null, 2) + '\n';
      writeFileSync(l.metadataFile, text);

      const read = readSceneMetadata(l);
      expect(read, String(startedAtNs)).toBeDefined();
      expect(read !== undefined && 'startedAtNs' in read).toBe(false);
      // The analyzer ignores the bad marker; the file itself is untouched.
      expect(readFileSync(l.metadataFile, 'utf8')).toBe(text);
    }
  });

  it('drops a zero start marker (uptime 0 addresses the trace origin, not the capture start)', () => {
    const l = layout('meta-marker-zero');
    writeSceneMetadata(l, metadata({ startedAtNs: 0 }));
    const read = readSceneMetadata(l);
    // The metadata is still valid; only the non-marker field is discarded.
    expect(read).toEqual(metadata());
    expect(read !== undefined && 'startedAtNs' in read).toBe(false);
  });

  it('round-trips an empty device id', () => {
    // Only the type is required, so a write must never produce a file that the
    // reader refuses.
    const l = layout('meta-empty-device');
    const meta = metadata({ deviceId: '' });
    writeSceneMetadata(l, meta);
    expect(readSceneMetadata(l)).toEqual(meta);
  });
});
