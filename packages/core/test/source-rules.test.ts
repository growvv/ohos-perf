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

describe('the remaining rules, one per defect shape the benchmark records', () => {
  it('flags a state write inside a timeUpdate callback', () => {
    const rows = suspectsIn('P.ets', [
      'export class AVPlayerUtils {',
      '  play(): void {',
      "    this.player.on('timeUpdate', (time: number) => {",
      '      AppStorage.setOrCreate(StorageConstants.PLAY_TIME, time)',
      '    })',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('ui-state-high-frequency');
  });

  it('flags an awaited insert inside forEach', () => {
    const rows = suspectsIn('D.ets', [
      'export class Import {',
      '  async run(items: Item[]): Promise<void> {',
      '    items.forEach(async (item: Item) => {',
      "      await this.dao.insert('t', item)",
      '    })',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('db-write-in-loop');
  });

  it('flags a sequential await in a for loop', () => {
    const rows = suspectsIn('S.ets', [
      'export class FeedService {',
      '  async refresh(feeds: Feed[]): Promise<void> {',
      '    for (const feed of feeds) {',
      '      await this.refreshOne(feed.id)',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('sequential-await-loop');
  });

  it('flags toLowerCase inside a per-item helper', () => {
    const rows = suspectsIn('P.ets', [
      'export class FeedParser {',
      '  static extractTag(xml: string): string {',
      '    return xml.toLowerCase()',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('repeated-expensive-conversion');
  });

  it('flags an unbounded persistProp list', () => {
    const rows = suspectsIn('Home.ets', [
      'PersistentStorage.persistProp<Data[]>("homeList", [])',
      'export struct HomePage {}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('persistent-storage-unbounded');
  });

  it('flags an unbounded preference store', () => {
    const rows = suspectsIn('history.ets', [
      'export class HistoryStore {',
      '  setItem(keyword: string) {',
      '    this.store.putSync(keyword, keyword)',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('unbounded-accumulation');
  });

  it('flags a per-instance font family', () => {
    const rows = suspectsIn('F.ets', [
      'export class PageTitleFont {',
      '  static register(): string {',
      "    const family = 'PageTitle-' + util.generateRandomUUID()",
      "    font.registerFont({ familyName: family, familySrc: $rawfile('f.ttf') })",
      '    return family',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('font-register-per-instance');
  });

  it('flags an http session that is never destroyed', () => {
    const rows = suspectsIn('W.ets', [
      'export class getWeatherUtil {',
      '  getWeather(code: number) {',
      '    const request = http.createHttp()',
      "    return request.request('http://x')",
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('http-session-not-destroyed');
  });

  it('does not flag an http session that is destroyed', () => {
    const rows = suspectsIn('W.ets', [
      'export class Client {',
      '  get(code: number) {',
      '    const request = http.createHttp()',
      "    request.destroy()",
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).not.toContain('http-session-not-destroyed');
  });

  it('does not flag a bounded preference store that deletes', () => {
    const rows = suspectsIn('history.ets', [
      'export class HistoryStore {',
      '  setItem(keyword: string) {',
      '    if (this.getAll().length > 20) this.delItem(keyword)',
      '    this.store.putSync(keyword, keyword)',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).not.toContain('unbounded-accumulation');
  });
});
