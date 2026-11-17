/**
 * Coverage ingestion (HapRay parity row 24).
 *
 * HapRay does not measure coverage. It shells out to `bjc`, which needs an
 * instrumented build (`ohos-test-coverage=true`, `coverage-mode=black`), a
 * debug HAP, an on-device cache, `aa dump` and a matching project source path
 * — and when any of that is missing its analyzer returns `None`, so the
 * section disappears from the report. A reader cannot then tell "coverage was
 * never measured" from "0% of lines ran", which are opposite conclusions.
 *
 * This package does not ship `bjc` and will not pretend to: an instrumented
 * build is a property of how the app was compiled, not something an analysis
 * tool can supply after the fact. What it does instead is read the report
 * `bjc` writes — the very document HapRay's own HTML template renders — and
 * report it as *supplied* data, with the producing tool named in provenance.
 * A scene without one degrades with a reason, so the absence is visible.
 *
 * ## The document
 *
 * The shape is fixed by bjc's report template:
 *
 *     {
 *       "date": "2026-11-17T10:00:00.000Z",
 *       "summary": { "lines":      { "total": 400, "covered": 300, "pct": 75 },
 *                    "functions":  { "total":  40, "covered":  30, "pct": 75 },
 *                    "branches":   { "total":  80, "covered":  40, "pct": 50 } },
 *       "files": [ { "path": "entry/src/main/ets/pages/Index.ets",
 *                    "summary": { … same three … } } ]
 *     }
 *
 * The `pct` fields are recomputed rather than trusted: keeping the producer's
 * rounding would make this report a function of a tool this package does not
 * control, and a `total` of zero has to be 0% rather than `NaN`.
 */

import { OhosPerfError } from '../errors';
import { evidence } from '../report/evidence';
import { metric, type Metric } from '../report/metric';
import type { AnalyzeContext, AnalyzeResult, Analyzer } from './types';

/** One of the three things bjc counts: `covered / total`. */
export interface CoverageCounts {
  readonly covered: number;
  readonly total: number;
}

/** The same counts, plus the percentage this module computes from them. */
export interface CoverageRatio extends CoverageCounts {
  /** `covered / total * 100`, rounded to two decimals; 0 when `total` is 0. */
  readonly percent: number;
}

/** One file's three ratios. */
export interface CoverageFile {
  readonly path: string;
  readonly lines: CoverageRatio;
  readonly functions: CoverageRatio;
  readonly branches: CoverageRatio;
}

/** A parsed `coverageReport.json`. */
export interface CoverageReport {
  /** The producer's timestamp, verbatim; empty when the document had none. */
  readonly date: string;
  readonly summary: {
    readonly lines: CoverageRatio;
    readonly functions: CoverageRatio;
    readonly branches: CoverageRatio;
  };
  /** Per-file ratios, sorted by path so the document is byte-stable. */
  readonly files: readonly CoverageFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Two decimals, half away from zero, as a plain number. */
function percentOf(counts: CoverageCounts): number {
  if (counts.total === 0) return 0;
  return Math.round((counts.covered / counts.total) * 10_000) / 100;
}

/**
 * Read one `{ total, covered }` block.
 *
 * A count that is not a non-negative integer is a refusal naming the section,
 * and so is `covered > total`: a report claiming 120% of lines ran is either a
 * producer bug or a hand-edited file, and passing it through would put a number
 * in the report that cannot be true.
 */
function readCounts(value: unknown, section: string): CoverageCounts {
  if (!isRecord(value)) {
    throw new OhosPerfError(
      `coverageReport.json: ${section} is missing or not an object`,
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }
  const total = value['total'];
  const covered = value['covered'];
  for (const [name, count] of [['total', total], ['covered', covered]] as const) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new OhosPerfError(
        `coverageReport.json: ${section}.${name} must be a non-negative integer` +
          ` (got ${JSON.stringify(count)})`,
        { code: 'SCENARIO_BAD_INPUT' },
      );
    }
  }
  if ((covered as number) > (total as number)) {
    throw new OhosPerfError(
      `coverageReport.json: ${section}.covered (${String(covered)}) exceeds` +
        ` ${section}.total (${String(total)}); a report cannot cover more than exists`,
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }
  return { covered: covered as number, total: total as number };
}

/** The three ratios a `summary` block carries. */
function readSummary(value: unknown, section: string): CoverageReport['summary'] {
  if (!isRecord(value)) {
    throw new OhosPerfError(
      `coverageReport.json: ${section} is missing or not an object`,
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }
  const ratio = (name: string): CoverageRatio => {
    const counts = readCounts(value[name], `${section}.${name}`);
    return { ...counts, percent: percentOf(counts) };
  };
  return { lines: ratio('lines'), functions: ratio('functions'), branches: ratio('branches') };
}

/**
 * Parse a `coverageReport.json`.
 *
 * Malformed JSON is a refusal that says so, not a `SyntaxError` from
 * `JSON.parse` surfacing through the CLI as an internal error.
 */
export function parseCoverageReport(text: string): CoverageReport {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    throw new OhosPerfError(
      `coverageReport.json is not valid JSON: ${(err as Error).message}`,
      { code: 'SCENARIO_BAD_INPUT', cause: err },
    );
  }
  if (!isRecord(document) || !('summary' in document) || !('files' in document)) {
    throw new OhosPerfError(
      'coverageReport.json is not a coverage report: it has no "summary" and "files"',
      { code: 'SCENARIO_BAD_INPUT' },
    );
  }

  const summary = readSummary(document['summary'], 'summary');
  const filesRaw = document['files'];
  if (!Array.isArray(filesRaw)) {
    throw new OhosPerfError('coverageReport.json: "files" is not an array', {
      code: 'SCENARIO_BAD_INPUT',
    });
  }
  const files: CoverageFile[] = filesRaw.map((entry, index) => {
    if (!isRecord(entry) || typeof entry['path'] !== 'string') {
      throw new OhosPerfError(
        `coverageReport.json: files[${index}] has no string "path"`,
        { code: 'SCENARIO_BAD_INPUT' },
      );
    }
    const fileSummary = readSummary(entry['summary'], `files[${index}].summary`);
    return {
      path: entry['path'],
      lines: fileSummary.lines,
      functions: fileSummary.functions,
      branches: fileSummary.branches,
    };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    date: typeof document['date'] === 'string' ? document['date'] : '',
    summary,
    files,
  };
}

/**
 * The analyzer.
 *
 * No capability is required: the report is a scene file, and the scene either
 * carried one or did not. The fidelity is `approximate` — the numbers are exact
 * about the instrumented build and say nothing about the app as shipped, so a
 * consumer that read them as a property of the release would be making a claim
 * this package cannot support. The collector names the file they came from.
 */
export class CoverageAnalyzer implements Analyzer {
  readonly id = 'coverage';
  readonly requires = [];

  async run(ctx: AnalyzeContext): Promise<AnalyzeResult> {
    const text = ctx.coverage;
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
              'the scene carries no coverageReport.json; coverage was not measured.' +
              ' An instrumented build (ohos-test-coverage=true) plus the bjc toolchain' +
              ' produces one, and this analyzer reads it rather than running bjc',
            drillDown: [],
            key: 'coverage:no-report',
          }),
        ],
      };
    }

    const report = parseCoverageReport(text);
    // `approximate`, not `exact`: the counts are exact about the instrumented
    // build, and the build is not the app a user runs. Calling them exact
    // would carry a measurement of one artefact into a claim about another.
    const make = (id: string, value: number, unit: Metric['unit']): Metric =>
      metric({
        id,
        value,
        unit,
        fidelity: 'approximate',
        provenance: {
          collector: 'scene:coverageReport.json',
          table: 'coverage',
          rows: report.files.length,
          device: ctx.deviceId,
        },
      });

    const metrics: Metric[] = [
      make('coverage.lines.percent', report.summary.lines.percent, '%'),
      make('coverage.lines.covered', report.summary.lines.covered, 'count'),
      make('coverage.lines.total', report.summary.lines.total, 'count'),
      make('coverage.functions.percent', report.summary.functions.percent, '%'),
      make('coverage.branches.percent', report.summary.branches.percent, '%'),
      make('coverage.files.count', report.files.length, 'count'),
    ];

    // The least-covered file is the actionable one. Listing every file would
    // turn the evidence list into a second copy of the report; naming the worst
    // answers the question a reader asks first. Ties break on path so the
    // choice is deterministic.
    const worst = report.files.reduce<CoverageFile | undefined>((low, file) => {
      if (low === undefined) return file;
      if (file.lines.percent !== low.lines.percent) {
        return file.lines.percent < low.lines.percent ? file : low;
      }
      return file.path < low.path ? file : low;
    }, undefined);

    const items = [];
    if (worst !== undefined) {
      items.push(
        evidence({
          kind: 'coverage',
          severity: worst.lines.percent < 50 ? 'warn' : 'info',
          subject: { process: ctx.app.packageName },
          window: ctx.window,
          signals: {
            path: worst.path,
            linesPercent: worst.lines.percent,
            linesCovered: worst.lines.covered,
            linesTotal: worst.lines.total,
            functionsPercent: worst.functions.percent,
            branchesPercent: worst.branches.percent,
          },
          explain:
            `${worst.path} is the least-covered file at ${worst.lines.percent}% of lines` +
            ` (${worst.lines.covered}/${worst.lines.total})`,
          drillDown: [],
          key: worst.path,
        }),
      );
    }

    return { metrics, evidence: items };
  }
}
