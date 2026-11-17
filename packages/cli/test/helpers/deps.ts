import type { CliDeps } from '../../src/commands';

/**
 * A complete `CliDeps` for command tests.
 *
 * This exists because the object was copied into seventeen test files, and
 * every seam added to `CliDeps` turned all seventeen red at once — the failure
 * surfaced only in CI's `tsconfig.test.json`, so five releases shipped with a
 * red build before anyone looked. One definition means a new seam is added
 * here and nowhere else.
 *
 * Every stub throws unless a test overrides it, so a command that reaches a
 * seam its test did not stub fails loudly instead of quietly succeeding on a
 * default. The handful of seams that return a value (`analyze`, `collect`,
 * `gesture`, `query`, `capsReport`) return an empty-but-valid shape for the
 * same reason: they are the ones a command calls incidentally.
 */
export function cliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const notStubbed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} not stubbed`);
  };
  return {
    version: '1.0.0',
    doctor: {
      resolveHdc: async () => '/hdc',
      resolveStreamer: async () => ({ path: '/streamer', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    },
    capsReport: async () => ({ hdcOk: true, capabilities: [] }),
    analyze: async () => ({ metrics: [], evidence: [] }),
    collect: async () => ({ sceneDir: '/scene', device: { id: 't1', kind: 'emulator' }, collectors: [] }),
    gesture: async () => ({ gesture: { action: 'key' as const, key: 'Home' }, output: 'No Error' }),
    query: async () => ({ query: 'frames.all', rows: [], total: 0, truncated: false }),
    tools: () => [],
    compare: notStubbed('compare'),
    uiCompare: notStubbed('ui-compare'),
    report: notStubbed('report'),
    trend: notStubbed('trend'),
    render: notStubbed('render'),
    rootCause: notStubbed('root-cause'),
    explore: notStubbed('explore'),
    agent: notStubbed('agent'),
    symbols: notStubbed('symbols'),
    hap: notStubbed('hap'),
    opt: notStubbed('opt'),
    emulator: {
      list: async () => [],
      start: notStubbed('emulator.start'),
      stop: notStubbed('emulator.stop'),
      create: notStubbed('emulator.create'),
    },
    run: notStubbed('run'),
    ...overrides,
  };
}
