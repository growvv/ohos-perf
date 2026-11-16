import { OhosPerfError } from '../errors';

/**
 * hilog rule conditions, evaluated without `eval`.
 *
 * Upstream builds a Python expression string and calls `eval` with a
 * restricted namespace. That is both a code-execution surface and a silent
 * failure mode: a group that is not numeric becomes `0`, so a typo turns into
 * a confident wrong count. This module parses the same language into a small
 * AST and evaluates it, and every failure is a typed error naming the rule
 * input.
 *
 * Language:
 *   - `$1..$n` group references (1-based, matching `groups`)
 *   - numeric literals, `+ - * / %`, parentheses
 *   - `== != < > <= >=`
 *   - conjunction with `,` or `&&`
 */

type Comparison = '==' | '!=' | '<' | '>' | '<=' | '>=';

type Token =
  | { kind: 'group'; index: number }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '%' }
  | { kind: 'cmp'; value: Comparison }
  | { kind: 'and' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

function bad(source: string, why: string): OhosPerfError {
  return new OhosPerfError(`invalid hilog condition ${JSON.stringify(source)}: ${why}`, {
    code: 'HILOG_BAD_EXPRESSION',
  });
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '$') {
      const match = /^\$(\d+)/.exec(source.slice(i));
      if (match === null) throw bad(source, 'expected a group number after "$"');
      const index = Number(match[1]);
      if (index < 1) throw bad(source, `group references are 1-based (got $${match[1]})`);
      tokens.push({ kind: 'group', index });
      i += match[0].length;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i));
      if (match === null) throw bad(source, `unexpected "${ch}"`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (source.startsWith('&&', i)) {
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'and' });
      i++;
      continue;
    }
    const cmp = /^(==|!=|<=|>=|<|>)/.exec(source.slice(i));
    if (cmp !== null) {
      tokens.push({ kind: 'cmp', value: cmp[1] as Comparison });
      i += cmp[1].length;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    throw bad(source, `unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'group'; index: number }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '%'; left: Node; right: Node }
  | { kind: 'compare'; op: Comparison; left: Node; right: Node }
  | { kind: 'and'; left: Node; right: Node };

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  parseAll(): Node {
    const node = this.parseConjunction();
    if (this.pos !== this.tokens.length) {
      throw bad(this.source, 'trailing input after a complete expression');
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseConjunction(): Node {
    let left = this.parseComparison();
    while (this.peek()?.kind === 'and') {
      this.pos++;
      const right = this.parseComparison();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseComparison(): Node {
    let left = this.parseSum();
    const token = this.peek();
    if (token?.kind === 'cmp') {
      this.pos++;
      const right = this.parseSum();
      left = { kind: 'compare', op: token.value, left, right };
      if (this.peek()?.kind === 'cmp') {
        throw bad(this.source, 'chained comparisons are not supported');
      }
    }
    return left;
  }

  private parseSum(): Node {
    let left = this.parseProduct();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      this.pos++;
      left = { kind: 'binary', op: token.value, left, right: this.parseProduct() };
    }
    return left;
  }

  private parseProduct(): Node {
    let left = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/' && token.value !== '%')) {
        break;
      }
      this.pos++;
      left = { kind: 'binary', op: token.value, left, right: this.parsePrimary() };
    }
    return left;
  }

  private parsePrimary(): Node {
    const token = this.tokens[this.pos];
    if (token === undefined) throw bad(this.source, 'unexpected end of expression');
    this.pos++;
    if (token.kind === 'number') return { kind: 'num', value: token.value };
    if (token.kind === 'group') return { kind: 'group', index: token.index };
    if (token.kind === 'lparen') {
      const inner = this.parseConjunction();
      const close = this.tokens[this.pos];
      if (close?.kind !== 'rparen') throw bad(this.source, 'missing ")"');
      this.pos++;
      return inner;
    }
    if (token.kind === 'op' && token.value === '-') {
      // Unary minus is the only unary operator the language needs.
      return { kind: 'binary', op: '-', left: { kind: 'num', value: 0 }, right: this.parsePrimary() };
    }
    throw bad(this.source, `unexpected token "${token.kind}"`);
  }
}

/** A non-numeric group reference: the rule is wrong, not the data. */
class NonNumericGroup extends Error {
  constructor(readonly index: number, readonly value: string | undefined) {
    super(
      value === undefined
        ? `group reference $${index} is out of range (the regex captured fewer groups)`
        : `group reference $${index} is not numeric: ${JSON.stringify(value)}`,
    );
  }
}

function evaluate(node: Node, groups: readonly (string | undefined)[]): number | boolean {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'group': {
      const raw = groups[node.index - 1];
      if (raw === undefined) throw new NonNumericGroup(node.index, undefined);
      const value = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(value)) throw new NonNumericGroup(node.index, raw);
      return value;
    }
    case 'binary': {
      const left = asNumber(evaluate(node.left, groups));
      const right = asNumber(evaluate(node.right, groups));
      switch (node.op) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          if (right === 0) throw new Error('division by zero in a hilog condition');
          return left / right;
        case '%':
          if (right === 0) throw new Error('modulo by zero in a hilog condition');
          return left % right;
      }
      break;
    }
    case 'compare': {
      const left = asNumber(evaluate(node.left, groups));
      const right = asNumber(evaluate(node.right, groups));
      switch (node.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '<':
          return left < right;
        case '>':
          return left > right;
        case '<=':
          return left <= right;
        case '>=':
          return left >= right;
      }
      break;
    }
    case 'and':
      return asBool(evaluate(node.left, groups)) && asBool(evaluate(node.right, groups));
  }
  throw new Error('unreachable');
}

function asNumber(value: number | boolean): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function asBool(value: number | boolean): boolean {
  return typeof value === 'boolean' ? value : value !== 0;
}

/**
 * Compile an expression into a predicate over captured groups.
 *
 * Throws `HILOG_BAD_EXPRESSION` for a malformed expression. The returned
 * predicate throws when a referenced group is not numeric or is out of range,
 * and when an arithmetic operation divides by zero: upstream substitutes `0`
 * and silently reports a match, which is a wrong answer the caller cannot see.
 */
export function compileExpression(
  source: string,
): (groups: readonly (string | undefined)[]) => boolean {
  if (source.trim() === '') {
    throw bad(source, 'the expression is empty');
  }
  const node = new Parser(tokenize(source), source).parseAll();
  return (groups) => {
    try {
      return asBool(evaluate(node, groups));
    } catch (err) {
      if (err instanceof NonNumericGroup) {
        throw new OhosPerfError(
          `invalid hilog condition ${JSON.stringify(source)}: ${err.message}`,
          { code: 'HILOG_NON_NUMERIC_GROUP' },
        );
      }
      throw err;
    }
  };
}

/**
 * The array form: one comparison per extracted group.
 *
 * Numeric values compare numerically, non-numeric ones as strings, matching
 * upstream's `ConditionEvaluator`. An unsupported operator is a typed error
 * rather than upstream's "treat as true", which makes every rule match.
 */
export function evaluateCondition(value: string, condition: string): boolean {
  if (condition === '') return true;
  const match = /^(==|!=|<=|>=|<|>)\s*(.*)$/.exec(condition.trim());
  if (match === null) {
    throw new OhosPerfError(
      `invalid hilog condition ${JSON.stringify(condition)}: expected ==, !=, <, >, <= or >=`,
      { code: 'HILOG_BAD_EXPRESSION' },
    );
  }
  const [, operator, expectedRaw] = match;
  const expected = expectedRaw.trim();
  const numeric = value.trim() !== '' && Number.isFinite(Number(value));
  const expectedNumeric = expected !== '' && Number.isFinite(Number(expected));
  const left: number | string = numeric ? Number(value) : value;
  const right: number | string = numeric && expectedNumeric ? Number(expected) : expected;
  switch (operator as Comparison) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
  }
  return false;
}
