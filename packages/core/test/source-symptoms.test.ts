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
