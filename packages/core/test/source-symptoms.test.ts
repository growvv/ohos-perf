import { describe, it, expect } from 'vitest';
import { findSuspects } from '../src/source/suspects';
import { scanSourceFile } from '../src/source/scan';
import { rankSuspects, type CasePrompt } from '../src/source/symptoms';

/*
 * A symptom is what the person with the device reports, and it is the only
 * thing a scan cannot read off the code: the same slow list is a different
 * defect depending on whether it is slow to open, slow to scroll, or leaks.
 * The prompt is part of the benchmark's blind input, so this is the input the
 * tool is supposed to use — a static scan with no symptom would be guessing
 * which of a tree's several real defects is the one being asked about.
 */

const files = (text: string, path = 'pages/Index.ets') => [scanSourceFile(path, text)];

const LIST_PAGE = [
  'export struct Page {',
  '  build() {',
  '    List() {',
  '      ForEach(this.items, (item: Item) => {',
  '        ListItem() { Text(item.name) }',
  '      })',
  '    }',
  '  }',
  '}',
].join('\n');

const SQL_FIELD = [
  'export class DbConst {',
  "  static readonly R: string = 'select * from t order by random() limit 1'",
  '}',
].join('\n');

describe('rankSuspects', () => {
  it('puts a list defect above a database defect when the symptom is a slow list', () => {
    const suspects = findSuspects([...files(LIST_PAGE), ...files(SQL_FIELD, 'DbConst.ets')]);
    const prompt: CasePrompt = { symptom: '打开列表时响应变慢。', perf_scenarios: ['列表滑动', '组件创建'] };
    const ranked = rankSuspects(suspects, prompt);
    expect(ranked[0]?.rule).toBe('eager-foreach');
  });

  it('puts a database defect above a list defect when the symptom is a slow query', () => {
    const suspects = findSuspects([...files(LIST_PAGE), ...files(SQL_FIELD, 'DbConst.ets')]);
    const prompt: CasePrompt = { symptom: '读取数据时响应变慢。', perf_scenarios: ['数据库读取'] };
    const ranked = rankSuspects(suspects, prompt);
    expect(ranked[0]?.rule).toBe('sql-order-by-random');
  });

  it('drops a rule that no symptom names', () => {
    const suspects = findSuspects([...files(LIST_PAGE), ...files(SQL_FIELD, 'DbConst.ets')]);
    const prompt: CasePrompt = { symptom: '打开列表时响应变慢。', perf_scenarios: ['列表滑动'] };
    const ranked = rankSuspects(suspects, prompt);
    expect(ranked.map((suspect) => suspect.rule)).toEqual(['eager-foreach']);
  });

  it('keeps the high-confidence suspects when nothing names a symptom', () => {
    // A prompt with no scenario is not evidence against anything: a reader who
    // gives no symptom still gets the findings whose shape is unambiguous.
    const suspects = findSuspects(files(SQL_FIELD, 'DbConst.ets'));
    const ranked = rankSuspects(suspects, {});
    expect(ranked.map((suspect) => suspect.rule)).toEqual(['sql-order-by-random']);
  });

  it('reads a memory symptom from the symptom text alone', () => {
    const leak = [
      'export class Client {',
      '  get() {',
      '    const request = http.createHttp()',
      "    return request.request('http://x')",
      '  }',
      '}',
    ].join('\n');
    const suspects = findSuspects([...files(LIST_PAGE), ...files(leak, 'W.ets')]);
    const ranked = rankSuspects(suspects, { symptom: '多次进出后应用内存持续升高。' });
    expect(ranked[0]?.rule).toBe('http-session-not-destroyed');
  });

  it('renumbers the survivors from one', () => {
    const suspects = findSuspects([...files(LIST_PAGE), ...files(SQL_FIELD, 'DbConst.ets')]);
    const ranked = rankSuspects(suspects, { perf_scenarios: ['列表滑动'] });
    expect(ranked.map((suspect) => suspect.rank)).toEqual([1]);
  });
});

describe('a prompt that names a screen', () => {
  const TREE = [
    'export struct ArticleListView {',
    '  build() { List() { ForEach(this.rows, (row: Row) => { ListItem() { Text(row.t) } }) } }',
    '}',
    'export struct ArticleReaderView {',
    '  build() { List() { ForEach(this.rows, (row: Row) => { ListItem() { Text(row.t) } }) } }',
    '}',
  ].join('\n');

  it('prefers the list over the reader when the symptom says 文章列表', () => {
    const suspects = findSuspects([scanSourceFile('ArticleListView.ets', TREE)]);
    const ranked = rankSuspects(suspects, { symptom: '打开文章列表时响应变慢。', perf_scenarios: ['列表滑动'] });
    expect(ranked[0]?.className).toBe('ArticleListView');
  });
});

describe('confidence outranks a shared name word', () => {
  /*
   * The shape that went wrong on OhmBench's feed-parser case. The symptom's
   * "刷新" reaches `FeedService.refreshFeed` through the glossary, so a
   * low-confidence sequential await on that method shares two prompt words
   * while the high-confidence findings share none — `FeedParser` and
   * `DatabaseManager` are not in the prompt at all. Narrowing by name first
   * discarded both high-confidence findings and answered with the wrong one.
   *
   * The real fix, and the one this test pins: a name match must not promote a
   * low-confidence finding over a high-confidence one.
   */
  const TREE = [
    'export class FeedService {',
    '  async refreshFeed(id: number): Promise<void> {',
    '    for (let i = 0; i < ids.length; i++) {',
    '      await this.db.insertArticle(articles[i]);',
    '    }',
    '  }',
    '}',
    'export class FeedParser {',
    '  extractTag(xml: string, tag: string): string {',
    "    const copy = xml.toLowerCase();",
    "    return copy.slice(copy.indexOf('<' + tag));",
    '  }',
    '}',
  ].join('\n');

  it('keeps the high-confidence finding the name match would have dropped', () => {
    const suspects = findSuspects([scanSourceFile('FeedService.ets', TREE)]);
    const ranked = rankSuspects(suspects, {
      symptom: '刷新订阅源时响应变慢。',
      perf_scenarios: ['数据库读取', '网络结果渲染'],
    });
    expect(ranked.map((suspect) => suspect.rule)).toContain('document-copy-per-call');
    expect(ranked[0]?.rule).not.toBe('sequential-await-loop');
  });

  it('still narrows to the name when nothing is high confidence', () => {
    // The tier is `high` only. A tree with nothing high-confidence keeps its
    // name match, because dropping to `medium` would narrow for no reason.
    const onlyLow = [
      'export struct ArticleListView {',
      '  build() { List() { ForEach(this.rows, (row: Row) => { ListItem() { Text(row.t) } }) } }',
      '}',
      'export struct SettingsView {',
      '  build() { List() { ForEach(this.rows, (row: Row) => { ListItem() { Text(row.t) } }) } }',
      '}',
    ].join('\n');
    const suspects = findSuspects([scanSourceFile('ArticleListView.ets', onlyLow)]);
    const ranked = rankSuspects(suspects, { symptom: '打开文章列表时响应变慢。', perf_scenarios: ['列表滑动'] });
    expect(ranked.map((suspect) => suspect.className)).toEqual(['ArticleListView']);
  });

  it('keeps the named screen even when a high-confidence finding sits elsewhere', () => {
    // The name filter answers *which question*; confidence answers *which
    // answer within it*. A code review argued the tier should run first, so a
    // high-confidence finding on a different screen would survive a symptom
    // that names one. Measured on OhmBench that is wrong: it costs three cases
    // and drops precision 0.857 -> 0.738, recall 0.929 -> 0.833. A
    // high-confidence defect on a screen the user did not name is a good
    // answer to a question nobody asked, and the low-confidence finding on the
    // named screen is the answer they did ask for.
    const tree = [
      'export struct ArticleListView {',
      '  build() { List() { ForEach(this.rows, (row: Row) => { ListItem() { Text(row.t) } }) } }',
      '}',
    ].join('\n');
    const db = [
      'export class DbConst {',
      "  static readonly R: string = 'select * from t order by random() limit 1'",
      '}',
    ].join('\n');
    const suspects = findSuspects([scanSourceFile('ArticleListView.ets', tree), scanSourceFile('DbConst.ets', db)]);
    const ranked = rankSuspects(suspects, { symptom: '打开文章列表时响应变慢。', perf_scenarios: ['列表滑动', '页面启动'] });
    expect(ranked.map((suspect) => suspect.rule)).toEqual(['eager-foreach']);
  });
});
