import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCases, loadCases } from '../src/scenario/cases';

/*
 * A case directory is how a suite of scenarios is run in one command.
 *
 * Discovery is deliberately strict about two things: it never guesses a file
 * name, and a filter that matches nothing is a refusal. A suite that silently
 * ran zero cases and reported success is the failure mode this module exists
 * to prevent.
 */

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cases-'));
}

function write(root: string, name: string, text: string): void {
  writeFileSync(join(root, name), text);
}

function validScenario(name: string): string {
  return JSON.stringify({
    version: 1,
    name,
    app: 'com.example.app',
    steps: [{
      id: 'open',
      actions: [],
      capture: { durationMs: 1000, collectors: ['hitrace'] },
    }],
  });
}

describe('discoverCases', () => {
  it('discovers *.scenario.json in name order', () => {
    const root = dir();
    write(root, 'b.scenario.json', validScenario('b'));
    write(root, 'a.scenario.json', validScenario('a'));
    write(root, 'notes.txt', 'x');
    expect(discoverCases(root).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('uses the file stem as the id and the joined path as the path', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    const [found] = discoverCases(root);
    expect(found).toMatchObject({ id: 'scroll' });
    expect(found!.path).toBe(join(root, 'scroll.scenario.json'));
  });

  it('anchors the filter and refuses when nothing matches', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    write(root, 'tap.scenario.json', validScenario('tap'));
    expect(discoverCases(root, '^scroll$').map((c) => c.id)).toEqual(['scroll']);
    expect(() => discoverCases(root, '^nothing$'))
      .toThrow(/matched no case/);
  });

  it('names the cases it did find when the filter matches nothing', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    expect(() => discoverCases(root, '^nothing$')).toThrow(/scroll/);
  });

  it('refuses an invalid filter regex rather than treating it as a literal', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    expect(() => discoverCases(root, '([')).toThrow(/filter/i);
  });

  it('refuses an empty directory, naming the pattern it looked for', () => {
    expect(() => discoverCases(dir())).toThrow(/scenario\.json/);
  });

  it('refuses a directory that does not exist', () => {
    expect(() => discoverCases(join(dir(), 'missing'))).toThrow(/cases|directory/i);
  });
});

describe('loadCases', () => {
  it('keeps the good cases when one file is malformed', () => {
    const root = dir();
    write(root, 'good.scenario.json', validScenario('good'));
    write(root, 'bad.scenario.json', '{ not json');
    const loads = loadCases(discoverCases(root));
    expect(loads.find((l) => l.id === 'good')?.scenario).toBeDefined();
    expect(loads.find((l) => l.id === 'bad')?.error).toBeDefined();
  });

  it('keeps the file order discovery produced', () => {
    const root = dir();
    write(root, 'z.scenario.json', validScenario('z'));
    write(root, 'a.scenario.json', validScenario('a'));
    expect(loadCases(discoverCases(root)).map((l) => l.id)).toEqual(['a', 'z']);
  });

  it('names the file when its scenario is invalid', () => {
    const root = dir();
    write(root, 'wrong.scenario.json', JSON.stringify({ version: 9, name: 'x' }));
    const [load] = loadCases(discoverCases(root));
    expect(load!.error).toContain('wrong.scenario.json');
  });
});

describe('discoverCases — the filter is anchored', () => {
  it('does not match a longer id that merely contains the filter', () => {
    // The docs say "anchored regex over the case id". An unanchored compile
    // would run `no-scroll` for `--filter scroll`, which is the silent
    // extra-case failure this module exists to prevent.
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    write(root, 'no-scroll.scenario.json', validScenario('no-scroll'));
    expect(discoverCases(root, 'scroll').map((c) => c.id)).toEqual(['scroll']);
    expect(discoverCases(root, 'scroll').map((c) => c.id)).not.toContain('no-scroll');
  });

  it('still allows an explicit alternation inside the anchor', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    write(root, 'tap.scenario.json', validScenario('tap'));
    write(root, 'other.scenario.json', validScenario('other'));
    expect(discoverCases(root, 'scroll|tap').map((c) => c.id)).toEqual(['scroll', 'tap']);
  });

  it('treats an explicit ^ or $ as the author writing the anchor, not doubling it', () => {
    const root = dir();
    write(root, 'scroll.scenario.json', validScenario('scroll'));
    write(root, 'no-scroll.scenario.json', validScenario('no-scroll'));
    expect(discoverCases(root, '^scroll$').map((c) => c.id)).toEqual(['scroll']);
  });
});
