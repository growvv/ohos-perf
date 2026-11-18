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
});
