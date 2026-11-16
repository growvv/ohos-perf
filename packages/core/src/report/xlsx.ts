import type { ReportModel } from './model';

/*
 * A deliberately small SpreadsheetML writer.
 *
 * The workbook is a stored (uncompressed) ZIP of five to six XML parts. Stored
 * entries avoid a compression dependency, the DOS timestamp is pinned to the
 * ZIP epoch and the entry order is fixed, so two renders of the same model are
 * byte-identical. There are no styles, formulas, charts or shared strings: the
 * column contract is the artifact, not the formatting.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
}

/** Store every part in a single ZIP; the caller supplies the fixed order. */
function storedZip(files: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = files.map(([name, content]) => {
    const data = encoder.encode(content);
    return { name: encoder.encode(name), data, crc: crc32(data) };
  });

  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const localStart = offset;
    const header = [
      ...u32(0x04034b50), // local file header
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 names
      ...u16(0), // stored
      ...u16(0), // DOS time: 00:00
      ...u16(0x0021), // DOS date: 1980-01-01
      ...u32(entry.crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(entry.name.length),
      ...u16(0), // extra length
      ...entry.name,
    ];
    local.push(...header, ...entry.data);

    central.push(
      ...u32(0x02014b50), // central directory header
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0x0021),
      ...u32(entry.crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(entry.name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(localStart),
      ...entry.name,
    );

    offset += header.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = central.length;
  const end = [
    ...u32(0x06054b50),
    ...u16(0), // disk
    ...u16(0), // disk with central directory
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(centralOffset),
    ...u16(0), // comment
  ];

  return Uint8Array.from([...local, ...central, ...end]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A1-style column name for a zero-based index. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

type CellValue = string | number | null | undefined;

function cellXml(ref: string, value: CellValue): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (value === null || value === undefined) return `<c r="${ref}"/>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
}

function sheetXml(rows: CellValue[][]): string {
  const body = rows.map((cells, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cellsXml = cells
      .map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowNumber}`, value))
      .join('');
    return `<row r="${rowNumber}">${cellsXml}</row>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body.join('')}</sheetData></worksheet>`
  );
}

const CONTENT_TYPES_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';

const SHEET_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="xl/workbook.xml"/></Relationships>';

function workbookXml(names: string[]): string {
  const sheets = names
    .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRels(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
      `Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `${rels}</Relationships>`
  );
}

function summaryRows(model: ReportModel): CellValue[][] {
  const rows: CellValue[][] = [
    ['key', 'value'],
    ['schema_version', model.schemaVersion],
    ['generator', model.generator.name],
    ['generator_version', model.generator.version],
    ['app', model.scenario.app.packageName],
    ['device', model.scenario.device],
    ['window_start_ns', model.scenario.window.startNs],
    ['window_end_ns', model.scenario.window.endNs],
  ];
  if (model.scenario.startedAtNs !== undefined) {
    rows.push(['started_at_ns', model.scenario.startedAtNs]);
  }
  rows.push(
    ['metrics', model.totals.metrics],
    ['evidence', model.totals.evidence],
    ['evidence_info', model.totals.bySeverity.info],
    ['evidence_warn', model.totals.bySeverity.warn],
    ['evidence_critical', model.totals.bySeverity.critical],
    ['sections_measured', model.totals.measured],
    ['sections_degraded', model.totals.degraded],
  );
  return rows;
}

function metricsRows(model: ReportModel): CellValue[][] {
  const rows: CellValue[][] = [[
    'section', 'id', 'value', 'unit', 'fidelity', 'degraded_reason',
    'window_start_ns', 'window_end_ns', 'collector', 'table', 'rows', 'device',
  ]];
  for (const section of model.sections) {
    for (const metric of section.metrics) {
      rows.push([
        section.id,
        metric.id,
        metric.value,
        metric.unit,
        metric.fidelity,
        metric.degraded?.reason,
        metric.window?.startNs,
        metric.window?.endNs,
        metric.provenance.collector,
        metric.provenance.table,
        metric.provenance.rows,
        metric.provenance.device,
      ]);
    }
  }
  return rows;
}

function evidenceRows(model: ReportModel): CellValue[][] {
  const rows: CellValue[][] = [[
    'section', 'id', 'kind', 'severity', 'process', 'thread', 'frame_no', 'pid',
    'window_start_ns', 'window_end_ns', 'explain', 'signals',
  ]];
  for (const section of model.sections) {
    for (const item of section.evidence) {
      const signals = Object.keys(item.signals)
        .sort()
        .map((key) => `${key}=${String(item.signals[key])}`)
        .join(', ');
      rows.push([
        section.id,
        item.id,
        item.kind,
        item.severity,
        item.subject.process,
        item.subject.thread,
        item.subject.frameNo,
        item.subject.pid,
        item.window.startNs,
        item.window.endNs,
        item.explain,
        signals,
      ]);
    }
  }
  return rows;
}

function compareRows(model: ReportModel): CellValue[][] {
  const rows: CellValue[][] = [[
    'id', 'unit', 'baseline', 'current', 'delta', 'delta_pct', 'status', 'fidelity',
  ]];
  for (const row of model.comparison?.rows ?? []) {
    rows.push([
      row.id,
      row.unit,
      row.baseline,
      row.current,
      row.delta,
      row.deltaPct,
      row.status,
      row.fidelity,
    ]);
  }
  return rows;
}

/**
 * Render the whole model as a minimal XLSX workbook.
 *
 * Sheets: `Summary`, `Metrics`, `Evidence` and, when a comparison is present,
 * `Compare`. All names are well under Excel's 31-character limit.
 */
export function renderReportXlsx(model: ReportModel): Uint8Array {
  const names =
    model.comparison === undefined
      ? ['Summary', 'Metrics', 'Evidence']
      : ['Summary', 'Metrics', 'Evidence', 'Compare'];
  const sheets = [
    sheetXml(summaryRows(model)),
    sheetXml(metricsRows(model)),
    sheetXml(evidenceRows(model)),
    ...(model.comparison === undefined ? [] : [sheetXml(compareRows(model))]),
  ];

  const contentTypes =
    CONTENT_TYPES_HEAD +
    names
      .map(
        (_, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
          `ContentType="${SHEET_CONTENT_TYPE}"/>`,
      )
      .join('') +
    '</Types>';

  const files: Array<[string, string]> = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbookXml(names)],
    ['xl/_rels/workbook.xml.rels', workbookRels(names.length)],
    ...sheets.map(
      (xml, index): [string, string] => [`xl/worksheets/sheet${index + 1}.xml`, xml],
    ),
  ];

  return storedZip(files);
}
