import { describe, it, expect } from 'vitest';
import { parseRedundantFile } from '../src/analyze/redundant-file';
import { RedundantFileAnalyzer } from '../src/analyze/redundant-file';
import { FrameQuery } from '../src/query/frames';
import { ProcessQuery } from '../src/query/process';
import { CapabilityMatrix } from '../src/device/capability';
import type { AnalyzeContext } from '../src/analyze/types';

/*
 * HapRay's cold-start redundant-file I/O (parity row 21) counts the file reads
 * a launch performs more than once. It reads `htrace/stepN/redundant_file.txt`.
 *
 * The producer of that file is not in HapRay's Python pipeline, so the format
 * is documented here from the analyzer's own contract rather than guessed:
 * one path per line, an optional `USED` / `UNUSED` marker, `#` comments and
 * blank lines ignored. A line the parser cannot read is a typed refusal
 * naming the line number — silently skipping it would undercount.
 */

describe('parseRedundantFile', () => {
  it('reads one path per line with an optional USED/UNUSED marker', () => {
    const report = parseRedundantFile(
      [
        '/data/storage/el2/base/files/config.json USED',
        '/data/storage/el2/base/files/cache.bin UNUSED',
        '/data/storage/el2/base/files/notes.txt',
      ].join('\n'),
    );
    expect(report.reads).toBe(3);
    expect(report.used).toBe(2);
    expect(report.unused).toBe(1);
    expect(report.files.map((f) => f.path)).toContain(
      '/data/storage/el2/base/files/cache.bin',
    );
  });

  it('ignores blank lines and comments', () => {
    const report = parseRedundantFile(
      '\n# a comment\n  \n/data/a USED\n',
    );
    expect(report.reads).toBe(1);
  });

  it('counts a path repeated across lines once, as one redundant file', () => {
    // The file's whole purpose is the redundant reads of one path.
    const report = parseRedundantFile('/data/a USED\n/data/a USED\n/data/b UNUSED\n');
    expect(report.files).toHaveLength(2);
    expect(report.reads).toBe(3);
  });

  it('refuses a line it cannot read, naming the line number', () => {
    // A path is any single token, so the unreadable case is a marker that is
    // neither USED nor UNUSED — or extra columns. Both must refuse.
    expect(() => parseRedundantFile('/data/a USED\n/data/b MAYBE\n')).toThrow(/line 2/);
    expect(() => parseRedundantFile('/data/a USED\n/data/b USED extra\n')).toThrow(/line 2/);
  });
});

describe('RedundantFileAnalyzer', () => {
  const ctx = (text: string | undefined): AnalyzeContext => ({
    frames: new FrameQuery({ path: '', query: () => [], close: () => {} } as never),
    processes: new ProcessQuery({ path: '', query: () => [], close: () => {} } as never),
    app: { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] },
    window: { startNs: 0, endNs: 1 },
    caps: new CapabilityMatrix([]),
    deviceId: 'emu-test',
    ...(text === undefined ? {} : { redundantFile: text }),
  });

  it('is registered under a stable identity', () => {
    expect(new RedundantFileAnalyzer().id).toBe('redundant-file');
  });

  it('emits the three metrics from a parsed report', async () => {
    const result = await new RedundantFileAnalyzer().run(
      ctx('/data/a USED\n/data/b UNUSED\n'),
    );
    const byId = new Map(result.metrics.map((m) => [m.id, m]));
    expect(byId.get('redundant_file.reads.count')!.value).toBe(2);
    expect(byId.get('redundant_file.files.used')!.value).toBe(1);
    expect(byId.get('redundant_file.files.unused')!.value).toBe(1);
  });

  it('reports no_data with a reason when the scene carries no file', async () => {
    // Absence of the file is absence of the data. Reporting 0 redundant reads
    // for a capture that never looked would be the silent zero this package
    // refuses everywhere else.
    const result = await new RedundantFileAnalyzer().run(ctx(undefined));
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.kind).toBe('no_data');
    expect(result.evidence[0]!.explain).toMatch(/redundant_file\.txt/);
  });
});
