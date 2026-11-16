import { describe, it, expect } from 'vitest';
import { compileExpression, evaluateCondition } from '../src/hilog/expression';

describe('evaluateCondition', () => {
  it('compares a numeric value with the array form', () => {
    expect(evaluateCondition('4', '!=4')).toBe(false);
    expect(evaluateCondition('5', '!=4')).toBe(true);
    expect(evaluateCondition('512', '>512')).toBe(false);
    expect(evaluateCondition('513', '>512')).toBe(true);
    expect(evaluateCondition('512', '<=512')).toBe(true);
    expect(evaluateCondition('512', '>=513')).toBe(false);
    expect(evaluateCondition('512', '==512')).toBe(true);
  });

  it('compares a non-numeric value as a string', () => {
    expect(evaluateCondition('abc', '==abc')).toBe(true);
    expect(evaluateCondition('abc', '!=abd')).toBe(true);
  });

  it('treats an empty condition as satisfied', () => {
    expect(evaluateCondition('anything', '')).toBe(true);
  });
});

describe('compileExpression', () => {
  it('evaluates arithmetic over group references', () => {
    const f = compileExpression('$1 * $2 > $3 * $4');
    expect(f(['100', '100', '200', '200'])).toBe(false);
    expect(f(['300', '300', '200', '200'])).toBe(true);
  });

  it('respects precedence and parentheses', () => {
    expect(compileExpression('$1 + $2 * 2')(['1', '3'])).toBe(true);
    expect(compileExpression('($1 + $2) * 2 == 8')(['1', '3'])).toBe(true);
    expect(compileExpression('$1 % 2 == 0')(['4'])).toBe(true);
  });

  it('conjoins with a comma or &&', () => {
    const f = compileExpression('$1*$2>0,$3*$4>512*512');
    expect(f(['100', '100', '600', '600'])).toBe(true);
    expect(f(['0', '100', '600', '600'])).toBe(false);
    expect(compileExpression('$1>1 && $2<3')(['2', '2'])).toBe(true);
    expect(compileExpression('$1>1 && $2<3')(['2', '9'])).toBe(false);
  });

  it('rejects a malformed expression by naming it', () => {
    expect(() => compileExpression('$1 * > 2')).toThrow(/\$1 \* > 2/);
    expect(() => compileExpression('')).toThrow(/empty/);
    expect(() => compileExpression('$1 +')).toThrow();
  });

  it('rejects a non-numeric group instead of substituting zero', () => {
    const f = compileExpression('$1 > 2');
    expect(() => f(['abc'])).toThrow(/abc/);
  });

  it('rejects an out-of-range group reference', () => {
    const f = compileExpression('$2 > 2');
    expect(() => f(['1'])).toThrow(/\$2/);
  });

  it('rejects division by zero', () => {
    const f = compileExpression('$1 / $2 > 1');
    expect(() => f(['1', '0'])).toThrow(/zero/);
  });

  it('never evaluates code', () => {
    expect(() => compileExpression('process.exit(1)')).toThrow();
    expect(() => compileExpression('require("fs")')).toThrow();
  });
});
