import { describe, it, expect } from 'vitest';
import type { AnalyzerSection } from '../src/analyze/engine';
import { compareResults } from '../src/report/compare';
import { evidence } from '../src/report/evidence';
import { metric } from '../src/report/metric';
import { buildReport, type ReportModel } from '../src/report/model';
import { renderReportXlsx } from '../src/report/xlsx';
import { entryText, readStoredZip } from './helpers/zip';

const app = { packageName: 'com.demo', pids: [1], processNames: ['com.demo'] };

function build(sections: AnalyzerSection[], comparison?: ReturnType<typeof compareResults>): ReportModel {
  return buildReport({
    generator: { name: '@ohos-perf/core', version: '0.4.0' },
    app,
    device: 'emu',
    window: { startNs: 1000, endNs: 2000 },
    sections,
    ...(comparison === undefined ? {} : { comparison }),
  });
}

const metricOf = (id: string, value: number) =>
  metric({
    id,
    value,
    unit: 'count',
    fidelity: 'exact',
    provenance: { collector: 'test', device: 'emu' },
  });

const frames = (metrics = [metricOf('frame.fps', 42)]): AnalyzerSection => ({
  analyzerId: 'frames',
  status: 'measured',
  result: { metrics, evidence: [] },
});

const PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
  'xl/worksheets/sheet3.xml',
];

describe('renderReportXlsx', () => {
  it('emits a stored ZIP with the fixed workbook parts', () => {
    const bytes = renderReportXlsx(build([frames()]));
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = readStoredZip(bytes);
    expect([...entries.keys()]).toEqual(PARTS);
    expect(entryText(entries, 'xl/worksheets/sheet2.xml')).toContain('frame.fps');
  });

  it('adds the Compare sheet only when a comparison exists', () => {
    const comparison = compareResults(
      { metrics: [metricOf('frame.fps', 30)], evidence: [] },
      { metrics: [metricOf('frame.fps', 42)], evidence: [] },
    );
    const without = readStoredZip(renderReportXlsx(build([frames()])));
    expect(entryText(without, 'xl/workbook.xml')).not.toContain('Compare');

    const withCompare = readStoredZip(renderReportXlsx(build([frames()], comparison)));
    expect([...withCompare.keys()]).toHaveLength(PARTS.length + 1);
    expect(entryText(withCompare, 'xl/workbook.xml')).toContain('name="Compare"');
    expect(entryText(withCompare, 'xl/worksheets/sheet4.xml')).toContain('improved');
  });

  it('is byte-identical across renders', () => {
    const model = build([frames()]);
    expect(renderReportXlsx(model)).toEqual(renderReportXlsx(model));
  });

  it('writes numbers as numeric cells and text as inline strings', () => {
    const sheet = entryText(
      readStoredZip(renderReportXlsx(build([frames()]))),
      'xl/worksheets/sheet2.xml',
    );
    expect(sheet).toContain('<v>42</v>');
    expect(sheet).toContain('<t>frame.fps</t>');
  });

  it('XML-escapes text cells', () => {
    const sheet = entryText(
      readStoredZip(renderReportXlsx(build([frames([metricOf('a<b&c', 1)])]))) ,
      'xl/worksheets/sheet2.xml',
    );
    expect(sheet).toContain('a&lt;b&amp;c');
    expect(sheet).not.toContain('<t>a<b&c</t>');
  });

  it('detects a corrupted CRC', () => {
    const bytes = renderReportXlsx(build([frames()]));
    const copy = Uint8Array.from(bytes);
    copy[14] ^= 0xff; // first local header's CRC field
    expect(() => readStoredZip(copy)).toThrow(/CRC/);
  });

  it('detects a corrupted central directory', () => {
    const bytes = renderReportXlsx(build([frames()]));
    const copy = Uint8Array.from(bytes);
    const view = new DataView(copy.buffer);
    const eocd = copy.length - 22;
    const cdOffset = view.getUint32(eocd + 16, true);
    view.setUint32(eocd + 16, cdOffset + 1, true);
    expect(() => readStoredZip(copy)).toThrow();
  });

  it('renders sheets larger than the engine argument limit', () => {
    // A janky capture emits one evidence item per stuttered frame; a few
    // hundred make sheet3.xml far larger than V8's ~125k spread-argument
    // limit. Rendering must not depend on argument count.
    const items = Array.from({ length: 500 }, (_, index) =>
      evidence({
        kind: 'jank',
        severity: 'warn',
        subject: { process: 'com.demo', frameNo: index },
        window: { startNs: index * 1000, endNs: index * 1000 + 10 },
        signals: {},
        explain: 'x'.repeat(400),
        drillDown: [],
      }),
    );
    const model = build([{ analyzerId: 'frames', status: 'measured', result: { metrics: [], evidence: items } }]);

    const bytes = renderReportXlsx(model);
    expect(bytes.length).toBeGreaterThan(200_000);
    expect(entryText(readStoredZip(bytes), 'xl/worksheets/sheet3.xml')).toContain('x'.repeat(400));
  });
});
