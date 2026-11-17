import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { ChatModel, UiNode } from '@ohos-perf/core';
import { realDeps } from '../src/deps';

/*
 * P29 task 5 — the `explore --model` seam.
 *
 * The model is a separate seam from `agentModel` and `rootCauseModel`: a test
 * that stubs one must not silently change what another sends. These tests pin
 * the parts that only appear when the real seam runs: the chooser is built from
 * the configured endpoint, the model's answers reach the walk, and a missing
 * endpoint fails before a device is opened.
 */

const ENV_KEYS = [
  'OHOS_PERF_AGENT_BASE_URL', 'OHOS_PERF_AGENT_API_KEY', 'OHOS_PERF_AGENT_MODEL',
  'GLM_BASE_URL', 'GLM_API_KEY', 'GLM_MODEL',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const node = (overrides: Partial<UiNode> & { id: string }): UiNode => ({
  depth: 1,
  type: 'Button',
  bundleName: 'com.demo',
  abilityName: 'Main',
  text: '',
  bounds: '[0,0][10,10]',
  clickable: true,
  enabled: true,
  scrollable: false,
  children: 0,
  ...overrides,
});

function twoButtons(): readonly UiNode[] {
  return [
    node({ id: 'root', type: 'Root', clickable: false, children: 2 }),
    node({ id: 'first', text: 'First', bounds: '[0,0][10,10]' }),
    node({ id: 'second', text: 'Second', bounds: '[20,20][30,30]' }),
  ];
}

/** A device that accepts every gesture and never changes its screen. */
function device(): {
  id: string;
  kind: string;
  uiTree(): Promise<readonly UiNode[]>;
  gesture(g: unknown): Promise<{ gesture: never; output: string }>;
} {
  return {
    id: 'emu-1',
    kind: 'emulator',
    uiTree: async () => twoButtons(),
    gesture: async (g) => ({ gesture: g as never, output: 'No Error' }),
  };
}

/** A clock that advances only when a test asks it to. */
function clock(): { now(): number; sleep(ms: number): Promise<void> } {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

/** A model that records prompts and answers from a script. */
function answers(script: string[]): ChatModel & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt);
      return script.shift() ?? '{"action":"stop","reason":"script exhausted"}';
    },
  };
}

function configureEndpoint(): void {
  process.env['OHOS_PERF_AGENT_BASE_URL'] = 'https://e.test/v1';
  process.env['OHOS_PERF_AGENT_API_KEY'] = 'k';
}

describe('realDeps().explore with --model', () => {
  it('drives the walk with a stubbed ChatModel and records its proposals', async () => {
    configureEndpoint();
    const model = answers([
      '{"action":"tap","element":0,"reason":"open the first"}',
      '{"action":"tap","element":0,"reason":"open the second"}',
    ]);
    const deps = realDeps('0.0.0', {
      exploreDevice: async () => device(),
      exploreClock: clock(),
      exploreModel: model,
    });
    const result = await deps.explore({
      app: 'com.demo', maxSteps: 5, strategy: 'depth_first', model: 'm1',
    });

    expect(result.steps).toBe(2);
    expect(result.model).toEqual({ name: 'm1', used: 2, refused: 0, refusals: [] });
    // The offer is the screen: the prompt carries the index, the label and the
    // bounds of the element the model may choose.
    expect(model.prompts[0]).toContain('0. Button "First"');
    expect(model.prompts[0]).toContain('bounds=[0,0][10,10]');
  });

  it('records a refusal and lets the deterministic order decide', async () => {
    configureEndpoint();
    const model = answers([
      '{"action":"tap","element":9,"reason":"invented"}',
      '{"action":"stop","reason":"done"}',
    ]);
    const deps = realDeps('0.0.0', {
      exploreDevice: async () => device(),
      exploreClock: clock(),
      exploreModel: model,
    });
    const result = await deps.explore({
      app: 'com.demo', maxSteps: 1, strategy: 'depth_first', model: 'm1',
    });

    expect(result.steps).toBe(1);
    expect(result.model?.refused).toBe(1);
    expect(result.model?.refusals[0]?.detail).toMatch(/element 9/);
  });

  it('ends with stoppedBy model when the model says stop', async () => {
    configureEndpoint();
    const deps = realDeps('0.0.0', {
      exploreDevice: async () => device(),
      exploreClock: clock(),
      exploreModel: answers(['{"action":"stop","reason":"covered enough"}']),
    });
    const result = await deps.explore({
      app: 'com.demo', maxSteps: 5, strategy: 'depth_first', model: 'm1',
    });
    expect(result.steps).toBe(0);
    expect(result.stoppedBy).toBe('model');
  });

  it('never consults the model without --model', async () => {
    configureEndpoint();
    let called = false;
    const deps = realDeps('0.0.0', {
      exploreDevice: async () => device(),
      exploreClock: clock(),
      exploreModel: {
        complete: async () => {
          called = true;
          return '{"action":"stop","reason":"should not be asked"}';
        },
      },
    });
    const result = await deps.explore({
      app: 'com.demo', maxSteps: 1, strategy: 'depth_first',
    });
    expect(called).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.steps).toBe(1);
  });

  it('refuses --model when no endpoint is configured, before touching a device', async () => {
    let opened = false;
    const deps = realDeps('0.0.0', {
      exploreDevice: async () => {
        opened = true;
        return device();
      },
      exploreClock: clock(),
    });
    await expect(
      deps.explore({ app: 'com.demo', maxSteps: 1, strategy: 'depth_first', model: 'm1' }),
    ).rejects.toThrow(/OHOS_PERF_AGENT_BASE_URL/);
    expect(opened).toBe(false);
  });
});
