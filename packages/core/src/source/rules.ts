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
  /**
   * The description of each place the rule fires, or undefined if it does not.
   *
   * A rule usually fires once per symbol, but a module scope is not a symbol:
   * `PersistentStorage.persistProp('a', [])` three times in one file is three
   * separate lists that each grow without a bound, and reporting one of them
   * would point a reader at the wrong line.
   */
  match(facts: SourceFacts): string | readonly string[] | undefined;
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
    // Low on purpose. Measured over the benchmark's nine apps, this rule fires
    // on eight of them: an eager list is a style the whole ecosystem shares,
    // not a defect a single tree can be told apart by. A reader gets it after
    // the rules whose shape is unusual.
    confidence: 'low',
    match(facts) {
      const body = facts.symbol.body;
      if (!/ForEach\s*\(/.test(body)) return undefined;
      // LazyForEach is the fix; its presence means the list is already virtual.
      if (/LazyForEach\s*\(/.test(body)) return undefined;
      if (!/List\s*\(|Scroll\s*\(|Grid\s*\(|WaterFlow\s*\(/.test(body)) return undefined;
      // A `ForEach` over a collection with a per-item component is the eager
      // list; one over a literal or a key list is not. Require a member
      // expression as the data source, which is what every real case has.
      if (!/ForEach\s*\(\s*(this\.|[\w$]+\.[\w$]+)/.test(body)) return undefined;
      return `every row is built up front, including the ones off screen: ${firstMatch(body, /ForEach\s*\(/)!}`;
    },
  },
  {
    id: 'bulk-query-in-lifecycle',
    category: 'latency',
    confidence: 'high',
    match(facts) {
      // `allDate.forEach(async date => … query(date))` in aboutToAppear: the
      // page issues one query per day of history before it can render, and
      // the results are awaited inside a forEach, so nothing is batched.
      if (!/aboutToAppear|onPageShow|aboutToReuse/.test(facts.symbol.symbol)) return undefined;
      const body = facts.symbol.body;
      if (!/forEach\s*\(\s*async/.test(body)) return undefined;
      if (!/await\s+[\w$.]*(query|select|load|fetch|read)\w*\s*\(/i.test(body)) return undefined;
      return `the page runs one query per item before it can render: ${firstMatch(body, /forEach\s*\(\s*async/)!}`;
    },
  },
  {
    id: 'insert-exception-absorb',
    category: 'cpu',
    confidence: 'high',
    match(facts) {
      // `try { await store.insert(...) } catch { /* duplicate, ignore */ }`:
      // every refresh re-attempts every row and pays the cost of the exception
      // that follows. The fix is to query first or to use a conflict clause.
      const body = facts.symbol.body;
      if (!/insert\s*\(/.test(body)) return undefined;
      const catchBlock = /catch\s*(?:\([^)]*\))?\s*\{[^}]*\}/s.exec(body);
      if (catchBlock === null) return undefined;
      if (!/duplicate|ignore|already exists|constraint/i.test(catchBlock[0])) return undefined;
      return `a duplicate insert is detected by letting the constraint fail and catching it: ${firstMatch(body, /insert\s*\(/)!}`;
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
  {
    id: 'ui-state-high-frequency',
    category: 'cpu',
    confidence: 'high',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let inCallback = false;
      for (const line of lines) {
        // `timeUpdate` fires about ten times a second; a state write inside it
        // re-renders the bound view at that rate.
        if (/['"]timeUpdate['"]|timeUpdate\s*\(/.test(line)) inCallback = true;
        if (inCallback && /AppStorage\.setOrCreate|@State\s|this\.\w+\s*=\s*(time|position|progress)/.test(line)) {
          return `a high-frequency playback callback writes bound state, re-rendering the view: ${line.trim()}`;
        }
        if (inCallback && /^\s*\}\)\s*$/.test(line)) inCallback = false;
      }
      return undefined;
    },
  },
  {
    id: 'db-write-in-loop',
    category: 'latency',
    confidence: 'high',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let loopDepth = 0;
      for (const line of lines) {
        if (LOOP.test(line) && line.includes('{')) loopDepth += 1;
        if (loopDepth > 0 && /\.(insert|update|delete)\s*\(|executeSql\s*\(/.test(line)) {
          return `a database write runs once per iteration, each in its own transaction: ${line.trim()}`;
        }
        if (line.includes('}')) loopDepth = Math.max(0, loopDepth - 1);
      }
      return undefined;
    },
  },
  {
    id: 'n-plus-1-query',
    category: 'latency',
    confidence: 'high',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let loopDepth = 0;
      for (const line of lines) {
        if (LOOP.test(line) && line.includes('{')) loopDepth += 1;
        // One read per row of a list already in memory. The fix is a grouped
        // query; the cost is a query round trip per item. The read has to name
        // a count or a single-row lookup — a write loop is a different rule,
        // and a bulk read outside the loop is not this defect at all.
        if (loopDepth > 0 && /await\s+this\.\w+\.(getUnreadCount|getCount|count|findById|getById|queryById)\s*\(/i.test(line)) {
          return `one query per row, where a single grouped query would do: ${line.trim()}`;
        }
        if (line.includes('}')) loopDepth = Math.max(0, loopDepth - 1);
      }
      return undefined;
    },
  },
  {
    id: 'sequential-await-loop',
    category: 'latency',
    // Low on purpose: an await inside a loop is everywhere, and only the ones
    // that cross a network or a database boundary cost anything worth naming.
    // The sharper n-plus-1 rule covers those; this one catches the rest and
    // ranks below them.
    confidence: 'low',
    match(facts) {
      const lines = facts.symbol.body.split('\n');
      let loopDepth = 0;
      for (const line of lines) {
        if (LOOP.test(line) && line.includes('{')) loopDepth += 1;
        // An await on `this.` inside a loop is one round trip per item, run
        // one after the other; the fix is to collect and await together. A
        // database read is the sharper N+1 case and is scored above this one,
        // so this fires on everything else.
        if (loopDepth > 0 && /await\s+this\./.test(line) && !/await\s+this\.\w*\.?\w*(get|query|count|find|read)\w*\s*\(/i.test(line)) {
          return `each iteration waits for the previous one to finish: ${line.trim()}`;
        }
        if (line.includes('}')) loopDepth = Math.max(0, loopDepth - 1);
      }
      return undefined;
    },
  },
  {
    id: 'repeated-expensive-conversion',
    category: 'cpu',
    // Low on purpose when the conversion is on an ordinary value. `value
    // .toLowerCase()` is what a search box does once per keystroke, and the
    // rule measured over the benchmark's nine apps fires on seven of them —
    // an ecosystem-wide style, not a defect a tree can be told apart by.
    // The one shape that *is* separable is the copy of a whole document:
    // `xml.toLowerCase()` in a feed parser allocates the entire article per
    // call, and over the same nine apps exactly one symbol does it.
    confidence: 'low',
    match(facts) {
      const body = facts.symbol.body;
      const conversion = /\.toLowerCase\s*\(|\.toUpperCase\s*\(|JSON\.parse\s*\(/.exec(body);
      if (conversion === null) return undefined;
      const line = firstMatch(body, /\.toLowerCase\s*\(|\.toUpperCase\s*\(|JSON\.parse\s*\(/)!;
      const inLoop = /for\s*\(|while\s*\(|forEach\s*\(/.test(body);
      return inLoop
        ? `a full copy of the input is made once per iteration: ${line}`
        : `a full copy of the input is made on every call, which the caller repeats per item: ${line}`;
    },
  },
  {
    id: 'document-copy-per-call',
    category: 'cpu',
    // A whole-document copy that is *not* what the operation is for. `JSON.parse`
    // of a JSON payload is ordinary code — it has to read the whole thing, and
    // measured over the benchmark it appears ten times in one tree. A case
    // conversion of a document is different: the caller wanted a tag name or a
    // field, and the code copies the entire article to get it. That shape
    // appears exactly once across the nine apps.
    confidence: 'high',
    match(facts) {
      const body = facts.symbol.body;
      const copy =
        /\b(xml|html|body|payload|document|feedText|articleText)\s*\.\s*(?:toLowerCase|toUpperCase)\s*\(/i.exec(body);
      if (copy === null) return undefined;
      return `the whole input document is copied to read one field from it: ${copy[0]}`;
    },
  },
  {
    id: 'persistent-storage-unbounded',
    category: 'memory',
    confidence: 'medium',
    match(facts) {
      // Module scope only: `persistProp` is a top-level statement. Running this
      // over every symbol as well would report the same statement once per
      // member of the file, burying the real findings under duplicates.
      if (facts.symbol.symbol !== '') return undefined;
      const pattern = /PersistentStorage\.persistProp\s*(?:<[^(]*>)?\s*\(\s*['"]([^'"]+)['"]\s*,\s*\[[^\]]*\]\s*\)/g;
      const descriptions: string[] = [];
      for (const match of facts.moduleText.matchAll(pattern)) {
        // The description ends with the statement it matched: a module-level
        // hit has no symbol to point at, so the line is found by searching for
        // the text. Without it the report would name line 1 of the file.
        descriptions.push(
          `the whole list is persisted under "${match[1]}", so it grows with every page loaded: ${match[0]}`,
        );
      }
      return descriptions.length === 0 ? undefined : descriptions;
    },
  },
  {
    id: 'unbounded-accumulation',
    category: 'memory',
    confidence: 'medium',
    match(facts) {
      const body = facts.symbol.body;
      if (!/(putSync|setSync)\s*\(/.test(body)) return undefined;
      // A store is bounded only if something *limits* it: a size check before
      // the write, or a trim/evict call. A `delItem` method that exists but is
      // only ever reached from a user action does not bound anything — the
      // benchmark's store has exactly that shape, and its root cause is the
      // absence of a cap.
      const wholeFile = facts.file.lines.join('\n');
      if (/length\s*[><]=?|size\s*[><]=?|slice\s*\(|splice\s*\(|trim|evict|maxItems|limit/i.test(wholeFile)) return undefined;
      const line = firstMatch(body, /(putSync|setSync)\s*\(/)!;
      return `every value is persisted under its own key and nothing caps the number of keys: ${line}`;
    },
  },
  {
    id: 'font-register-repeated',
    category: 'memory',
    confidence: 'high',
    match(facts) {
      const body = facts.symbol.body;
      const registrations = body.match(/font\.registerFont\s*\(/g);
      if (registrations === null || registrations.length === 0) return undefined;
      // A lifecycle method re-registers fonts on every visit. The family name
      // may be constant, which is worse than random: the same name is
      // registered again over the existing entry, and the engine keeps both.
      if (!/aboutToAppear|onPageShow|aboutToReuse|onVisibleAreaChange/.test(facts.symbol.symbol)) return undefined;
      const line = firstMatch(body, /font\.registerFont\s*\(/)!;
      return `fonts are registered again on every visit to the page: ${line}`;
    },
  },
  {
    id: 'remote-image-in-builder',
    category: 'network',
    confidence: 'high',
    match(facts) {
      const body = facts.symbol.body;
      // A remote URL as an Image source downloads per render; a bundled
      // `$rawfile`/`$r` does not.
      if (!/Image\s*\(\s*['"]https?:/.test(body) && !/Image\s*\(\s*['"]http:\/\//.test(body)) return undefined;
      const line = firstMatch(body, /Image\s*\(\s*['"]https?:/)!;
      return `a remote image is fetched instead of a bundled asset: ${line}`;
    },
  },
  {
    id: 'font-register-per-instance',
    category: 'memory',
    confidence: 'high',
    match(facts) {
      const body = facts.symbol.body;
      if (!/font\.registerFont\s*\(/.test(body)) return undefined;
      // A unique family per call means each registration is a new font that
      // never replaces the previous one.
      if (!/generateRandomUUID|randomUUID|Math\.random|Date\.now|uuid/i.test(body)) return undefined;
      const line = firstMatch(body, /font\.registerFont\s*\(/)!;
      return `a new font family is registered per call, so every instance keeps its own copy: ${line}`;
    },
  },
  {
    id: 'http-session-not-destroyed',
    category: 'memory',
    confidence: 'high',
    match(facts) {
      const body = facts.symbol.body;
      if (!/http\.createHttp\s*\(/.test(body)) return undefined;
      // A session that is never destroyed keeps its connection and its
      // response body alive. Check the file: the destroy usually sits in a
      // cleanup method beside the one that creates the session.
      const wholeFile = facts.file.lines.join('\n');
      if (/\.destroy\s*\(/.test(wholeFile)) return undefined;
      const line = firstMatch(body, /http\.createHttp\s*\(/)!;
      return `an HTTP session is created per request and never destroyed: ${line}`;
    },
  },
];
