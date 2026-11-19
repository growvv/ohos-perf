/**
 * An ArkTS source tree, read as symbols with line ranges.
 *
 * ## Why this is a scanner and not a parser
 *
 * The obvious way to read ArkTS is a TypeScript parser. It does not work: an
 * ArkTS page is full of things a TypeScript grammar rejects — decorators on a
 * `struct`, builder syntax (`build() { Column() { … } }`), `$rawfile` — and a
 * parser throws on the first file it cannot handle, which in a real app is the
 * first page. A scan that yields nothing for the file it could not parse is
 * worse than a scan that yields the symbols it could find.
 *
 * So this walks the text once, tracking brace depth, and records a symbol when
 * a line that opens a block also names something. Braces inside string
 * literals, template literals and comments are not counted, because
 * `'{'` in a SQL constant would otherwise unbalance the whole file.
 *
 * ## What a symbol is
 *
 * A method (`run(): void {`), a getter (`get value() {`), a field
 * (`static readonly K: string =`), or a class/struct member function. Its
 * range runs from the declaring line to the line its block closes on. A field
 * whose initializer spans lines (a concatenated SQL string) runs to the `;`
 * that ends the statement, so a rule matching on the statement's text sees all
 * of it.
 *
 * ## Why duplicates collapse
 *
 * ArkTS allows an overload pair and a getter beside a setter. A suspect names
 * one location, so two declarations of one name in one class become one
 * symbol with the wider range — the narrower one would point a reader at half
 * the code.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One declaration in a source file. */
export interface SourceSymbol {
  /** Class or struct name, or undefined at module scope. */
  readonly className?: string;
  readonly symbol: string;
  /** 1-based, inclusive. */
  readonly lineStart: number;
  readonly lineEnd: number;
  /** Every line of the body, verbatim, joined with '\n'. */
  readonly body: string;
  /**
   * The body with comments and string contents blanked, line for line.
   *
   * Same number of lines as `body`, so a rule can read structure from this and
   * quote the reader-facing text from `body` at the same index. A rule that
   * read only `body` counted a `for (…)` written inside a string literal as a
   * loop, and reported a log line as a query running per iteration.
   */
  readonly code: string;
  /** The whole declaration text from its decorators to its closing brace. */
  readonly declaration: string;
}

/** One file of a scanned tree. */
export interface SourceFile {
  /** Path relative to the scanned root, with '/' separators. */
  readonly path: string;
  readonly lines: readonly string[];
  readonly symbols: readonly SourceSymbol[];
  /** Module-scope lines: everything no symbol's body covers. */
  readonly moduleLines: readonly string[];
  /**
   * The 1-based line number of each entry in `moduleLines`, in the same order.
   *
   * A module statement is found by its text, and the same text can appear
   * twice — two identical `PersistentStorage.persistProp(…)` calls are two
   * separate statements. Recovering the line with `lines.indexOf(text)` sent
   * both findings to the first one; carrying the number the scan already knew
   * keeps them apart.
   */
  readonly moduleLineNumbers: readonly number[];
  /**
   * Every class/struct/enum declaration's line range.
   *
   * A rule that asks "does anything bound this store?" or "is this session
   * destroyed?" is asking about the class the finding lives in, not the file.
   * An unrelated class's `maxItems` or `image.destroy()` answers a question
   * about that class.
   */
  readonly classExtents: readonly { readonly name: string; readonly lineStart: number; readonly lineEnd: number }[];
}

/** Directories never walked: build output and dependency trees. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'oh_modules', '.hvigor', '.idea']);

const TYPE_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|struct|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MODIFIERS = '(?:public|private|protected|static|async|readonly|override|declare|abstract|get|set)\\s+';
/** Decorators that may prefix a declaration on the same line. */
const DECORATOR_PREFIX = '(?:@[A-Za-z_$][\\w$]*(?:\\([^)]*\\))?\\s+)*';
const METHOD_DECL = new RegExp(
  `^\\s*${DECORATOR_PREFIX}(?:${MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*\\([^;]*\\)\\s*(?::\\s*[^{;]+)?\\{`,
);
/**
 * An ArkTS builder: `@Builder name(args) { … }`, or `@Builder` on its own line
 * followed by `name(args) {`. The decorator is part of the declaration, so the
 * range starts at the decorator line.
 */
const DECORATOR = /^\s*@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*$/;
const FIELD_DECL = new RegExp(
  `^\\s*(?:${MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*(?:[?!])?\\s*:\\s*[^=;]+(?:=|;)`,
);
/** Names that look like a declaration but are statements. */
const NOT_A_SYMBOL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor',
  'do', 'else', 'try', 'finally', 'with',
]);

/**
 * The text with comments and string contents blanked out, so brace counting
 * and declaration matching see only structure.
 *
 * Length is preserved: every removed character becomes a space, so an index
 * into this string is an index into the original.
 *
 * ## Why regex literals are part of this
 *
 * `/url="([^"]+)"/i` holds two `"` characters that are not string delimiters.
 * Reading the first as one opens a string that runs to the end of the line and
 * then past it, and the method that follows is swallowed into the one before —
 * the scanner reports `extractImage` running to line 303, and `extractTag`,
 * the method the benchmark's root cause names, does not exist at all.
 *
 * Telling `/` apart from division needs the previous significant character:
 * after a value (`)`, `]`, an identifier, a number, a string) a slash divides;
 * after an operator, a keyword or an opening bracket it starts a regex.
 */
function stripNoise(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  /** The last non-space character emitted, for the regex-or-division test. */
  let previous = '';
  /**
   * The identifier or keyword that ends at `previous`, if it ends on one.
   *
   * `startsRegex` needs it because a keyword like `return` ends in an
   * identifier character but is not a value, so the character alone would read
   * `return /x/` as a division.
   */
  let word = '';
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to && at < n; at++) {
      if (text[at] !== '\n') out[at] = ' ';
    }
  };

  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(n, i + 2);
      blank(start, i);
      continue;
    }
    if (ch === '/' && startsRegex(previous, word)) {
      // Skip the body, honouring escapes and a character class where `/` does
      // not close the literal.
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      // Flags.
      while (i < n && /[a-z]/i.test(text[i]!)) i += 1;
      blank(start, i);
      previous = '/';
      word = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      // A single- or double-quoted string cannot contain a raw newline in
      // JavaScript, so an unterminated one ends at the end of its line. A
      // template literal can span lines, so only a backtick runs on.
      // Without this, one unbalanced quote — a file caught mid-edit, or a
      // quote inside something this reader misjudged — blanked the rest of
      // the file and every method below it disappeared from the scan.
      const singleLine = quote !== '`';
      out[i] = ' ';
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          out[i] = ' ';
          if (i + 1 < n && text[i + 1] !== '\n') out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out[i] = ' ';
          i += 1;
          break;
        }
        if (text[i] === '\n') {
          if (singleLine) break;
          i += 1;
          continue;
        }
        out[i] = ' ';
        i += 1;
      }
      previous = quote;
      word = '';
      continue;
    }
    if (ch.trim() === '') {
      // Whitespace does not end the word: `return /x/` separates the keyword
      // from the slash with a space, and that is the case this exists for.
      i += 1;
      continue;
    }
    // Track the identifier this character belongs to, so `startsRegex` can
    // tell the keyword `return` from a variable named `returned` and from the
    // `x` in `return x`.
    word = /[\w$]/.test(ch)
      ? (word !== '' && /[\w$]/.test(previous) ? word + ch : ch)
      : '';
    previous = ch;
    i += 1;
  }
  return out.join('');
}

/**
 * Keywords after which a `/` opens a regular expression rather than dividing.
 *
 * `return /x/.test(s)` and `case /a/:` both put a regex directly after a word,
 * so the previous *character* is an identifier character and the
 * character-only test read the slash as division. A regex whose body holds an
 * unbalanced brace then counted that brace, the enclosing block never closed,
 * and every method below it disappeared — the same failure as an unterminated
 * string, from the opposite direction.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new',
  'delete', 'void', 'throw', 'yield', 'await',
]);

/**
 * Whether a `/` after the last significant character and the word ending at it
 * opens a regular expression rather than dividing.
 *
 * After a value — an identifier's last character, a closing bracket, a string
 * or a regex — a slash divides. After an operator, a comma, an opening bracket
 * or the start of a line it opens a regex. A keyword is the exception that the
 * character alone cannot see: `return` ends in an identifier character but
 * takes an expression, not a divisor. `return a / b` and `.match(/x/)` both
 * fall out of this rule without a list of operators.
 */
function startsRegex(previous: string, word: string): boolean {
  if (previous === '') return true;
  if (!/[\w$)\]'"`]/.test(previous)) return true;
  return REGEX_PRECEDING_KEYWORDS.has(word);
}

/** Per-line brace delta of an already-stripped text. */
function lineDeltas(stripped: string): number[] {
  const deltas: number[] = [];
  let depth = 0;
  for (const line of stripped.split('\n')) {
    let delta = 0;
    for (const ch of line) {
      if (ch === '{') delta += 1;
      else if (ch === '}') delta -= 1;
    }
    deltas.push(delta);
    depth += delta;
  }
  return deltas;
}

/**
 * A method whose parameter list wraps across lines.
 *
 * `async refreshAllFeeds(onProgress: (done: number, total: number) => void,`
 * continues for two more lines before its body opens. The single-line matcher
 * sees only the first line, whose parentheses never close, so it recognises no
 * declaration — and then reads each parameter line as a field of the class.
 * A whole method disappears and its parameters take its place.
 */
function matchWrappedMethod(
  stripped: readonly string[],
  start: number,
): { name: string; braceLine: number } | undefined {
  const first = stripped[start] ?? '';
  const head = new RegExp(`^\\s*${DECORATOR_PREFIX}(?:${MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*\\(`).exec(first);
  if (head === null) return undefined;
  const name = head[1]!;
  if (NOT_A_SYMBOL.has(name)) return undefined;

  let parens = 0;
  const limit = Math.min(stripped.length, start + 20);
  for (let index = start; index < limit; index++) {
    const line = stripped[index] ?? '';
    // On the first line, skip the name and the parenthesis that opens the list.
    for (let at = index === start ? head[0].length - 1 : 0; at < line.length; at++) {
      const ch = line[at];
      if (ch === '(') parens += 1;
      else if (ch === ')') parens -= 1;
    }
    if (parens > 0) continue;
    if (parens < 0) return undefined;
    // Closed on the line it opened on: not wrapped, and the single-line
    // matcher already handles it.
    if (index === start) return undefined;
    const tail = line.slice(line.lastIndexOf(')') + 1);
    if (/\s*(?::\s*[^{;]+)?\{/.test(tail)) return { name, braceLine: index };
    // A return type may wrap too; the body opens on the next line.
    if (/\s*(?::\s*[^{;]+)?\{/.test(stripped[index + 1] ?? '')) return { name, braceLine: index + 1 };
    return undefined;
  }
  return undefined;
}

/** Scan one file's text. */
export function scanSourceFile(path: string, text: string): SourceFile {
  const normalized = text.replace(/\r\n/g, '\n');
  const rawLines = normalized.split('\n');
  // A file that ends in a newline has no final empty line; keeping it would
  // shift every range by one against an editor's line numbers.
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const stripped = stripNoise(normalized).split('\n');
  const deltas = lineDeltas(stripped.join('\n'));

  const found: { className?: string; symbol: string; lineStart: number; lineEnd: number }[] = [];
  /** The extent of every type declaration, so module lines exclude structure. */
  const typeExtents: { lineStart: number; lineEnd: number }[] = [];
  /** Every type declaration with its name, for rules that ask about the class. */
  const classExtents: { name: string; lineStart: number; lineEnd: number }[] = [];
  /** Open type scopes: the depth the scope opened at and its name. */
  const scopes: { depth: number; name: string; lineStart: number }[] = [];
  let depth = 0;
  /** Continuation lines of a wrapped signature, already consumed. */
  let skipUntil = -1;

  for (let index = 0; index < lines.length; index++) {
    const code = stripped[index] ?? '';
    const delta = deltas[index] ?? 0;
    if (index <= skipUntil) {
      depth += delta;
      continue;
    }

    // A type declaration opens a scope at the depth before its brace.
    const typeMatch = TYPE_DECL.exec(code);
    if (typeMatch !== null && delta > 0) {
      scopes.push({ depth, name: typeMatch[2]!, lineStart: index + 1 });
    } else if (scopes.length > 0 && depth === scopes[scopes.length - 1]!.depth + 1) {
      // Directly inside a type, not nested in a method body. Without this test
      // ArkTS builder containers — `Column() { … }`, `ForEach(…) { … }` — would
      // each be read as a member named `Column` or `ForEach`, and the real
      // method's body would be split into fake symbols.
      const method = METHOD_DECL.exec(code);
      const field = method === null ? FIELD_DECL.exec(code) : null;
      const name = method?.[1] ?? field?.[1];
      if (name !== undefined && !NOT_A_SYMBOL.has(name)) {
        const endLine = findBlockEnd(lines, stripped, index, deltas);
        // The declaration starts at the decorator above it, if there is one.
        let startLine = index + 1;
        while (startLine > 1 && DECORATOR.test(stripped[startLine - 2] ?? '')) startLine -= 1;
        found.push({ className: scopes[scopes.length - 1]!.name, symbol: name, lineStart: startLine, lineEnd: endLine });
      } else if (method === null) {
        // A signature whose parameter list wraps: the body opens several lines
        // below the name, so the single-line matchers see a field-shaped line
        // with no terminator and no declaration at all. Read it whole.
        const wrapped = matchWrappedMethod(stripped, index);
        if (wrapped !== undefined) {
          const endLine = findBlockEnd(lines, stripped, wrapped.braceLine, deltas);
          let startLine = index + 1;
          while (startLine > 1 && DECORATOR.test(stripped[startLine - 2] ?? '')) startLine -= 1;
          found.push({
            className: scopes[scopes.length - 1]!.name,
            symbol: wrapped.name,
            lineStart: startLine,
            lineEnd: endLine,
          });
          skipUntil = wrapped.braceLine;
        }
      }
    }

    depth += delta;
    while (scopes.length > 0 && depth <= scopes[scopes.length - 1]!.depth) {
      const closed = scopes.pop()!;
      typeExtents.push({ lineStart: closed.lineStart, lineEnd: index + 1 });
      classExtents.push({ name: closed.name, lineStart: closed.lineStart, lineEnd: index + 1 });
    }
  }

  return finish(path, lines, stripped, found, typeExtents, classExtents);
}

/**
 * The 1-based line a declaration ends on.
 *
 * A block declaration ends on the line its brace closes. A field ends where
 * its statement completes — the `;`, or the first line whose text does not end
 * in an operator that promises a continuation. That second case is not
 * pedantry: ArkTS lets a field omit its semicolon, and a scanner that ran to
 * the next one would give `pathStack: NavPathStack | null = null` the whole
 * struct as its body — which is how an `eager-foreach` rule ends up firing on
 * every field that shares a class with a `build()`.
 */
function findBlockEnd(
  lines: readonly string[],
  stripped: readonly string[],
  start: number,
  deltas: readonly number[],
): number {
  const delta = deltas[start] ?? 0;
  if (delta > 0) {
    let depth = 0;
    for (let index = start; index < lines.length; index++) {
      depth += deltas[index] ?? 0;
      if (depth <= 0) return index + 1;
    }
    return lines.length;
  }

  // A field: stop at the terminating ';', or at the first complete statement.
  for (let index = start; index < lines.length; index++) {
    const code = (stripped[index] ?? '').trimEnd();
    if (code.includes(';')) return index + 1;
    if (index === start) continue;
    // A continuation line ends in an operator that promises more.
    if (/[+,=(\[.?:]$/.test(code)) continue;
    // A closing brace ends the enclosing type, not this field.
    if (/^[}\])]/.test(code)) return index;
    return index + 1;
  }
  return lines.length;
}

/** Collapse duplicate declarations and build the file. */
function finish(
  path: string,
  lines: readonly string[],
  stripped: readonly string[],
  found: readonly { className?: string; symbol: string; lineStart: number; lineEnd: number }[],
  typeExtents: readonly { lineStart: number; lineEnd: number }[],
  classExtents: readonly { name: string; lineStart: number; lineEnd: number }[],
): SourceFile {
  const byKey = new Map<string, { className?: string; symbol: string; lineStart: number; lineEnd: number }>();
  for (const item of found) {
    const key = `${item.className ?? ''}\u0000${item.symbol}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, item);
    } else {
      // The wider range wins: a reader pointed at half a declaration would
      // miss the half that carries the defect.
      existing.lineStart = Math.min(existing.lineStart, item.lineStart);
      existing.lineEnd = Math.max(existing.lineEnd, item.lineEnd);
    }
  }

  const symbols = [...byKey.values()]
    .sort((a, b) => a.lineStart - b.lineStart || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map((item) => {
      const bodyLines = lines.slice(item.lineStart - 1, item.lineEnd);
      return {
        ...item,
        body: bodyLines.join('\n'),
        code: stripped.slice(item.lineStart - 1, item.lineEnd).join('\n'),
        declaration: bodyLines.join('\n'),
      };
    });

  const covered = new Uint8Array(lines.length + 1);
  for (const symbol of symbols) {
    for (let line = symbol.lineStart; line <= symbol.lineEnd; line++) covered[line] = 1;
  }
  // A type's own declaration lines are structure, not module-level statements:
  // `export class A {` and its closing `}` are not something a rule can fire
  // on, and listing them as module lines would bury the one statement that is.
  for (const extent of typeExtents) {
    for (let line = extent.lineStart; line <= extent.lineEnd; line++) covered[line] = 1;
  }
  const moduleLines: string[] = [];
  const moduleLineNumbers: number[] = [];
  for (let line = 1; line <= lines.length; line++) {
    if (covered[line] === 0 && (lines[line - 1] ?? '').trim() !== '') {
      moduleLines.push(lines[line - 1]!);
      moduleLineNumbers.push(line);
    }
  }

  return { path, lines, symbols, moduleLines, moduleLineNumbers, classExtents };
}

/**
 * Every `.ets` and `.ts` file under `root`, sorted by path.
 *
 * The order is a plain `<` comparison rather than `localeCompare`, because a
 * locale-dependent order would make the report differ between two machines
 * reading the same tree.
 */
export function scanSourceTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const names = entries
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.directory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), relative);
      } else if (entry.name.endsWith('.ets') || entry.name.endsWith('.ts')) {
        const text = readFileSync(join(dir, entry.name), 'utf8');
        files.push(scanSourceFile(relative, text));
      }
    }
  };
  walk(root, '');
  return files;
}
