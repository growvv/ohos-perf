import { describe, it, expect } from 'vitest';
import { findSuspects } from '../src/source/suspects';
import { scanSourceFile } from '../src/source/scan';

/*
 * The rules read the shapes OhmBench records as root causes.
 *
 * Each test below is one defect shape taken from a real unfixed tree, reduced
 * to the smallest code that carries it. A rule that fires on the reduced form
 * and not on ordinary code is the whole requirement; a rule that fires on
 * everything is the failure mode this file exists to catch.
 */

const suspectsIn = (path: string, text: string) => findSuspects([scanSourceFile(path, text)]);

describe('rules', () => {
  it('flags order by random() in a SQL string', () => {
    const rows = suspectsIn('DbConst.ets', [
      'export class DbCRUDConst {',
      "  static readonly READ: string = 'select * from p order by random() limit 1'",
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['sql-order-by-random']);
    expect(rows[0]?.className).toBe('DbCRUDConst');
    expect(rows[0]?.symbol).toBe('READ');
  });

  it('flags a SQL string assembled from concatenation', () => {
    const rows = suspectsIn('DbConst.ets', [
      'export class DbCRUDConst {',
      '  static readonly READ: string =',
      "    'select * from ' + TABLE +",
      "      ' where id = (select p.id from p order by random() limit 1)'",
      '}',
    ].join('\n'));
    expect(rows[0]?.rule).toBe('sql-order-by-random');
  });

  it('flags a DELETE inside a row loop', () => {
    const rows = suspectsIn('RdbUtils.ets', [
      'export class RdbUtils {',
      '  async deleteAll(dates: string[]): Promise<void> {',
      '    for (const date of dates) {',
      '      const rs = await this.query(`SELECT id FROM ${date}`)',
      '      while (rs.goToNextRow()) {',
      '        await this.executeSql(`DELETE FROM ${date} WHERE id = 1`)',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('sql-statement-in-loop');
  });

  it('flags ForEach over a collection inside a List or Scroll', () => {
    const rows = suspectsIn('List.ets', [
      'export struct Page {',
      '  build() {',
      '    List() {',
      '      ForEach(this.items, (item: Item) => {',
      '        ListItem() { Text(item.name) }',
      '      })',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['eager-foreach']);
    expect(rows[0]?.symbol).toBe('build');
  });

  it('flags a network call inside onChange', () => {
    const rows = suspectsIn('Search.ets', [
      'export struct Page {',
      '  build() {',
      '    TextInput()',
      '      .onChange((keyword: string) => {',
      "        axios.get('http://x/search', { params: { keyword } })",
      '      })',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['network-in-onchange']);
  });

  it('does not flag a loop that only accumulates', () => {
    const rows = suspectsIn('a.ets', [
      'export class A {',
      '  sum(xs: number[]): number {',
      '    let total = 0',
      '    for (const x of xs) { total += x }',
      '    return total',
      '  }',
      '}',
    ].join('\n'));
    expect(rows).toEqual([]);
  });
});
