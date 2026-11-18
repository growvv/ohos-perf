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
      let best: { rule: string; description: string; confidence: Suspect['confidence'] } | undefined;
      for (const rule of RULES) {
        const description = rule.match(facts);
        if (description === undefined) continue;
        if (best === undefined || CONFIDENCE_WEIGHT[rule.confidence] > CONFIDENCE_WEIGHT[best.confidence]) {
          best = { rule: rule.id, description, confidence: rule.confidence };
        }
      }
      if (best === undefined) continue;

      const isModule = facts.symbol.symbol === '';
      const lineStart = isModule ? moduleLineOf(file, best.description) : facts.symbol.lineStart;
      hits.push({
        file: file.path,
        ...(facts.symbol.className === undefined ? {} : { className: facts.symbol.className }),
        ...(isModule ? {} : { symbol: facts.symbol.symbol }),
        lineStart,
        lineEnd: isModule ? lineStart : facts.symbol.lineEnd,
        rule: best.rule,
        description: best.description,
        confidence: best.confidence,
      });
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

/**
 * The line a module-level match sits on.
 *
 * The description ends with the matched text, so the first module line that
 * contains it is the line to report. Falling back to line 1 would point a
 * reader at the top of the file.
 */
function moduleLineOf(file: SourceFile, description: string): number {
  const needle = description.slice(description.lastIndexOf(':') + 1).trim();
  if (needle !== '') {
    for (let index = 0; index < file.moduleLines.length; index++) {
      if (file.moduleLines[index]!.includes(needle)) {
        return file.lines.indexOf(file.moduleLines[index]!) + 1;
      }
    }
  }
  return 1;
}

export type { Rule };
