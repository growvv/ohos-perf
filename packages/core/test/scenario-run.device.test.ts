import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { createSceneLayout } from '../src/ingest/scene';
import { readSceneMetadata } from '../src/ingest/metadata';
import { parseScenario } from '../src/scenario/schema';
import { ScenarioRunner } from '../src/scenario/runner';

/**
 * Real-device acceptance for the scenario runner.
 *
 * Every test here talks to an attached device and is skipped when none is.
 * The fake-injected unit tests pin the phase order and the file shapes; this
 * pins what the device actually does — that two steps produce two queryable
 * scenes whose `scene.json` names the step that made them.
 */

/** Resolve an hdc binary with at least one connected target, or undefined. */
function attachedHdc(): string | undefined {
  const candidates = [
    process.env.OHOS_PERF_HDC,
    process.platform === 'win32'
      ? 'D:/Application/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
      : undefined,
    'hdc',
  ].filter((path): path is string => path !== undefined);

  for (const hdc of candidates) {
    try {
      const out = execFileSync(hdc, ['list', 'targets'], { encoding: 'utf8', timeout: 5000 });
      const targets = out.split(/\r?\n/).filter((line) => {
        const text = line.trim();
        return text !== '' && !text.includes('[Empty]');
      });
      if (targets.length > 0) return hdc;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

const HDC = attachedHdc();

describe.skipIf(HDC === undefined)('scenario runner on a real device', () => {
  it('captures one queryable scene per step, each naming its step', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scenario-device-'));
    try {
      const device = await connect();
      const scenario = parseScenario(JSON.stringify({
        version: 1,
        name: 'device-two-step',
        app: 'com.example.image',
        steps: [
          {
            id: 'first',
            actions: [{ kind: 'wait', ms: 300 }, { kind: 'marker', name: 'first-done' }],
            capture: { durationMs: 1500, collectors: ['hitrace'] },
          },
          {
            id: 'second',
            actions: [{ kind: 'wait', ms: 300 }],
            capture: { durationMs: 1500, collectors: ['hitrace'] },
          },
        ],
      }));

      const result = await new ScenarioRunner(device, { outDir: root, rounds: 1 }).run(scenario);

      // A failed step must say why; an assertion that only reports
      // `failed !== completed` hides the device's own message.
      expect(result.steps.map((step) => step.error).filter(Boolean)).toEqual([]);
      expect(result.status).toBe('completed');
      expect(result.steps.map((step) => step.id)).toEqual(['first', 'second']);
      expect(result.device.id).toBe(device.id);

      for (const [index, step] of result.steps.entries()) {
        expect(step.sceneDir).toBe(join(root, step.id, 'round-1'));
        // The scene is real: the trace converted into a database.
        expect(existsSync(join(step.sceneDir!, 'trace.db'))).toBe(true);
        const metadata = readSceneMetadata(createSceneLayout(step.sceneDir!));
        expect(metadata?.step).toEqual({ round: 1, index, id: step.id });
        // The capture's own counts come from the same descriptor.
        expect(metadata?.capture?.collectors).toEqual(['hitrace']);
      }

      // The marker is recorded even though the device refuses /proc/uptime:
      // the host clock is always available, the device clock is not.
      const marker = result.steps[0].actions.find((a) => a.action.kind === 'marker');
      expect(marker?.ok).toBe(true);
      expect(marker?.atMs).toBeGreaterThan(0);

      for (const name of ['testInfo.json', 'steps.json', 'pids.json']) {
        expect(existsSync(join(root, name)), name).toBe(true);
      }
      const testInfo = JSON.parse(readFileSync(join(root, 'testInfo.json'), 'utf8'));
      expect(testInfo).toMatchObject({ version: 1, scenario: 'device-two-step', steps: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
