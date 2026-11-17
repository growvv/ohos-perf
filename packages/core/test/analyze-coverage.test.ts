import { describe, it, expect } from 'vitest';
import {
  CoverageAnalyzer,
  parseCoverageReport,
} from '../src/analyze/coverage';
import { defaultAnalyzers } from '../src/analyze/engine';
import { CapabilityMatrix } from '../src/device/capability';
import type { AnalyzeContext } from '../src/analyze/types';
import type { FrameQuery } from '../src/query/frames';
import type { ProcessQuery } from '../src/query/process';

/*
 * Coverage ingestion (HapRay parity row 24).
 *
 * HapRay delegates to the external `bjc` toolchain: an instrumented build
 * (`ohos-test-coverage=true`, `coverage-mode=black`), a debug HAP, an on-device
 * cache, `aa dump`, and a matching project source path. When any of that is
 * missing its analyzer returns `None` and the section is *silently* skipped —
 * so "coverage was not measured" and "0% of lines ran" are the same absence in
 * the report.
 *
 * This port does not ship `bjc`. It reads the report `bjc` produces — the same
 * `coverageReport.json` HapRay's own HTML template consumes, whose shape is
 * `{ date, files: [{ path, summary }], summary }` with `lines`, `functions` and
 * `branches` counts — and labels every number `supplied`: the tool that ran the
 * build measured them, not this package. A scene with no report degrades with a
 * reason, which is the difference HapRay cannot make.
 */

const report = {
  date: '2026-11-17T10:00:00.000Z',
  summary: {
    lines: { total: 400, covered: 300, pct: 75 },
    functions: { total: 40, covered: 30, pct: 75 },
    branches: { total: 80, covered: 40, pct: 50 },
  },
  // The least-covered file sorts last, so a reader that kept the first
  // candidate instead of comparing would name `a-Index`. The names are chosen
  // for that, not for realism.
  files: [
    {
      path: 'entry/src/main/ets/pages/a-Index.ets',
      summary: {
        lines: { total: 300, covered: 240, pct: 80 },
        functions: { total: 30, covered: 24, pct: 80 },
        branches: { total: 60, covered: 30, pct: 50 },
      },
    },
    {
      path: 'entry/src/main/ets/pages/z-Detail.ets',
      summary: {
        lines: { total: 100, covered: 60, pct: 60 },
        functions: { total: 10, covered: 6, pct: 60 },
        branches: { total: 20, covered: 10, pct: 50 },
      },
    },
  ],
};

describe('parseCoverageReport', () => {
  it('reads the summary bjc writes, keeping covered and total', () => {
    const parsed = parseCoverageReport(JSON.stringify(report));
    expect(parsed.summary.lines).toEqual({ covered: 300, total: 400, percent: 75 });
    expect(parsed.summary.functions).toEqual({ covered: 30, total: 40, percent: 75 });
    expect(parsed.summary.branches).toEqual({ covered: 40, total: 80, percent: 50 });
    expect(parsed.date).toBe('2026-11-17T10:00:00.000Z');
  });

  it('keeps per-file counts sorted by path', () => {
    const parsed = parseCoverageReport(JSON.stringify(report));
    expect(parsed.files.map((file) => file.path)).toEqual([
      'entry/src/main/ets/pages/a-Index.ets',
      'entry/src/main/ets/pages/z-Detail.ets',
    ]);
  });

  it('recomputes the percentage rather than trusting the file', () => {
    // bjc writes a `pct` beside every count. Keeping it would make the report
    // depend on how the producer rounded; 1/3 is 33.33 either way, and a
    // denominator of zero is 0 rather than NaN.
    const parsed = parseCoverageReport(
      JSON.stringify({
        date: 'x',
        summary: {
          lines: { total: 3, covered: 1, pct: 99 },
          functions: { total: 0, covered: 0, pct: 0 },
          branches: { total: 0, covered: 0, pct: 0 },
        },
        files: [],
      }),
    );
    expect(parsed.summary.lines.percent).toBe(33.33);
    expect(parsed.summary.functions.percent).toBe(0);
  });

  it('refuses a report whose covered count exceeds its total', () => {
    // A producer bug or a hand-edited file; reporting 120% would be worse than
    // refusing, and the message names the section.
    expect(() =>
      parseCoverageReport(
        JSON.stringify({
          date: 'x',
          summary: {
            lines: { total: 10, covered: 12, pct: 120 },
            functions: { total: 0, covered: 0, pct: 0 },
            branches: { total: 0, covered: 0, pct: 0 },
          },
          files: [],
        }),
      ),
    ).toThrow(/lines/);
  });

  it('refuses a document that is not a coverage report', () => {
    expect(() => parseCoverageReport('{"hello":1}')).toThrow(/coverage/i);
  });

  it('refuses malformed JSON with the parse position, not a stack trace', () => {
    expect(() => parseCoverageReport('{not json')).toThrow(/coverage/i);
  });
});

/** The minimum a context needs for an analyzer that reads one scene file. */
function context(overrides: Partial<AnalyzeContext> = {}): AnalyzeContext {
  const unused = (): never => {
    throw new Error('not used by this analyzer');
  };
  return {
    frames: {} as FrameQuery,
    processes: {} as ProcessQuery,
    app: { packageName: 'com.demo', processName: 'com.demo', pids: [1] },
    window: { startNs: 0, endNs: 1 },
    caps: new CapabilityMatrix([]),
    deviceId: 'emu-1',
    ...overrides,
  } as unknown as AnalyzeContext;
}

describe('CoverageAnalyzer', () => {
  it('reports line, function and branch coverage as supplied data', async () => {
    const result = await new CoverageAnalyzer().run(
      context({ coverage: JSON.stringify(report) }),
    );
    const byId = new Map(result.metrics.map((m) => [m.id, m]));
    expect(byId.get('coverage.lines.percent')!.value).toBe(75);
    expect(byId.get('coverage.lines.covered')!.value).toBe(300);
    expect(byId.get('coverage.lines.total')!.value).toBe(400);
    expect(byId.get('coverage.functions.percent')!.value).toBe(75);
    expect(byId.get('coverage.branches.percent')!.value).toBe(50);
    expect(byId.get('coverage.files.count')!.value).toBe(2);
  });

  it('marks every metric approximate and names the file it came from', async () => {
    // The instrumented build measured these numbers, not this package, and the
    // build is not the app a user runs. `exact` would carry a measurement of
    // one artefact into a claim about another.
    const result = await new CoverageAnalyzer().run(
      context({ coverage: JSON.stringify(report) }),
    );
    for (const metric of result.metrics) {
      expect(metric.fidelity).toBe('approximate');
      expect(metric.provenance.collector).toBe('scene:coverageReport.json');
    }
    expect(result.evidence.some((item) => item.kind === 'coverage')).toBe(true);
  });

  it('names the least-covered file rather than listing them all', async () => {
    const result = await new CoverageAnalyzer().run(
      context({ coverage: JSON.stringify(report) }),
    );
    const worst = result.evidence.find((item) => item.kind === 'coverage');
    expect(worst?.explain).toContain('z-Detail.ets');
    expect(worst?.signals).toMatchObject({ linesPercent: 60 });
  });

  it('degrades with a reason when the scene carries no report', async () => {
    // HapRay returns None here and the section vanishes. The difference between
    // "not measured" and "0% covered" is the whole point of this row.
    const result = await new CoverageAnalyzer().run(context());
    expect(result.metrics).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.kind).toBe('no_data');
    expect(result.evidence[0]!.explain).toMatch(/no coverageReport\.json/);
  });

  it('is registered with the default analyzers', () => {
    expect(defaultAnalyzers().map((a) => a.constructor.name)).toContain('CoverageAnalyzer');
  });
});
