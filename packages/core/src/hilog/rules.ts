// Ported from ArkAnalyzer-HapRay (Apache-2.0); see THIRD_PARTY_NOTICES.md.

import { OhosPerfError } from '../errors';
import { compileExpression, evaluateCondition } from './expression';
import type { HilogLine } from './parse';

/** One pattern rule, in the shape HapRay's `hilog.patterns` uses. */
export interface HilogRule {
  readonly name: string;
  readonly regex: string;
  /**
   * Which capture groups to extract, 1-based. `0` means the whole match.
   * Defaults to `[0]`, matching upstream's `groups` default.
   */
  readonly groups?: readonly number[];
  /**
   * Either one comparison per extracted group (`['!=4', '>512']`) or one
   * expression over `$1`, `$2`, … (`'$1 * $2 > $3 * $4'`).
   */
  readonly conditions?: string | readonly string[];
  /**
   * `message` (default) matches the log message only, so a rule cannot match
   * a tag by accident. `line` matches the whole raw line, with `^`/`$`
   * anchored per line.
   */
  readonly scope?: 'message' | 'line';
}

/** One rule hit: which rule, which line, and the extracted group values. */
export interface HilogMatch {
  readonly ruleName: string;
  readonly lineIndex: number;
  readonly groups: readonly string[];
}

/** A compiled rule: the regex, the condition, and the extraction plan. */
export interface CompiledRule {
  readonly name: string;
  match(line: HilogLine): readonly string[] | undefined;
}

/**
 * HapRay's `hilog.patterns`, verbatim from `config.yaml` at `9386e4e`.
 *
 * The three `CreatePixelMap` rules share one regex and differ only in their
 * condition, so a single line can match more than one — upstream counts it
 * in each, and so does this port.
 */
export const DEFAULT_HILOG_RULES: readonly HilogRule[] = Object.freeze([
  {
    name: 'no_dmp',
    regex: 'CreatePixelMap success,.*memType\\s*:\\s*(\\d+),\\s*cost\\s+\\d+\\s+us',
    groups: [1],
    conditions: '$1!=4',
  },
  {
    name: 'big_image_with_target_size',
    regex:
      'CreatePixelMap success.*dSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\).*srcSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\)',
    groups: [1, 2, 3, 4],
    conditions: '$1*$2>0,$3*$4>512*512',
  },
  {
    name: 'big_image_without_target_size',
    regex:
      'CreatePixelMap success.*dSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\).*srcSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\)',
    groups: [1, 2, 3, 4],
    conditions: '$1*$2==0,$3*$4>512*512',
  },
  {
    name: 'image_same_size',
    regex:
      'CreatePixelMap success.*dSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\).*srcSize\\s*:\\s*\\((\\d+),\\s*(\\d+)\\)',
    groups: [1, 2, 3, 4],
    conditions: '$1*$2==$3*$4',
  },
]);

/** Upstream's `re.IGNORECASE | re.MULTILINE`, split by scope. */
function compileRegex(rule: HilogRule): RegExp {
  // `m` is what lets `^`/`$` match at an inner newline. That is upstream's
  // behaviour on a whole message, and it is exactly what a line-scoped rule
  // must not have — a log line is one line, whatever the message contains.
  const flags = rule.scope === 'line' ? 'gi' : 'gim';
  try {
    return new RegExp(rule.regex, flags);
  } catch (err) {
    throw new OhosPerfError(
      `hilog rule ${JSON.stringify(rule.name)} has an invalid regex ` +
        `${JSON.stringify(rule.regex)}: ${(err as Error).message}`,
      { code: 'HILOG_BAD_REGEX' },
    );
  }
}

function compileCondition(
  rule: HilogRule,
): ((groups: readonly (string | undefined)[]) => boolean) | undefined {
  const conditions = rule.conditions;
  if (conditions === undefined) return undefined;
  if (typeof conditions === 'string') {
    if (conditions.trim() === '') return undefined;
    return compileExpression(conditions);
  }
  if (conditions.length === 0) return undefined;
  return (groups) => {
    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];
      if (condition === '') continue;
      const value = groups[i];
      if (value === undefined) return false;
      if (!evaluateCondition(value, condition)) return false;
    }
    return true;
  };
}

/**
 * Compile a rule set, sorted by name.
 *
 * Sorting is what makes evaluation order independent of the caller's array:
 * two rule files with the same rules in different orders produce the same
 * match list.
 */
export function compileRules(rules: readonly HilogRule[]): CompiledRule[] {
  return [...rules]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((rule) => {
      const regex = compileRegex(rule);
      const condition = compileCondition(rule);
      const groupIndexes = rule.groups ?? [0];
      return {
        name: rule.name,
        match(line: HilogLine): readonly string[] | undefined {
          const text = rule.scope === 'line' ? renderLine(line) : line.message;
          regex.lastIndex = 0;
          const hit = regex.exec(text);
          if (hit === null) return undefined;
          const extracted = groupIndexes.map((index) => {
            if (index === 0) return hit[0];
            return hit[index] ?? '';
          });
          if (condition !== undefined && !condition(extracted)) return undefined;
          return extracted;
        },
      };
    });
}

/**
 * The raw line as the device printed it, rebuilt from the parsed fields.
 *
 * A raw row keeps its original text in `message`, so it round-trips exactly;
 * a parsed row is re-rendered in the standard shape, which is what a
 * line-scoped rule expects to see.
 */
function renderLine(line: HilogLine): string {
  if (!line.parsed) return line.message;
  return `${line.pid} ${line.tid} ${line.level} ${line.domain}/${line.tag}: ${line.message}`;
}

/**
 * Every match over every line, ordered by `(lineIndex, ruleName)`.
 *
 * One rule's failure never stops another: a non-numeric group is a rule
 * authoring error, so it is thrown rather than swallowed, and the caller
 * decides whether to report the rule as broken.
 */
export function matchRules(
  rules: readonly CompiledRule[],
  lines: readonly HilogLine[],
): HilogMatch[] {
  const sorted = [...rules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const matches: HilogMatch[] = [];
  for (const line of lines) {
    for (const rule of sorted) {
      const groups = rule.match(line);
      if (groups === undefined) continue;
      matches.push({ ruleName: rule.name, lineIndex: line.index, groups: [...groups] });
    }
  }
  return matches;
}
