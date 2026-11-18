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
}

/** Directories never walked: build output and dependency trees. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'oh_modules', '.hvigor', '.idea']);

const TYPE_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|struct|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MODIFIERS = '(?:public|private|protected|static|async|readonly|override|declare|abstract|get|set)\\s+';
const METHOD_DECL = new RegExp(
  `^\\s*(?:${MODIFIERS})*([A-Za-z_$][\\w$]*)\\s*\\([^;]*\\)\\s*(?::\\s*[^{;]+)?\\{`,
);
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
 */
function stripNoise(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
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
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
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
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
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
  /** Open type scopes: the depth the scope opened at and its name. */
  const scopes: { depth: number; name: string; lineStart: number }[] = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index++) {
    const code = stripped[index] ?? '';
    const delta = deltas[index] ?? 0;

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
        found.push({ className: scopes[scopes.length - 1]!.name, symbol: name, lineStart: index + 1, lineEnd: endLine });
      }
    }

    depth += delta;
    while (scopes.length > 0 && depth <= scopes[scopes.length - 1]!.depth) {
      const closed = scopes.pop()!;
      typeExtents.push({ lineStart: closed.lineStart, lineEnd: index + 1 });
    }
  }

  return finish(path, lines, found, typeExtents);
}

/**
 * The 1-based line a declaration ends on.
 *
 * A block declaration ends on the line its brace closes. A field ends on the
 * `;` that terminates it — which may be many lines down when its initializer
 * is a concatenation.
 */
function findBlockEnd(
  lines: readonly string[],
  stripped: readonly string[],
  start: number,
  deltas: readonly number[],
): number {
  const delta = deltas[start] ?? 0;
  if (delta <= 0) {
    // No block opened on this line: a field. Run to the terminating ';'. A
    // field with no semicolon (ArkTS allows the last member to omit it) runs
    // until the depth would go negative — the line that closes its class.
    let depth = 0;
    for (let index = start; index < lines.length; index++) {
      if ((stripped[index] ?? '').includes(';')) return index + 1;
      depth += deltas[index] ?? 0;
      if (depth < 0) return index;
    }
    return lines.length;
  }
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    depth += deltas[index] ?? 0;
    if (depth <= 0) return index + 1;
  }
  return lines.length;
}

/** Collapse duplicate declarations and build the file. */
function finish(
  path: string,
  lines: readonly string[],
  found: readonly { className?: string; symbol: string; lineStart: number; lineEnd: number }[],
  typeExtents: readonly { lineStart: number; lineEnd: number }[],
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
  for (let line = 1; line <= lines.length; line++) {
    if (covered[line] === 0 && (lines[line - 1] ?? '').trim() !== '') moduleLines.push(lines[line - 1]!);
  }

  return { path, lines, symbols, moduleLines };
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
