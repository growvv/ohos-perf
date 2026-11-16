import { describe, it, expect } from 'vitest';
import type { AnalyzerSection } from '../src/analyze/engine';
import type { BaselineComparison } from '../src/report/compare';
import { compareResults } from '../src/report/compare';
import { evidence, type Evidence } from '../src/report/evidence';
import { metric, type Metric } from '../src/report/metric';
import {
  SECTION_TITLES,
  buildReport,
  renderReportJson,
  renderSummaryJson,
  summarizeReport,
} from '../src/report/model';

const m = (id: string, value = 1): Metric =>
  metric({
    id,
    value,
    unit: 'count',
    fidelity: 'exact',
    provenance: { collector: 'test', device: 'd' },
  });

function ev(kind: Evidence['kind'], startNs: number, explain = 'x'): Evidence {
  return evidence({
    kind,
    severity: kind === 'jank' ? 'warn' : 'info',
    subject: { process: 'com.demo' },
    window: { startNs, endNs: startNs + 10 },
    signals: {},
    explain,
    drillDown: [],
  });
}

function section(
  analyzerId: string,
  status: AnalyzerSection['status'],
  metrics: Metric[],
  items: Evidence[],
): AnalyzerSection {
  return { analyzerId, status, result: { metrics, evidence: items } };
}

const app = { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] };
const generator = { name: '@ohos-perf/core', version: '0.4.0' };

function report(sections: AnalyzerSection[], comparison?: BaselineComparison) {
  return buildReport({
    generator,
    app,
    device: 'emu',
    window: { startNs: 1000, endNs: 2000 },
    sections,
    ...(comparison === undefined ? {} : { comparison }),
  });
}

describe('buildReport', () => {
  it('groups metrics and evidence by analyzer and sorts each section deterministically', () => {
    const model = report([
      section('threads', 'measured', [m('z.metric', 2), m('a.metric', 1)], [
        ev('jank', 1500),
        ev('no_data', 1200),
      ]),
      section('frames', 'measured', [m('frame.fps', 60)], []),
    ]);

    expect(model.sections.map((s) => s.id)).toEqual(['frames', 'threads']);
    expect(model.sections[1]?.metrics.map((x) => x.id)).toEqual(['a.metric', 'z.metric']);
    expect(model.sections[1]?.evidence.map((x) => x.kind)).toEqual(['jank', 'no_data']);
    expect(model.totals).toEqual({
      metrics: 3,
      evidence: 2,
      bySeverity: { info: 1, warn: 1, critical: 0 },
      measured: 2,
      degraded: 0,
    });
  });

  it('titles known analyzers and falls back to the id', () => {
    const model = report([
      section('frames', 'measured', [], []),
      section('mystery', 'measured', [], []),
    ]);
    expect(model.sections.map((s) => s.title)).toEqual(['Frames', 'mystery']);
    expect(SECTION_TITLES.frames).toBe('Frames');
  });

  it('keeps a degraded section labelled with the engine reason', () => {
    const model = report([
      section('threads', 'degraded', [m('threads.degraded', 0)], [
        ev('degraded_capability', 1000, 'threads skipped: missing perf.pmu: no PMU'),
      ]),
      section('frames', 'measured', [m('frame.fps', 60)], []),
    ]);

    const threads = model.sections.find((section) => section.id === 'threads');
    expect(threads?.status).toBe('degraded');
    expect(threads?.degradedReason).toBe('threads skipped: missing perf.pmu: no PMU');
    expect(model.totals.degraded).toBe(1);
    expect(model.totals.measured).toBe(1);
  });

  it('passes the comparison through and copies the scenario inputs', () => {
    const comparison = compareResults(
      { metrics: [m('frame.jank.rate', 3)], evidence: [] },
      { metrics: [m('frame.jank.rate', 2)], evidence: [] },
    );
    const model = report([section('frames', 'measured', [m('frame.jank.rate', 2)], [])], comparison);

    expect(model.comparison).toBe(comparison);
    expect(model.scenario.app.packageName).toBe('com.demo');
    expect(model.scenario.device).toBe('emu');
    expect(model.scenario.window).toEqual({ startNs: 1000, endNs: 2000 });
    expect('startedAtNs' in model.scenario).toBe(false);
  });

  it('renders byte-stable JSON without host paths', () => {
    const model = report([section('frames', 'measured', [m('a.metric', 1)], [])]);
    const json = renderReportJson(model);
    expect(json).toBe(JSON.stringify(model, null, 2) + '\n');
    expect(renderReportJson(model)).toBe(json);
    expect(json).not.toContain('E:\\');
    expect(json).not.toContain('/abs/');
    expect(JSON.parse(json)).toEqual(model);
  });
});

describe('summarizeReport', () => {
  it('rolls up each section and carries the comparison totals', () => {
    const comparison = compareResults(
      { metrics: [m('frame.jank.rate', 3)], evidence: [] },
      { metrics: [m('frame.jank.rate', 2)], evidence: [] },
    );
    const model = report(
      [
        section('frames', 'measured', [m('frame.jank.rate', 2)], [ev('jank', 1000)]),
        section('threads', 'degraded', [m('threads.degraded', 0)], [
          ev('degraded_capability', 1000, 'threads skipped: missing perf.pmu'),
        ]),
      ],
      comparison,
    );
    const summary = summarizeReport(model);

    expect(summary.sections).toEqual([
      { id: 'frames', title: 'Frames', status: 'measured', metrics: 1, evidence: 1 },
      {
        id: 'threads',
        title: 'Threads',
        status: 'degraded',
        degradedReason: 'threads skipped: missing perf.pmu',
        metrics: 1,
        evidence: 1,
      },
    ]);
    expect(summary.comparison).toEqual(comparison.totals);
    expect(renderSummaryJson(summary)).toBe(JSON.stringify(summary, null, 2) + '\n');
  });
});
