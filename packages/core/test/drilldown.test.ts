import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { CapabilityMatrix } from '../src/device/capability';
import { OhosPerfError } from '../src/errors';
import {
  queryDefinitions, runDrillDown, type QueryContext,
} from '../src/query/registry';

const here = dirname(fileURLToPath(import.meta.url));

let dir: string;
let db: QueryHandle;
let ctx: QueryContext;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-drilldown-'));
  const path = join(dir, 't.db');
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  raw.exec(`INSERT INTO frame_slice VALUES
    (7, 100, 0, 17, 44, 0, 10, '', 0, 0, 'actual', 1, 0, 7)`);
  raw.close();
  db = openDb(path);
  ctx = {
    db,
    app: { packageName: 'com.demo', pids: [], processNames: ['com.demo'] },
    caps: new CapabilityMatrix([]),
  };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runDrillDown', () => {
  it('resolves a frames.get handle into its frame row', () => {
    const r = runDrillDown(ctx, {
      label: 'Frame detail', tool: 'frames.get', args: { id: 7 }, returns: 'Frame',
    });
    expect(r.query).toBe('frames.get');
    expect(r.rows).toEqual([expect.objectContaining({ id: 7 })]);
  });

  it('forwards the limit and rejects an unknown tool by name', () => {
    expect(runDrillDown(ctx, {
      label: 'x', tool: 'frames.get', args: { id: 7 }, returns: 'Frame',
    }, { limit: 1 }).rows).toHaveLength(1);

    try {
      runDrillDown(ctx, {
        label: 'x', tool: 'frames.nope', args: {}, returns: 'Frame[]',
      });
      expect.unreachable();
    } catch (err) {
      expect((err as OhosPerfError).code).toBe('QUERY_UNKNOWN');
      expect((err as OhosPerfError).message).toContain('available:');
    }
  });
});

describe('analyzer drill-down coverage', () => {
  it('registers every tool literal emitted by an analyzer', () => {
    const analyzeDir = join(here, '../src/analyze');
    const tools = new Set<string>();
    for (const file of readdirSync(analyzeDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(analyzeDir, file), 'utf8');
      for (const match of text.matchAll(/tool:\s*'([^']+)'/g)) tools.add(match[1]);
    }
    expect(tools.size).toBeGreaterThan(0);
    const registered = queryDefinitions().map((d) => d.name);
    expect([...tools].filter((tool) => !registered.includes(tool))).toEqual([]);
  });
});
