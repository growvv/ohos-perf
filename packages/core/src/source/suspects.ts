/**
 * From rule matches to a ranked suspect list.
 *
 * ## Why confidence first
 *
 * The benchmark scores the top five, so the order is the product. A rule whose
 * shape is unambiguous — `order by random()` is a full-table sort every time —
 * outranks one that depends on how the code is called. Within a confidence
 * band the category breaks the tie: a latency defect at the top of a screen is
 * what a user feels first, a network defect last.
 *
 * ## Why module-level rules run once per file
 *
 * `PersistentStorage.persistProp("homeList", [])` is a statement, not a member:
 * it sits between imports and the first class. A rule that only ran over
 * symbols would miss it, and it is one of the benchmark's root causes.
 */

import type { SourceFile, SourceSymbol } from './scan';
import { RULES, type Rule } from './rules';

/** One ranked location. */
export interface Suspect {
  /** 1-based rank; 1 is the most likely root cause. */
  readonly rank: number;
  readonly file: string;
  readonly className?: string;
  readonly symbol?: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** The rule's id, e.g. 'sql-order-by-random'. */
  readonly rule: string;
  /** Why this fired, in the rule's own words, with the matched text. */
  readonly description: string;
  readonly confidence: 'high' | 'medium' | 'low';
}

/** How a category weighs when two rules share a confidence. */
const CATEGORY_WEIGHT = { latency: 3, cpu: 2, memory: 2, network: 1 } as const;

const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

/** The ranked suspects for a set of scanned files. */
export function findSuspects(files: readonly SourceFile[]): Suspect[] {
  const hits: Omit<Suspect, 'rank'>[] = [];

  for (const file of files) {
    const moduleText = file.moduleLines.join('\n');
    const moduleSymbol: SourceSymbol = {
      symbol: '',
      lineStart: 1,
      lineEnd: Math.max(1, file.lines.length),
      body: moduleText,
      // Module lines are statements, not blocks: a rule that counts loop depth
      // over them has nothing to count, and the blanking would only lose the
      // text a description quotes. The raw text is the honest answer here.
      code: moduleText,
      declaration: moduleText,
    };
    const factsList = [
      ...file.symbols.map((symbol) => ({ file, symbol, moduleText })),
      { file, symbol: moduleSymbol, moduleText },
    ];

    for (const facts of factsList) {
      // One symbol, one suspect. Two rules firing on `updateSources` — a write
      // loop and a SQL loop — are one finding about one piece of code, and
      // reporting it twice would spend two of the five slots a reader gets.
      // The sharper rule wins: its description is the one that names the cost.
      let best: { rule: string; description: string; confidence: Suspect['confidence'] }[] | undefined;
      for (const rule of RULES) {
        const matched = rule.match(facts);
        if (matched === undefined) continue;
        const descriptions = typeof matched === 'string' ? [matched] : matched;
        if (descriptions.length === 0) continue;
        const weight = CONFIDENCE_WEIGHT[rule.confidence];
        if (best === undefined || weight > CONFIDENCE_WEIGHT[best[0]!.confidence]) {
          best = descriptions.map((description) => ({ rule: rule.id, description, confidence: rule.confidence }));
        }
      }
      if (best === undefined) continue;

      const isModule = facts.symbol.symbol === '';
      let cursor = 0;
      for (const hit of best) {
        let lineStart: number;
        if (isModule) {
          const located = moduleLineOf(file, hit.description, cursor);
          lineStart = located.line;
          cursor = located.next;
        } else {
          lineStart = facts.symbol.lineStart;
        }
        // A module-level statement has no class to name it, but the file it
        // sits in does: `HomePage.ets` says "home" the same way
        // `class HomePage` would. Without it a module-scope finding could never
        // match a prompt that names its screen.
        const className = facts.symbol.className ?? (isModule ? classOfPath(file.path) : undefined);
        hits.push({
          file: file.path,
          ...(className === undefined ? {} : { className }),
          ...(isModule ? {} : { symbol: facts.symbol.symbol }),
          lineStart,
          lineEnd: isModule ? lineStart : facts.symbol.lineEnd,
          rule: hit.rule,
          description: hit.description,
          confidence: hit.confidence,
        });
      }
    }
  }

  const ranked = hits.sort(
    (a, b) =>
      CONFIDENCE_WEIGHT[b.confidence] - CONFIDENCE_WEIGHT[a.confidence] ||
      categoryOf(b.rule) - categoryOf(a.rule) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.lineStart - b.lineStart ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );

  return ranked.map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/** The category weight of a rule id, for the tie-break. */
function categoryOf(ruleId: string): number {
  const rule = RULES.find((candidate) => candidate.id === ruleId);
  return rule === undefined ? 0 : CATEGORY_WEIGHT[rule.category];
}

/** The class name a file is most likely to declare: its own stem. */
function classOfPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const stem = name.replace(/\.(ets|ts|js)$/i, '');
  return /^[A-Z]/.test(stem) ? stem : undefined;
}

/**
 * The line a module-level match sits on.
 *
 * The description ends with the matched text, so the first module line that
 * contains it is the line to report. Falling back to line 1 would point a
 * reader at the top of the file.
 *
 * Two identical statements are two statements. `start` is where to begin
 * searching, so the caller can consume one occurrence per match instead of
 * sending every duplicate to the first line that holds the text. The line
 * number comes from `moduleLineNumbers` — the number the scan already knew —
 * rather than from `lines.indexOf`, which always finds the first copy.
 */
function moduleLineOf(file: SourceFile, description: string, start: number): { line: number; next: number } {
  const needle = description.slice(description.lastIndexOf(':') + 1).trim();
  if (needle !== '') {
    for (let index = start; index < file.moduleLines.length; index++) {
      if (file.moduleLines[index]!.includes(needle)) {
        return { line: file.moduleLineNumbers[index] ?? 1, next: index + 1 };
      }
    }
    // No further occurrence: the description names text the module lines do
    // not hold verbatim (a reassembled SQL statement, say). The first one is
    // still the closest answer.
    for (let index = 0; index < file.moduleLines.length; index++) {
      if (file.moduleLines[index]!.includes(needle)) {
        return { line: file.moduleLineNumbers[index] ?? 1, next: index + 1 };
      }
    }
  }
  return { line: 1, next: start };
}

export type { Rule };
