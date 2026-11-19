import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceFile, scanSourceTree } from '../src/source/scan';

/*
 * The scanner reads ArkTS, not TypeScript.
 *
 * ArkTS accepts decorators on structs and builder syntax (`build() { Column()
 * { … } }`) that a TypeScript grammar rejects, so this is not a parser: it
 * tracks braces (ignoring the ones inside strings and comments) and reads a
 * declaration off the line that opens a block. The tests below pin the four
 * things that go wrong in a line-oriented scanner — decorators, concatenated
 * strings, duplicate names, and CRLF.
 */

describe('scanSourceFile', () => {
  it('finds a struct method and its line range', () => {
    const text = [
      '@Component',
      'export struct HomePage {',
      '  aboutToAppear(): void {',
      '    load()',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('pages/HomePage.ets', text);
    expect(file.symbols).toHaveLength(1);
    const [symbol] = file.symbols;
    expect(symbol?.className).toBe('HomePage');
    expect(symbol?.symbol).toBe('aboutToAppear');
    expect(symbol?.lineStart).toBe(3);
    expect(symbol?.lineEnd).toBe(5);
  });

  it('finds a class field holding a concatenated SQL string', () => {
    const text = [
      'export class DbCRUDConst {',
      '  static readonly READ_RANDOM: string =',
      "    'select * from t' +",
      "      ' where id = 1';",
      '}',
    ].join('\n');
    const file = scanSourceFile('DbConst.ets', text);
    const [symbol] = file.symbols;
    expect(symbol?.className).toBe('DbCRUDConst');
    expect(symbol?.symbol).toBe('READ_RANDOM');
    expect(symbol?.lineStart).toBe(2);
    expect(symbol?.lineEnd).toBe(4);
    expect(symbol?.body).toContain("' where id = 1'");
  });

  it('finds a method whose parameter list wraps across lines', () => {
    // Real ArkTS writes this whenever a signature has a callback parameter:
    // the parameter list is longer than the line limit, so the body's opening
    // brace is several lines below the name. Reading only one line misses the
    // method entirely and reads its parameters as fields.
    const text = [
      'export class FeedService {',
      '  async refreshAllFeeds(onProgress: (done: number, total: number) => void,',
      '    applyFrequency: boolean = false,',
      '    scopeIds: number[] | null = null): Promise<void> {',
      '    for (const feed of feeds) {',
      '      await this.refreshFeed(feed.id)',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('FeedService.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['refreshAllFeeds']);
    expect(file.symbols[0]?.lineStart).toBe(2);
    expect(file.symbols[0]?.lineEnd).toBe(8);
    expect(file.symbols[0]?.body).toContain('await this.refreshFeed');
  });

  it('does not let a quote inside a regex literal unbalance the file', () => {
    // `<enclosure[^>]+url="([^"]+)"[^>]*>` holds two quote characters that are
    // not string delimiters. Reading the first as one opens a string that runs
    // to the next line's regex, and the method after this one is swallowed.
    const text = [
      'export class FeedParser {',
      '  static extractImage(xml: string): string {',
      '    const enclosure: RegExpMatchArray | null =',
      '      xml.match(/<enclosure[^>]+url="([^"]+)"[^>]*>/i);',
      '    if (enclosure !== null) {',
      '      return enclosure[1];',
      '    }',
      '    return "";',
      '  }',
      '  static extractTag(xml: string): string {',
      '    return xml.toLowerCase();',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('FeedParser.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['extractImage', 'extractTag']);
    expect(file.symbols[0]?.lineEnd).toBe(9);
    expect(file.symbols[1]?.lineStart).toBe(10);
  });

  it('keeps a division operator from being read as a regex', () => {
    const text = [
      'export class A {',
      '  ratio(a: number, b: number): number {',
      '    return a / b;',
      '  }',
      '  next(): number {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['ratio', 'next']);
  });

  it('keeps the widest range when a name is declared twice', () => {
    const text = [
      'export class A {',
      '  get value(): number {',
      '    return 1',
      '  }',
      '  value(): number {',
      '    return 2',
      '  }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols).toHaveLength(1);
    expect(file.symbols[0]?.lineStart).toBe(2);
    expect(file.symbols[0]?.lineEnd).toBe(7);
  });

  it('reads CRLF line endings without shifting line numbers', () => {
    const text = 'export class A {\r\n  run(): void {\r\n    go()\r\n  }\r\n}\r\n';
    const file = scanSourceFile('a.ets', text);
    expect(file.lines).toHaveLength(5);
    expect(file.symbols[0]?.lineStart).toBe(2);
    expect(file.symbols[0]?.lineEnd).toBe(4);
  });

  it('keeps module-scope lines outside every symbol', () => {
    const text = [
      'PersistentStorage.persistProp<Data[]>("homeList", [])',
      'export class A {',
      '  run(): void {}',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.moduleLines).toEqual(['PersistentStorage.persistProp<Data[]>("homeList", [])']);
  });

  it('walks a tree in byte order and skips build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-'));
    mkdirSync(join(root, 'b'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'z.ets'), 'export class Z {}');
    writeFileSync(join(root, 'b', 'a.ets'), 'export class A {}');
    writeFileSync(join(root, 'node_modules', 'x.ets'), 'export class X {}');
    expect(scanSourceTree(root).map((file) => file.path)).toEqual(['b/a.ets', 'z.ets']);
  });

  it('does not let an unterminated string swallow the rest of the file', () => {
    // A file can be mid-edit or truncated when it is scanned. An unterminated
    // quote used to run the string to end of file, so every method after it
    // vanished from the scan — the tool then reported "no suspects" for a tree
    // whose defects were simply below the broken line.
    const text = [
      'export class A {',
      '  f() {',
      '    const s = "unterminated;',
      '  }',
      '  g() { return 1; }',
      '  h() { return 2; }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['f', 'g', 'h']);
  });

  it('reads a regex literal that follows a keyword, not a value', () => {
    // `startsRegex` decides slash-or-division from the previous character, and
    // the last character of `return` is `n` — an identifier character, so the
    // slash was read as division. A regex whose body holds an unbalanced brace
    // then counted that brace, the method's block never closed, and every
    // method below it vanished. A regex with no brace in it hid the same bug,
    // which is why this one has a brace.
    const text = [
      'export class A {',
      '  f(s: string): boolean {',
      '    return /\\{/.test(s);',
      '  }',
      '  g(): number { return 1; }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['f', 'g']);
    expect(file.symbols[0]?.lineEnd).toBe(4);
  });

  it('still reads a division after an identifier', () => {
    // The keyword list must not swallow a real division: `total / count` is
    // division, and reading it as a regex would blank the rest of the line.
    const text = [
      'export class A {',
      '  f(total: number, count: number): number {',
      '    return total / count;',
      '  }',
      '  g(): number { return 1; }',
      '}',
    ].join('\n');
    const file = scanSourceFile('a.ets', text);
    expect(file.symbols.map((symbol) => symbol.symbol)).toEqual(['f', 'g']);
  });
});
