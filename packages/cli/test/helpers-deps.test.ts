import { describe, it, expect } from 'vitest';
import { cliDeps } from './helpers/deps';
import type { CliDeps } from '../src/commands';

/*
 * The shared command-test deps.
 *
 * This file exists because the helper's whole value is a contract that was
 * silently broken before: seventeen test files copied the object, and a seam
 * added to `CliDeps` turned all of them red at once in a typecheck nobody ran
 * locally. The tests below pin the two properties that make one definition
 * safer than seventeen copies — every seam is present, and an unstubbed seam
 * fails loudly instead of returning a plausible empty value.
 */

/** The seams a command test must stub itself, with the name they report. */
const UNSTUBBED: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ['compare', () => cliDeps().compare({ baseline: 'a', current: 'b' })],
  ['ui-compare', () => cliDeps().uiCompare({ a: 'a', b: 'b', outDir: 'o' })],
  ['report', () => cliDeps().report({ sceneDir: 's', outDir: 'o' })],
  ['trend', () => cliDeps().trend({ reports: [], outDir: 'o' })],
  ['render', () => cliDeps().render({ report: 'r', outDir: 'o' })],
  ['explore', () => cliDeps().explore({ app: 'a', maxSteps: 1, strategy: 'depth_first' })],
  ['agent', () => cliDeps().agent({ app: 'a', task: 't', maxSteps: 1 })],
  ['symbols', () => cliDeps().symbols({ library: 'l', addresses: [] })],
  ['hap', () => cliDeps().hap({ packagePath: 'p' })],
  ['opt', () => cliDeps().opt({ packagePath: 'p' })],
  ['emulator.start', () => cliDeps().emulator.start('e', {})],
  ['emulator.stop', () => cliDeps().emulator.stop('e', {})],
  ['emulator.create', () => cliDeps().emulator.create({ name: 'e' } as never)],
  ['run', () => cliDeps().run({ scenarioPath: 's' } as never)],
];

describe('cliDeps', () => {
  it('refuses every seam a test did not stub, naming it', async () => {
    for (const [name, call] of UNSTUBBED) {
      // The rejection is the contract: a command that reaches a seam its test
      // did not stub fails on the seam's name rather than on a default value
      // that happens to typecheck.
      await expect(call(), `${name} should refuse`).rejects.toThrow(`${name} not stubbed`);
    }
  });

  it('lets a test override any seam, including one that would otherwise refuse', async () => {
    const deps = cliDeps({ compare: async () => ({ metrics: [], evidence: [] }) as never });
    await expect(deps.compare({ baseline: 'a', current: 'b' })).resolves.toEqual({
      metrics: [], evidence: [],
    });
    // The rest of the object is unchanged, so an override is a patch and not
    // a replacement of the whole deps.
    await expect(deps.report({ sceneDir: 's', outDir: 'o' })).rejects.toThrow('report not stubbed');
  });

  it('returns an empty-but-valid shape for the seams a command calls incidentally', async () => {
    // These four are reached by commands whose subject is elsewhere, so a
    // throw would make every such test stub them for no reason.
    await expect(cliDeps().analyze('scene')).resolves.toEqual({ metrics: [], evidence: [] });
    await expect(cliDeps().capsReport(undefined)).resolves.toEqual({ hdcOk: true, capabilities: [] });
    await expect(cliDeps().emulator.list({})).resolves.toEqual([]);
    expect(cliDeps().tools()).toEqual([]);
  });

  it('covers every key CliDeps declares', () => {
    // A seam added to `CliDeps` and forgotten here is exactly the failure this
    // helper was created to prevent, so the key set is checked rather than
    // trusted. `expectTypeOf` would not catch a missing key at runtime.
    const deps = cliDeps();
    const declared: ReadonlyArray<keyof CliDeps> = [
      'doctor', 'capsReport', 'analyze', 'collect', 'gesture', 'query', 'tools',
      'compare', 'uiCompare', 'report', 'trend', 'render', 'explore', 'agent',
      'symbols', 'hap', 'opt', 'emulator', 'run', 'version',
    ];
    for (const key of declared) expect(deps[key], key).toBeDefined();
  });
});
