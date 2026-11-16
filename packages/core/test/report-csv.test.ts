import { describe, it, expect } from 'vitest';
import type { AnalyzerSection } from '../src/analyze/engine';
import { renderEvidenceCsv, renderMetricsCsv } from '../src/report/csv';
import { evidence } from '../src/report/evidence';
import { metric } from '../src/report/metric';
import { buildReport, type ReportModel } from '../src/report/model';

const app = { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] };

function model(sections: AnalyzerSection[]): ReportModel {
  return buildReport({
    generator: { name: '@ohos-perf/core', version: '0.4.0' },
    app,
    device: 'emu',
    window: { startNs: 1000, endNs: 2000 },
    sections,
  });
}

const jank = evidence({
  kind: 'jank',
  severity: 'warn',
  subject: { process: 'com.demo' },
  window: { startNs: 1000, endNs: 1010 },
  signals: { b: 2, a: 'x' },
  explain: 'janky',
  drillDown: [],
});

describe('renderMetricsCsv', () => {
  it('writes the exact header and one row per metric in model order', () => {
    const csv = renderMetricsCsv(
      model([
        {
          analyzerId: 'frames',
          status: 'measured',
          result: {
            metrics: [
              metric({
                id: 'a.metric',
                value: 1,
                unit: 'count',
                fidelity: 'exact',
                provenance: { collector: 'test', device: 'd' },
              }),
              metric({
                id: 'x.degraded',
                value: 0,
                unit: 'count',
                fidelity: 'proxy',
                degraded: { reason: 'missing perf.pmu', fallback: 'skipped' },
                provenance: { collector: 'capability-matrix', device: 'd' },
              }),
            ],
            evidence: [],
          },
        },
      ]),
    );

    expect(csv).toBe(
      'section,id,value,unit,fidelity,degraded_reason,window_start_ns,window_end_ns,collector,table,rows,device\n' +
      'frames,a.metric,1,count,exact,,,,test,,,d\n' +
      'frames,x.degraded,0,count,proxy,missing perf.pmu,,,capability-matrix,,,d\n',
    );
  });

  it('quotes a reason containing a comma and a quote', () => {
    const csv = renderMetricsCsv(
      model([
        {
          analyzerId: 'frames',
          status: 'measured',
          result: {
            metrics: [
              metric({
                id: 'a.metric',
                value: 1,
                fidelity: 'proxy',
                degraded: { reason: 'a,"b"', fallback: 'x' },
                provenance: { collector: 'c', device: 'd' },
              }),
            ],
            evidence: [],
          },
        },
      ]),
    );
    expect(csv.split('\n')[1]).toContain(',proxy,"a,""b""",');
  });
});

describe('renderEvidenceCsv', () => {
  it('writes the exact header, sorts signals and quotes the JSON cell', () => {
    const csv = renderEvidenceCsv(
      model([
        { analyzerId: 'frames', status: 'measured', result: { metrics: [], evidence: [jank] } },
      ]),
    );

    expect(csv).toBe(
      'section,id,kind,severity,process,thread,frame_no,pid,window_start_ns,window_end_ns,explain,signals\n' +
      `frames,${jank.id},jank,warn,com.demo,,,,1000,1010,janky,"{""a"":""x"",""b"":2}"\n`,
    );
  });

  it('uses \\n endings and is deterministic', () => {
    const m = model([
      { analyzerId: 'frames', status: 'measured', result: { metrics: [], evidence: [jank] } },
    ]);
    const first = renderEvidenceCsv(m);
    expect(first).not.toContain('\r');
    expect(renderEvidenceCsv(m)).toBe(first);
  });
});
