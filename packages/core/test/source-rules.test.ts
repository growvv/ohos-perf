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
    // One symbol, one suspect: the write loop and the SQL loop are the same
    // finding about the same code, and the sharper rule names the cost.
    expect(rows).toHaveLength(1);
    expect(['db-write-in-loop', 'sql-statement-in-loop']).toContain(rows[0]?.rule);
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
      '  static normalizeTag(name: string): string {',
      '    return name.toLowerCase()',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('repeated-expensive-conversion');
  });

  it('ranks a whole-document copy above a field conversion', () => {
    // `xml.toLowerCase()` copies the entire article; `keyword.toLowerCase()`
    // copies a search box's contents. Both are the same call, and only one of
    // them is worth a reader's attention.
    const rows = suspectsIn('P.ets', [
      'export class FeedParser {',
      '  static extractTag(xml: string): string {',
      '    return xml.toLowerCase()',
      '  }',
      '  static search(keyword: string): string {',
      '    return keyword.toLowerCase()',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['document-copy-per-call', 'repeated-expensive-conversion']);
    expect(rows[0]?.confidence).toBe('high');
  });

  it('flags an unbounded persistProp list', () => {
    const rows = suspectsIn('Home.ets', [
      'PersistentStorage.persistProp<Data[]>("homeList", [])',
      'export struct HomePage {}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('persistent-storage-unbounded');
  });

  it('reports each persisted list on its own line, not line 1', () => {
    // Three lists in one module scope are three separate findings. A single
    // report at line 1 points a reader at the imports.
    const rows = suspectsIn('Home.ets', [
      "import { A } from './a'",
      '',
      'PersistentStorage.persistProp<Banner[]>("bannerList", [])',
      'PersistentStorage.persistProp<Data[]>("homeTopList", [])',
      'PersistentStorage.persistProp<Data[]>("homeList", [])',
      'export struct HomePage {}',
    ].join('\n'));
    expect(rows.map((row) => row.lineStart)).toEqual([3, 4, 5]);
    expect(rows[2]?.description).toContain('"homeList"');
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

  it('flags a SQL string whose identifier sits on its own continuation line', () => {
    // The same statement as the concatenation test above, reformatted so the
    // table reference is a line of its own. Nothing about the defect changed;
    // a rule that read only quote-leading continuation lines saw half a
    // statement and missed it.
    const rows = suspectsIn('DbConst.ets', [
      'export class DbCRUDConst {',
      '  static readonly READ: string =',
      "    'select * from ' +",
      '    DbTableConst.ClassicPoemTable +',
      "    ' where id = (select p.id from p order by random() limit 1)'",
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('sql-order-by-random');
  });

  it('does not count a loop shape inside a string literal', () => {
    // A string is not a loop. The text of one used to satisfy the loop and the
    // database-call tests together, so a log line or a template describing a
    // query was reported as a query running per iteration.
    const rows = suspectsIn('RdbUtils.ets', [
      'export class RdbUtils {',
      '  describe(rows: Row[]) {',
      '    const text = "for (const row of rows) { db.insert(row); }"',
      '    return text',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).not.toContain('sql-statement-in-loop');
  });

  it('flags an unbounded store even when an unrelated class is bounded', () => {
    // The cap has to belong to the store it caps. An `ImageCache` that trims
    // itself says nothing about whether a history store grows without bound,
    // and treating it as if it did hid a real finding.
    const rows = suspectsIn('history.ets', [
      'export class HistoryStore {',
      '  save(keyword: string) {',
      '    this.pref.putSync(keyword, keyword)',
      '  }',
      '}',
      'export class ImageCache {',
      '  maxItems: number = 100',
      '  trim() { this.items.splice(0, 10) }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('unbounded-accumulation');
  });

  it('flags an undestroyed HTTP session even when another class destroys something', () => {
    // `image.destroy()` is not the HTTP session's cleanup. Searching the whole
    // file let any unrelated `destroy()` suppress the finding.
    const rows = suspectsIn('ApiClient.ets', [
      'export class ApiClient {',
      '  request() {',
      '    const http = http.createHttp()',
      '    return http.request(url)',
      '  }',
      '}',
      'export class ImageHolder {',
      '  release() { this.image.destroy() }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('http-session-not-destroyed');
  });

  it('does not call a read through executeSql a database write', () => {
    // `executeSql` is a generic executor: it runs whatever string it is given.
    // Treating its presence as a write reported a SELECT inside a loop as a
    // write per iteration.
    const rows = suspectsIn('RdbUtils.ets', [
      'export class RdbUtils {',
      '  load(dates: string[]) {',
      '    for (const date of dates) {',
      "      this.executeSql('select * from ' + date)",
      '    }',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).not.toContain('db-write-in-loop');
  });

  it('flags a schema change executed once per table', () => {
    // `DROP TABLE` inside the loop is a write, and it is the shape that used
    // to be hidden: the `${date}` in the template literal's braces closed the
    // loop counter, so the executor on the next line read as outside the loop.
    const rows = suspectsIn('RdbUtils.ets', [
      'export class RdbUtils {',
      '  deleteAll(dates: string[]) {',
      '    dates.forEach((date: string) => {',
      '      this.executeSql(`DROP TABLE IF EXISTS ${date}`)',
      '    })',
      '  }',
      '}',
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toContain('db-write-in-loop');
  });

  it('reports two identical module statements on their own lines', () => {
    // Two `persistProp` calls for the same key are two statements. The line was
    // recovered with `lines.indexOf(text)`, which always finds the first copy,
    // so both findings named line 1.
    const rows = suspectsIn('Index.ets', [
      "PersistentStorage.persistProp('items', [])",
      "PersistentStorage.persistProp('items', [])",
    ].join('\n'));
    expect(rows.map((row) => row.rule)).toEqual(['persistent-storage-unbounded', 'persistent-storage-unbounded']);
    expect(rows.map((row) => row.lineStart)).toEqual([1, 2]);
  });
});
