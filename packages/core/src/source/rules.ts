/**
 * The rules: named predicates over one symbol's text.
 *
 * ## What a rule is
 *
 * A rule fires when a symbol's text carries a shape that costs work at run
 * time, and it says which shape it matched. That is the whole contract. A rule
 * that fires on ordinary code is a defect in the rule, so every test in
 * `source-rules.test.ts` is either "this shape fires" or "this ordinary code
 * does not".
 *
 * ## Why two rules are negative
 *
 * `http-session-not-destroyed` and `unbounded-accumulation` fire only when the
 * escape hatch is absent — a `destroy()` anywhere in the file, a `delete` in
 * the same class. A positive test for `createHttp()` would fire on every
 * correct client too, and a rule that names everything names nothing.
 */

import type { SourceFile, SourceSymbol } from './scan';

/** What a rule is given: one symbol, and the file it lives in. */
export interface SourceFacts {
  readonly file: SourceFile;
  readonly symbol: SourceSymbol;
  /** Module-level lines, for rules that fire outside any symbol. */
  readonly moduleText: string;
}

export type RuleCategory = 'latency' | 'cpu' | 'memory' | 'network';

export interface Rule {
  readonly id: string;
  readonly category: RuleCategory;
  readonly confidence: 'high' | 'medium' | 'low';
  /** Returns a description when the rule fires on this symbol, else undefined. */
  match(facts: SourceFacts): string | undefined;
}

/** A loop header, used by the rules that need "inside a loop". */
const LOOP = /\b(for|while|forEach|\.map\s*\(|\.filter\s*\()/;
/** A SQL statement keyword, case-insensitive. */
const SQL = /\b(SELECT|DELETE|INSERT|UPDATE)\b/i;

/** The first line of `text` that matches `pattern`, trimmed, or undefined. */
export function firstMatch(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split('\n')) {
    if (pattern.test(line)) return line.trim();
  }
  return undefined;
}

/**
 * A SQL string assembled from concatenation.
 *
 * The assembled statement is returned, not one literal: the benchmark's
 * `jingmo_random_poem_orderby_random` root cause is a constant built from
 * `'select * from ' + TABLE + ' where …'`, and a rule that reads one literal
 * sees neither half.
 */
export function sqlText(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!SQL.test(lines[index]!)) continue;
    const parts = [lines[index]!];
    for (let next = index + 1; next < lines.length && next <= index + 6; next++) {
      const line = lines[next]!;
      if (/^\s*['"`]/.test(line)) parts.push(line);
      else break;
    }
    return parts.join(' ').trim();
  }
  return undefined;
}

/** Every rule, in declaration order. */
export const RULES: readonly Rule[] = [
  {
    id: 'sql-order-by-random',
    category: 'latency',
    confidence: 'high',
    match(facts) {
      const text = sqlText(facts.symbol.body) ?? sqlText(facts.moduleText);
      if (text === undefined) return undefined;
      if (!/order\s+by\s+random\s*\(/i.test(text)) return undefined;
      return `a SQL statement sorts the whole table to pick one row: ${text}`;
    },
  },
  {
    id: 'sql-statement-in-loop',
    category: 'latency',
    confidence: 'high',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let loopDepth = 0;
      for (const line of lines) {
        if (LOOP.test(line) && line.includes('{')) loopDepth += 1;
        if (loopDepth > 0 && /\b(DELETE|INSERT|UPDATE)\b/i.test(line) && /executeSql|insert|update|delete/i.test(line)) {
          return `a SQL statement runs once per iteration: ${line.trim()}`;
        }
        if (line.includes('}')) loopDepth = Math.max(0, loopDepth - 1);
      }
      return undefined;
    },
  },
  {
    id: 'eager-foreach',
    category: 'latency',
    confidence: 'medium',
    match(facts) {
      const body = facts.symbol.body;
      if (!/ForEach\s*\(/.test(body)) return undefined;
      // LazyForEach is the fix; its presence means the list is already virtual.
      if (/LazyForEach\s*\(/.test(body)) return undefined;
      if (!/List\s*\(|Scroll\s*\(|Grid\s*\(|WaterFlow\s*\(/.test(body)) return undefined;
      return `every row is built up front, including the ones off screen: ${firstMatch(body, /ForEach\s*\(/)!}`;
    },
  },
  {
    id: 'network-in-onchange',
    category: 'network',
    confidence: 'high',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let inChange = false;
      for (const line of lines) {
        if (/\.onChange\s*\(/.test(line)) inChange = true;
        if (inChange && /(axios|http\.createHttp|fetch|request)\s*[.(]/.test(line)) {
          return `a request is issued on every keystroke, with no debounce: ${line.trim()}`;
        }
        if (inChange && /^\s*\}\)\s*$/.test(line)) inChange = false;
      }
      return undefined;
    },
  },
];
