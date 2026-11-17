import type {
  RootCauseDocument,
  RootCauseObservation,
  RootCauseSuspect,
} from './root-cause';
import { isWholeCapture } from './window';

/**
 * The human report for a root-cause document (HapRay parity row 36).
 *
 * HapRay writes `root_cause.md` plus an `_evidence.md` companion, and its
 * section order follows the model's answer. Here the order follows the reader's
 * question: what did the run measure (verdict, then ranked observations), then
 * what a model made of it. A reader who stops after the first two sections has
 * the measurement; the model's prose is an addition, not the product.
 *
 * Two formatting rules exist because the output is data:
 *
 * 1. A signal value is escaped for a table cell, so an app that puts a `|` in a
 *    thread name cannot break the table.
 * 2. An ungrounded suspect is marked in place. A footnote would be read after
 *    the fix was applied, which is the wrong moment to learn the cause was
 *    invented.
 */

const PIPE = /\|/g;
const NEWLINE = /\r?\n/g;

/** Escape a value for a Markdown table cell: pipes split cells, newlines break rows. */
function cell(value: string): string {
  return value.replace(PIPE, '\\|').replace(NEWLINE, ' ');
}

/** A signal value as one cell, with the key order the document already fixed. */
function signalsCell(signals: RootCauseObservation['signals']): string {
  const keys = Object.keys(signals).sort();
  if (keys.length === 0) return '—';
  return keys.map((key) => `${key}=${String(signals[key])}`).join(', ');
}

function subjectText(subject: RootCauseObservation['subject']): string {
  const parts = [subject.process];
  if (subject.thread !== undefined) parts.push(subject.thread);
  if (subject.frameNo !== undefined) parts.push(`frame ${subject.frameNo}`);
  return parts.join(' / ');
}

function renderObservations(observations: readonly RootCauseObservation[]): string[] {
  if (observations.length === 0) {
    return ['no evidence was produced for this scene.'];
  }
  const lines = [
    '| # | severity | kind | subject | what was measured | signals |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [index, item] of observations.entries()) {
    lines.push(
      `| ${index + 1} | ${item.severity} | ${cell(item.kind)} | ${cell(subjectText(item.subject))}`
      + ` | ${cell(item.explain)} | ${cell(signalsCell(item.signals))} |`,
    );
  }
  return lines;
}

function renderSuspect(suspect: RootCauseSuspect): string[] {
  const lines: string[] = [];
  const mark = suspect.ungrounded.length === 0 ? '' : ' — **ungrounded**';
  lines.push(`### ${suspect.rank}. ${suspect.confidence} confidence${mark}`);
  lines.push('');
  lines.push(suspect.rootCause === '' ? '(no cause stated)' : suspect.rootCause);
  lines.push('');
  lines.push(`**Fix:** ${suspect.fix === '' ? '(none stated)' : suspect.fix}`);
  if (suspect.triggerChain !== undefined) {
    lines.push('');
    lines.push(`**Trigger chain:** ${suspect.triggerChain}`);
  }
  if (suspect.evidenceIds.length > 0) {
    lines.push('');
    lines.push(`**Grounded in:** ${suspect.evidenceIds.join(', ')}`);
  }
  if (suspect.ungrounded.length > 0) {
    lines.push('');
    lines.push(
      `**Ungrounded:** ${suspect.ungrounded.join(', ')} — not measured in this run,`
      + ' so this suspect may describe something the capture never saw.',
    );
  }
  lines.push('');
  return lines;
}

/**
 * Render the document as Markdown.
 *
 * Deterministic: the same document renders to the same bytes, because every
 * list it walks is already in a total order and every map is sorted on the way
 * out.
 */
export function renderRootCauseMarkdown(document: RootCauseDocument): string {
  const { summary, scene } = document;
  const lines: string[] = [];

  lines.push('# Root cause');
  lines.push('');
  lines.push(`app     ${scene.app}`);
  lines.push(`device  ${scene.device}`);
  // The whole-database marker printed as numbers reads as a 285-year span; the
  // rest of the package says "the whole capture" and so does this.
  lines.push(
    isWholeCapture(scene.window)
      ? 'window  the whole capture'
      : `window  ${scene.window.startNs}..${scene.window.endNs} ns`
        + ` (${((scene.window.endNs - scene.window.startNs) / 1e9).toFixed(2)} s)`,
  );
  lines.push(`produced by ${document.generator.name} ${document.generator.version}`);
  lines.push('');

  lines.push('## Verdict');
  lines.push('');
  lines.push(summary.verdict);
  lines.push('');
  lines.push(
    `totals: ${summary.totals.critical} critical, ${summary.totals.warn} warn,`
    + ` ${summary.totals.info} info`
    // Only when there are any: "0 gaps" on a complete capture is noise, and a
    // reader should not have to learn to skip a number that is always there.
    + (summary.totals.gaps === 0
      ? ''
      : ` (${summary.totals.gaps} report a gap in the capture rather than a finding)`),
  );
  lines.push('');

  lines.push('## Observations');
  lines.push('');
  lines.push(...renderObservations(document.observations));
  lines.push('');

  const analysis = document.analysis;
  if (analysis === undefined) {
    // Deliberately not a "Model analysis" heading: a section with that title
    // and nothing in it reads like a model answered and said nothing, which is
    // a different fact from "no model was asked".
    lines.push('## Offline report');
    lines.push('');
    lines.push(
      'no model was asked: this report was produced offline from the measured'
      + ' evidence alone. Configure a model endpoint and run without `--offline`'
      + ' to add an analysis section.',
    );
    lines.push('');
  } else {
    lines.push(`## Model analysis (${analysis.model})`);
    lines.push('');
    lines.push(analysis.summary === '' ? '(no summary stated)' : analysis.summary);
    lines.push('');
    if (analysis.suspects.length === 0) {
      lines.push('the model proposed no suspects.');
      lines.push('');
    } else {
      for (const suspect of analysis.suspects) lines.push(...renderSuspect(suspect));
    }
    if (analysis.caveats.length > 0) {
      lines.push('### Caveats');
      lines.push('');
      for (const caveat of analysis.caveats) lines.push(`- ${caveat}`);
      lines.push('');
    }
    if (analysis.needsMoreData.length > 0) {
      lines.push('### What would raise confidence');
      lines.push('');
      for (const item of analysis.needsMoreData) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
