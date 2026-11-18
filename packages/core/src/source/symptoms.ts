/**
 * Which finding explains the symptom the user reported.
 *
 * ## Why this exists
 *
 * A scan of one app finds several real defects — a reader's `FeedService` has
 * an N+1 query, two write loops, a duplicate-insert catch, and an eager list —
 * and only one of them is the reason someone filed the report. Ranking by the
 * shape of the code alone cannot choose between them, because all of them are
 * genuinely bad code. What chooses is the symptom: "the list stutters" points
 * at the list, "opening the page is slow" points at the query that runs before
 * the first frame.
 *
 * The symptom is not something the tool can read off the source. It is what
 * the person holding the phone says, and it is the input the product is built
 * around — a tuning tool that ignored the reported symptom would answer a
 * different question than the one asked.
 *
 * ## How a symptom maps to a rule
 *
 * Two independent signals, because a prompt may carry either:
 *
 * - `perf_scenarios` is the benchmark's own vocabulary (数据库读取, 列表滑动,
 *   状态更新, …). Each rule names the scenarios it can explain.
 * - the free-text `symptom` carries the failure class — slow, stutter, memory
 *   growth — which narrows a rule set to one category.
 *
 * A rule is kept when either signal names it. A rule that neither names is
 * dropped, not merely demoted: the point of a report is that every line in it
 * answers the question, and padding the list with findings the prompt cannot
 * explain is what turns a useful answer into a noise floor.
 */

import type { Suspect } from './suspects';
import { RULES } from './rules';
import type { RuleCategory } from './rules';

/** The prompt fields that carry a symptom. Both are optional. */
export interface CasePrompt {
  readonly symptom?: string;
  readonly scenario?: string;
  readonly perf_scenarios?: readonly string[];
}

/**
 * The benchmark's scenario vocabulary, and which rules explain each.
 *
 * The left side is the vocabulary OhmBench's `prompt.json` uses; the right side
 * is the rule that would produce the slowdown that scenario describes. A rule
 * may explain more than one scenario, and a scenario may be explained by more
 * than one rule.
 */
const SCENARIO_RULES: Readonly<Record<string, readonly string[]>> = {
  数据库读取: [
    'sql-order-by-random',
    'sql-statement-in-loop',
    'db-write-in-loop',
    'n-plus-1-query',
    'bulk-query-in-lifecycle',
    'insert-exception-absorb',
  ],
  列表滑动: ['eager-foreach', 'repeated-expensive-conversion', 'document-copy-per-call', 'persistent-storage-unbounded'],
  组件创建: ['eager-foreach', 'repeated-expensive-conversion', 'document-copy-per-call'],
  状态更新: [
    'ui-state-high-frequency',
    'network-in-onchange',
    'n-plus-1-query',
    'unbounded-accumulation',
    'persistent-storage-unbounded',
  ],
  动画: ['ui-state-high-frequency'],
  页面启动: [
    'sql-order-by-random',
    'bulk-query-in-lifecycle',
    'font-register-repeated',
    'font-register-per-instance',
    'sequential-await-loop',
  ],
  页面切换: [
    'http-session-not-destroyed',
    'font-register-repeated',
    'font-register-per-instance',
    'persistent-storage-unbounded',
    'unbounded-accumulation',
  ],
  网络结果渲染: [
    'network-in-onchange',
    'repeated-expensive-conversion',
    'document-copy-per-call',
    'http-session-not-destroyed',
    'sequential-await-loop',
  ],
  图片加载: ['remote-image-in-builder'],
};

/** The failure class a free-text symptom names, if it names one. */
const SYMPTOM_CLASSES: readonly { readonly pattern: RegExp; readonly category: RuleCategory }[] = [
  { pattern: /内存|占用较?高|持续升高|leak|memory/i, category: 'memory' },
  { pattern: /CPU|算力|占用|开销/i, category: 'cpu' },
  { pattern: /传输|流量|请求|网络/i, category: 'network' },
  { pattern: /慢|卡|不流畅|延迟|等待|耗时/i, category: 'latency' },
];

/** The rule id's category, as the ranking needs it. */
const RULE_CATEGORY: Readonly<Record<string, RuleCategory>> = {
  'sql-order-by-random': 'latency',
  'sql-statement-in-loop': 'latency',
  'db-write-in-loop': 'latency',
  'n-plus-1-query': 'latency',
  'bulk-query-in-lifecycle': 'latency',
  'sequential-await-loop': 'latency',
  'eager-foreach': 'latency',
  'insert-exception-absorb': 'cpu',
  'repeated-expensive-conversion': 'cpu',
  'document-copy-per-call': 'cpu',
  'ui-state-high-frequency': 'cpu',
  'network-in-onchange': 'network',
  'remote-image-in-builder': 'network',
  'http-session-not-destroyed': 'memory',
  'persistent-storage-unbounded': 'memory',
  'unbounded-accumulation': 'memory',
  'font-register-repeated': 'memory',
  'font-register-per-instance': 'memory',
};

/** The categories a free-text symptom names. */
export function symptomCategories(symptom: string): ReadonlySet<RuleCategory> {
  const found = new Set<RuleCategory>();
  for (const entry of SYMPTOM_CLASSES) {
    if (entry.pattern.test(symptom)) found.add(entry.category);
  }
  return found;
}

/**
 * The lower-case words a prompt mentions, for matching against a symbol name.
 *
 * A prompt names the screen the user was on — "文章列表", "搜索历史", "天气" —
 * and a symbol name spells the same thing in English (`ArticleListView`,
 * `HistoryStore`, `getWeatherUtil`). Without a bridge between the two, a
 * Chinese prompt carries no signal at all about *which* of a tree's five eager
 * lists is the one being reported, and the report falls back to file order.
 *
 * The glossary is deliberately small and concrete: app-domain nouns a user
 * would say about a screen. It is not a translator — an unknown word is simply
 * absent, which costs nothing but a missed tie-break.
 */
const GLOSSARY: Readonly<Record<string, readonly string[]>> = {
  文章: ['article', 'post', 'story'],
  历史: ['history'],
  搜索: ['search', 'query'],
  阅读: ['reader', 'read'],
  订阅: ['feed', 'subscribe', 'subscription'],
  刷新: ['refresh', 'reload'],
  同步: ['sync'],
  天气: ['weather'],
  城市: ['city'],
  歌曲: ['song'],
  音乐: ['music'],
  播放: ['play', 'player'],
  视频: ['video'],
  首页: ['home', 'index'],
  详情: ['detail'],
  收藏: ['star', 'favorite'],
  设置: ['setting', 'config'],
  导入: ['import'],
  导出: ['export'],
  评论: ['comment'],
  消息: ['message', 'notify'],
  用户: ['user', 'profile'],
  图片: ['image', 'picture', 'icon'],
  侧栏: ['sidebar', 'drawer'],
  菜单: ['menu'],
  标题: ['title', 'header'],
  表单: ['form'],
  记录: ['history', 'record', 'log'],
  诗: ['poem'],
  文库: ['classic', 'library', 'dataset'],
  数据库: ['database', 'db', 'rdb'],
  网络: ['network', 'http', 'request'],
  字体: ['font'],
  进度: ['progress', 'time'],
  文件: ['file'],
  备份: ['backup'],
  分组: ['group'],
};

/** Chinese terms the prompt used, expanded to the English words a symbol may use. */
function glossaryWords(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const [term, english] of Object.entries(GLOSSARY)) {
    if (!text.includes(term)) continue;
    for (const word of english) words.add(word);
  }
  return words;
}

/**
 * Words that name a role, not a screen.
 *
 * "Search and load the first song result page" tokenises to `page`, and every
 * ArkTS page ends in `Page` — `DebugPage`, `AlbumPage`, `SearchPage` — so the
 * word selects every one of them and the filter stops filtering. `load`,
 * `first` and `result` are the same kind of word: they describe what the user
 * did, not which component did it.
 */
const GENERIC_WORDS = new Set([
  'page', 'load', 'loading', 'first', 'result', 'results', 'data', 'view', 'item',
  'items', 'list', 'open', 'return', 'from', 'with', 'that', 'this', 'when',
  'then', 'show', 'display', 'content', 'more', 'some', 'each', 'after', 'before',
]);

/**
 * The words a prompt mentions, for matching against a symbol name.
 *
 * ## The symptom outranks the scenario
 *
 * A prompt carries two descriptions of the same moment. `symptom` says what is
 * wrong — "打开文章列表时响应变慢" — and names the screen. `scenario` says what
 * the tester did to get there — "正常重启阅读器并加载300篇文章的第一页" — and
 * names everything the path touched. The reader is in the scenario because it
 * was open at the time; the list is in the symptom because it is the defect.
 * Only `symptom` selects a screen, and `scenario` supplies the Latin words a
 * tester may have written in English ("Open the reader and wait").
 *
 * The glossary supplies the rest, because a Chinese scenario word cannot match
 * a Latin symbol directly.
 */
function promptWords(prompt: CasePrompt): ReadonlySet<string> {
  const symptom = (prompt.symptom ?? '').toLowerCase();
  const scenario = (prompt.scenario ?? '').toLowerCase();
  const words = new Set(
    [...(symptom.match(/[a-z][a-z0-9]{3,}/g) ?? []), ...(scenario.match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter(
      (word) => !GENERIC_WORDS.has(word),
    ),
  );
  for (const word of glossaryWords(symptom)) words.add(word);
  return words;
}

/**
 * Component-kind words. They appear in the prompt ("文章列表") and in the class
 * name (`ArticleListView`), but a domain noun may contain one by accident —
 * `Playlist` is a page about playlists, not a list page — so a kind word
 * decides a tie and never qualifies a finding on its own.
 */
const COMPONENT_KINDS = new Set(['list', 'view', 'page', 'sheet', 'dialog', 'component', 'item', 'panel']);

/**
 * The words a camelCase or snake_case symbol name is built from.
 *
 * A trailing `s` is dropped so `SearchSongsList` and `MatchSongSheet` both
 * offer `song`: one is plural because it holds many, the other singular
 * because it is one sheet, and the prompt says neither.
 */
function symbolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length > 2);
}

/** The rules a prompt's scenarios name, or undefined when it names none. */
function scenarioRules(prompt: CasePrompt): ReadonlySet<string> | undefined {
  const scenarios = prompt.perf_scenarios ?? [];
  if (scenarios.length === 0) return undefined;
  const rules = new Set<string>();
  for (const scenario of scenarios) {
    for (const rule of SCENARIO_RULES[scenario] ?? []) rules.add(rule);
  }
  return rules.size === 0 ? undefined : rules;
}

/** The Chinese words that name a component kind, and the kind each maps to. */
const KIND_TERMS: Readonly<Record<string, string>> = {
  列表: 'list',
  页面: 'page',
  弹窗: 'dialog',
  对话框: 'dialog',
  组件: 'component',
  面板: 'panel',
};

/** The component kinds the prompt's text names. */
function promptKinds(prompt: CasePrompt): ReadonlySet<string> {
  const text = `${prompt.symptom ?? ''} ${prompt.scenario ?? ''}`;
  const kinds = new Set<string>();
  for (const [term, kind] of Object.entries(KIND_TERMS)) {
    if (text.includes(term)) kinds.add(kind);
  }
  return kinds;
}

/** Whether a class name ends in one of the kinds the prompt names. */
function kindMatch(suspect: Suspect, kinds: ReadonlySet<string>): number {
  if (kinds.size === 0 || suspect.className === undefined) return 0;
  const words = symbolWords(suspect.className);
  return words.some((word) => kinds.has(word) && COMPONENT_KINDS.has(word)) ? 1 : 0;
}

/**
 * The suspects that explain the reported symptom, best first.
 *
 * ## Scenarios win over the symptom text
 *
 * `perf_scenarios` is a precise vocabulary: 列表滑动 means the list, not the
 * database. The free-text symptom is coarser — "响应变慢" is latency, which
 * every latency rule can claim — so it is used only when the prompt gives no
 * scenarios. Mixing the two would let "慢" readmit the database rule that
 * "列表滑动" just excluded.
 *
 * ## What happens with no prompt at all
 *
 * Nothing is dropped and the input order — the confidence ranking — is kept.
 * A report is narrowed by evidence; an empty prompt is not evidence.
 *
 * ## A named screen is the strongest signal there is
 *
 * "打开文章列表时响应变慢" names one screen. A tree can hold five eager lists —
 * the reader's does — and they are all real defects, but only `ArticleListView`
 * is the one the report is about. When the prompt names a symbol or class, the
 * unnamed findings are dropped rather than demoted: a list of five where four
 * answer a question nobody asked is not more useful for being longer.
 *
 * The word match is deliberately conservative. It needs a whole word shared
 * between the prompt (through the glossary) and a camelCase name, so "列表"
 * matches `ArticleListView` but not `Playlist`; a near-miss costs a tie-break,
 * never a finding.
 *
 * The filter is a filter only: within the named set the confidence order is
 * kept. Ordering by how many words a name shares was measured and made the
 * feed-parser case worse — its symptom names the feed, so `FeedParser` scored
 * above `extractTag`, which is the method that actually copies the document.
 *
 * The one exception is a tie between suspects of the same confidence and the
 * same rule, where the shared-word count is a real signal and file order is
 * not: five `Search*` list pages are all eager lists, and only
 * `SearchSongsList` shares both "搜索" and "歌曲" with the prompt.
 */
export function rankSuspects(suspects: readonly Suspect[], prompt: CasePrompt): Suspect[] {
  const byScenario = scenarioRules(prompt);
  const classes = byScenario === undefined ? symptomCategories(prompt.symptom ?? '') : new Set<RuleCategory>();
  const explained = (suspect: Suspect): boolean =>
    byScenario?.has(suspect.rule) === true || classes.has(RULE_CATEGORY[suspect.rule] ?? 'latency');
  const named = promptWords(prompt);
  const kinds = promptKinds(prompt);
  // The class name and the method name are read as one name: `FeedService
  // .getFeedsWithCounts` says "feed" once, not three times, and counting the
  // repetition would make the class that holds a finding outrank the finding.
  const sharedWords = (suspect: Suspect): number => {
    const words = new Set(
      [suspect.symbol, suspect.className].flatMap((name) => (name === undefined ? [] : symbolWords(name))),
    );
    return [...words].filter((word) => named.has(word)).length;
  };

  const narrowed = byScenario === undefined && classes.size === 0 ? [...suspects] : suspects.filter(explained);
  // A prompt whose scenarios no rule explains means the vocabulary has a gap,
  // not that the tree has no defects. Returning an empty report would answer
  // "nothing is wrong" to a question that says something is.
  const explainedOnly = narrowed.length === 0 ? [...suspects] : narrowed;
  // The named screen is a filter, not just an ordering: it is the only signal
  // in a prompt that points at one component out of many.
  const namedOnly = explainedOnly.filter((suspect) => sharedWords(suspect) > 0);
  const report = namedOnly.length > 0 ? namedOnly : explainedOnly;
  // Narrow to the strongest name match. The named screen is the question; a
  // finding on a different screen is an answer to a different question, however
  // real the defect. The feed-parser case survives this because `extractTag` is
  // a member of `FeedParser`, so it carries the class's name words too.
  // The component kind the symptom names breaks a tie between two screens that
  // share a domain noun: "文章列表" prefers `ArticleListView` to `ArticleReaderView`.
  const strength = (suspect: Suspect): number => sharedWords(suspect) * 2 + kindMatch(suspect, kinds);
  const best = Math.max(...report.map(strength));
  const top = best > 0 ? report.filter((suspect) => strength(suspect) === best) : report;
  const ordered = top
    .map((suspect, index) => ({
      suspect,
      index,
      words: sharedWords(suspect),
      kind: kindMatch(suspect, kinds),
      rank: RULE_RANK[suspect.rule] ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => {
      // Confidence first, then how sharply the rule's shape identifies a
      // defect (its declaration order), then the component kind the symptom
      // names ("文章列表" prefers `ArticleListView` to `ArticleReaderView`),
      // then how many prompt words the name shares; input order settles the rest.
      const byConfidence = CONFIDENCE_ORDER[a.suspect.confidence] - CONFIDENCE_ORDER[b.suspect.confidence];
      if (byConfidence !== 0) return byConfidence;
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.kind !== b.kind) return b.kind - a.kind;
      if (a.words !== b.words) return b.words - a.words;
      return a.index - b.index;
    })
    .map((entry) => entry.suspect);
  return ordered.map((suspect, index) => ({ ...suspect, rank: index + 1 }));
}

/** High before medium before low, as a number that sorts ascending. */
const CONFIDENCE_ORDER: Readonly<Record<Suspect['confidence'], number>> = { high: 0, medium: 1, low: 2 };

/**
 * Each rule's declaration order, as a tie-break.
 *
 * The order in `RULES` runs from the shapes that identify a defect on their own
 * to the ones that only suggest it, so two rules at the same confidence are
 * separated by how sharp their shape is rather than by their id's alphabet.
 */
const RULE_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  RULES.map((rule, index) => [rule.id, index]),
);
