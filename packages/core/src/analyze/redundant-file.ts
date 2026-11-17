/**
 * Cold-start redundant-file I/O (HapRay parity row 21).
 *
 * HapRay counts the file reads a launch performs more than once, from
 * `htrace/stepN/redundant_file.txt`. The file's producer is not part of
 * HapRay's Python pipeline, so this module defines the contract explicitly
 * rather than guessing at an undocumented format:
 *
 *     # comment
 *     /data/storage/el2/base/files/config.json USED
 *     /data/storage/el2/base/files/cache.bin UNUSED
 *     /data/storage/el2/base/files/notes.txt
 *
 * One path per line, an optional `USED` / `UNUSED` marker, `#` comments and
 * blank lines ignored. A path with no marker is counted as used — a read that
 * happened — because the alternative is to silently drop it.
 *
 * `reads` counts every line; `files` counts distinct paths. A path read three
 * times is one file and three reads, which is the distinction the capability
 * exists to make.
 */

import { OhosPerfError } from '../errors';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** One path in a redundant-file report, with the reads it accounted for. */
export interface RedundantFileEntry {
  readonly path: string;
  readonly reads: number;
  readonly used: boolean;
}

/** A parsed `redundant_file.txt`. */
export interface RedundantFileReport {
  /** Every line with a path; a repeated path contributes each time. */
  readonly reads: number;
  /** Distinct paths. */
  readonly files: readonly RedundantFileEntry[];
  readonly used: number;
  readonly unused: number;
}

/**
 * Parse a `redundant_file.txt`.
 *
 * A line that is neither blank, a comment, nor `<path> [USED|UNUSED]` is a
 * refusal naming its line number. Skipping it would undercount the very thing
 * the capability reports, and a report that silently drops input is worse than
 * no report.
 */
export function parseRedundantFile(text: string): RedundantFileReport {
  const byPath = new Map<string, { reads: number; used: boolean }>();
  let reads = 0;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const path = parts[0]!;
    const marker = parts[1];
    if (parts.length > 2 || (marker !== undefined && marker !== 'USED' && marker !== 'UNUSED')) {
      throw new OhosPerfError(
        `redundant_file.txt line ${index + 1}: expected "<path> [USED|UNUSED]",` +
          ` got ${JSON.stringify(line)}`,
        { code: 'SCENARIO_BAD_INPUT' },
      );
    }

    reads += 1;
    const used = marker !== 'UNUSED';
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, { reads: 1, used });
    } else {
      existing.reads += 1;
      // One USED observation makes the file used: the marker describes a read,
      // and a path read both ways was used.
      existing.used = existing.used || used;
    }
  }

  const files = [...byPath.entries()]
    .map(([path, value]) => ({ path, reads: value.reads, used: value.used }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    reads,
    files,
    used: files.filter((file) => file.used).length,
    unused: files.filter((file) => !file.used).length,
  };
}

/**
 * The analyzer.
 *
 * No capability is required: the report is a scene file, so it is available
 * wherever the capture produced one. Absence of the file is `no_data` with a
 * reason, never three zeros.
 */
export class RedundantFileAnalyzer implements Analyzer {
  readonly id = 'redundant-file';
  readonly requires = [];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const text = ctx.redundantFile;
    if (text === undefined) {
      return {
        metrics: [],
        evidence: [
          evidence({
            kind: 'no_data',
            severity: 'info',
            subject: { process: ctx.app.packageName },
            window: ctx.window,
            signals: {},
            explain:
              'the scene carries no redundant_file.txt; cold-start redundant-file I/O was not measured',
            drillDown: [],
            key: 'redundant-file:no-file',
          }),
        ],
      };
    }

    const report = parseRedundantFile(text);
    const make = (id: string, value: number): Metric =>
      metric({
        id,
        value,
        unit: 'count',
        fidelity: 'exact',
        provenance: {
          collector: 'scene:redundant_file.txt',
          table: 'redundant_file',
          rows: report.reads,
          device: ctx.deviceId,
        },
      });

    return {
      metrics: [
        make('redundant_file.reads.count', report.reads),
        make('redundant_file.files.used', report.used),
        make('redundant_file.files.unused', report.unused),
      ],
      evidence: report.files
        .filter((file) => !file.used)
        .slice(0, 10)
        .map((file) =>
          evidence({
            kind: 'redundant_file',
            severity: 'info',
            subject: { process: ctx.app.packageName },
            window: ctx.window,
            signals: { path: file.path, reads: file.reads },
            explain: `${file.path}: read ${file.reads} time(s), never used`,
            drillDown: [],
            key: file.path,
          }),
        ),
    };
  }
}
