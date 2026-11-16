import { describe, it, expect } from 'vitest';
import type { NamedQueryInfo } from '@ohos-perf/core';
import type { CliDeps } from '../src/commands';
import { runQuery, runTools } from '../src/commands';
import { parseLimit, parseQueryArgs } from '../src/query';

/** A complete deps object; only `query` and `tools` matter to these tests. */
function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' } }),
    query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false }),
    tools: () => [],
    ...overrides,
  };
}

describe('parseQueryArgs', () => {
  it('parses a JSON object', () => {
    expect(parseQueryArgs('{"id":2}')).toEqual({ id: 2 });
  });

  it('rejects non-objects and invalid JSON', () => {
    for (const raw of ['[]', 'null', '1', '"x"', '{bad']) {
      expect(() => parseQueryArgs(raw)).toThrowError(/invalid --args/);
    }
  });
});

describe('parseLimit', () => {
  it('parses a valid limit', () => {
    expect(parseLimit('20')).toBe(20);
  });

  it('rejects 0, negatives, fractions and values above the max', () => {
    for (const raw of ['0', '-1', '1.5', '1001', 'abc']) {
      expect(() => parseLimit(raw)).toThrowError(/between 1 and 1000/);
    }
  });

  it('names the offending --limit value', () => {
    expect(() => parseLimit('abc')).toThrowError(/got "abc"/);
    expect(() => parseLimit('0')).toThrowError(/got "0"/);
  });
});

describe('runQuery', () => {
  it('prints the API structure with --json', async () => {
    const result = { query: 'frames.all', rows: [{ id: 1 }], total: 3, truncated: true };
    const r = await runQuery(deps({ query: async () => result }),
      { sceneDir: 'scene1', name: 'frames.all' }, { json: true });
    expect(r).toEqual({ stdout: JSON.stringify(result, null, 2) + '\n', stderr: '', exitCode: 0 });
  });

  it('prints a summary line and one compact JSON row per line', async () => {
    const r = await runQuery(
      deps({
        query: async () => ({
          query: 'frames.all', rows: [{ id: 1 }, { id: 2 }], total: 5, truncated: true,
        }),
      }),
      { sceneDir: 'scene1', name: 'frames.all' }, {});
    expect(r.stdout).toBe('frames.all  2/5 rows (truncated)\n{"id":1}\n{"id":2}\n');
  });

  it('maps any failure to exit 1 with empty stdout', async () => {
    const r = await runQuery(
      deps({ query: async () => { throw new Error('boom'); } }),
      { sceneDir: 'scene1', name: 'frames.all' }, { json: true });
    expect(r).toEqual({ stdout: '', stderr: 'boom\n', exitCode: 1 });
  });
});

describe('runTools', () => {
  const info: NamedQueryInfo[] = [{
    name: 'frames.get',
    description: 'One frame by id.',
    args: [{ name: 'id', type: 'number', required: true, description: 'frame row id' }],
    returns: 'Frame',
  }];

  it('prints the definitions as JSON', () => {
    const r = runTools(deps({ tools: () => info }), { json: true });
    expect(JSON.parse(r.stdout)).toEqual(info);
  });

  it('prints one line per tool with required/optional argument names', () => {
    const r = runTools(deps({ tools: () => info }), {});
    expect(r.stdout).toBe('frames.get(id)  -> Frame\n  One frame by id.\n');
  });
});
