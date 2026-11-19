/**
 * A suspect list as a report: the document `suspects.json` carries, and the
 * lines a terminal shows.
 *
 * ## Why the prompt travels with the answer
 *
 * A ranked list is only meaningful against the question it answers. Two runs
 * over the same tree with different symptoms produce different orders, and a
 * reader comparing them needs to see which prompt produced which order. The
 * document therefore carries the prompt it was ranked against — or says that it
 * was ranked by confidence alone.
 */

import { maxOf } from '../extremes';
import type { Suspect } from './suspects';
import type { CasePrompt } from './symptoms';

/** The document `suspects.json` carries. */
export interface SuspectsDocument {
  readonly schema: 'ohos-perf.suspects/1';
  readonly root: string;
  /** The symptom the ranking used, or absent when there was none. */
  readonly prompt?: CasePrompt;
  /** Files scanned and symbols found, so a zero result can be read as "clean". */
  readonly scanned: { readonly files: number; readonly symbols: number };
  readonly suspects: readonly Suspect[];
}

/** The document for one scan. */
export function buildSuspectsDocument(
  root: string,
  files: number,
  symbols: number,
  suspects: readonly Suspect[],
  prompt?: CasePrompt,
): SuspectsDocument {
  return {
    schema: 'ohos-perf.suspects/1',
    root,
    ...(prompt === undefined ? {} : { prompt }),
    scanned: { files, symbols },
    suspects,
  };
}

/** One line per suspect, for a terminal. */
export function renderSuspectsText(document: SuspectsDocument): string {
  const lines: string[] = [];
  lines.push(
    `scanned  ${document.scanned.files} file(s), ${document.scanned.symbols} symbol(s)  ${document.root}`,
  );
  if (document.prompt?.symptom !== undefined) {
    lines.push(`symptom  ${document.prompt.symptom}`);
  }
  if (document.suspects.length === 0) {
    lines.push('suspects none');
    return `${lines.join('\n')}\n`;
  }
  // Not `Math.max(...paths)`: one argument per suspect overflows V8's
  // argument limit on a large tree, and a tree with 150k findings is exactly
  // the one whose report has to print.
  const width = maxOf(document.suspects.map((suspect) => suspect.file.length));
  for (const suspect of document.suspects) {
    const where = `${suspect.file}:${suspect.lineStart}`;
    const symbol =
      suspect.symbol === undefined
        ? (suspect.className ?? '')
        : `${suspect.className ?? ''}.${suspect.symbol}`.replace(/^\./, '');
    lines.push(
      `#${String(suspect.rank).padStart(2)} ${suspect.confidence.padEnd(6)} ` +
        `${where.padEnd(width + 8)} ${symbol.padEnd(28)} ${suspect.rule}`,
    );
    lines.push(`    ${suspect.description}`);
  }
  return `${lines.join('\n')}\n`;
}
