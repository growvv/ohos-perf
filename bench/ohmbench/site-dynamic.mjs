#!/usr/bin/env node
/**
 * Turn a `dynamic/run.mjs` record into the data the site's benchmark page
 * reads.
 *
 * Usage:
 *   node bench/ohmbench/site-dynamic.mjs <dynamic.json> <site/dynamic.json>
 *
 * The page shows one row per case: whether the workload ran, what the
 * capture held, and — when it did not run — the selector its own plan
 * stopped at. Nothing is inferred: a field the record does not carry is
 * `null` here and rendered as "—" there.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , source, out] = process.argv;
if (source === undefined || out === undefined) {
  process.stderr.write('usage: site-dynamic.mjs <dynamic.json> <site/dynamic.json>\n');
  process.exit(2);
}

const record = JSON.parse(readFileSync(source, 'utf8'));
const records = Array.isArray(record) ? record : record.records ?? [];

/** The phase a run failed in, and the plan step that stopped it. */
function stoppedAt(row) {
  const workload = row.workload ?? {};
  // Execution order, not check order: `measured` runs inside the window and
  // `verify` after it, so when both fail the first one is where the run
  // actually stopped.
  if (workload.setup?.ok === false) return { phase: 'setup', ...failedAction(workload.setup) };
  if (workload.measured?.ok === false) return { phase: 'measured', ...failedAction(workload.measured) };
  if (workload.verify?.ok === false) return { phase: 'verify', ...failedAction(workload.verify) };
  if (typeof workload.error === 'string') return { phase: 'measured', description: null, error: workload.error };
  return null;
}

function failedAction(phase) {
  const action = (phase?.actions ?? []).find((item) => !item.ok);
  return { description: action?.description ?? null, error: action?.error ?? phase?.error ?? null };
}

const cases = records.map((row) => {
  const stopped = row.status === 'ok' ? null : stoppedAt(row);
  // `captured` means "a scene exists and was analyzed". A record written
  // before the field existed (0.33.2) still says where the scene is, but the
  // old `run.mjs` only analyzed a run whose status was `ok` — so a scene on
  // disk is not proof of an analysis, and the metrics are.
  const captured = typeof row.captured === 'boolean'
    ? row.captured
    : typeof row.metrics === 'number';
  return {
    id: row.case,
    status: row.status,
    windowSeconds: row.windowSeconds ?? null,
    captured,
    metrics: row.metrics ?? null,
    degraded: row.degraded ?? null,
    evidence: Array.isArray(row.evidence) ? row.evidence.length : null,
    verdict: row.rootCause?.verdict ?? null,
    bytes: row.bytes ?? null,
    stoppedAt: stopped,
  };
});

const summary = {
  cases: cases.length,
  ranClean: cases.filter((c) => c.status === 'ok').length,
  captured: cases.filter((c) => c.captured).length,
  critical: cases.filter((c) => typeof c.verdict === 'string' && c.verdict.startsWith('critical')).length,
};

writeFileSync(out, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
process.stdout.write(
  `${summary.cases} cases: ${summary.ranClean} ran clean, ${summary.captured} captured,` +
    ` ${summary.critical} critical\n`,
);
