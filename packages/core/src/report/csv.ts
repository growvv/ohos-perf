import type { ReportModel, ReportSection } from './model';

/**
 * RFC 4180-style field escaping, with `\n` row endings.
 *
 * A field is quoted only when it must be (comma, quote, CR or LF), so ordinary
 * ids and numbers stay unquoted and the file diffs cleanly. Inner quotes are
 * doubled. `undefined` renders as an empty cell.
 */
function cell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  if (!/[,",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function row(fields: Array<string | number | undefined>): string {
  return fields.map(cell).join(',') + '\n';
}

/** `JSON.stringify` with recursively sorted object keys, so input order cannot leak. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const METRICS_HEADER =
  'section,id,value,unit,fidelity,degraded_reason,window_start_ns,window_end_ns,' +
  'collector,table,rows,device\n';

const EVIDENCE_HEADER =
  'section,id,kind,severity,process,thread,frame_no,pid,window_start_ns,' +
  'window_end_ns,explain,signals\n';

function metricsRows(section: ReportSection): string[] {
  return section.metrics.map((metric) =>
    row([
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
    ]),
  );
}

function evidenceRows(section: ReportSection): string[] {
  return section.evidence.map((item) =>
    row([
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
      stableJson(item.signals),
    ]),
  );
}

/**
 * One CSV row per metric, in model order (sections by id, metrics by id).
 *
 * The header is a documented contract; adding a column is a schema change and
 * belongs to a new report schema version, not a silent append.
 */
export function renderMetricsCsv(model: ReportModel): string {
  return METRICS_HEADER + model.sections.map(metricsRows).flat().join('');
}

/**
 * One CSV row per evidence item, in model order.
 *
 * `drillDown` is intentionally absent: it is structured data that belongs in
 * the JSON and HTML, and flattening it would make the cell ambiguous.
 */
export function renderEvidenceCsv(model: ReportModel): string {
  return EVIDENCE_HEADER + model.sections.map(evidenceRows).flat().join('');
}
