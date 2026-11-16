import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneLayout } from '../src/ingest/scene';
import { readSceneMetadata, writeSceneMetadata } from '../src/ingest/metadata';

function layout(): ReturnType<typeof createSceneLayout> {
  return createSceneLayout(join(mkdtempSync(join(tmpdir(), 'step-meta-')), 'scene'));
}

const base = {
  version: 1 as const,
  app: { packageName: 'com.example.app', processNames: ['com.example.app'] },
  pids: [] as number[],
  deviceId: 'd',
};

describe('scene metadata step block', () => {
  it('round-trips the step block', () => {
    const l = layout();
    writeSceneMetadata(l, { ...base, step: { round: 1, index: 0, id: 'open' } });
    expect(readSceneMetadata(l)?.step).toEqual({ round: 1, index: 0, id: 'open' });
  });

  it('reads a document with no step block exactly as before', () => {
    const l = layout();
    writeSceneMetadata(l, base);
    const read = readSceneMetadata(l);
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty('step');
  });

  it('treats a malformed step block as an untrustworthy descriptor', () => {
    const l = layout();
    const bad: unknown[] = [
      { round: 0, index: 0, id: 'a' },
      { round: 1, index: -1, id: 'a' },
      { round: 1, index: 0 },
      { round: 1, index: 0, id: '' },
      { round: 1.5, index: 0, id: 'a' },
      { round: 1, index: 0, id: 7 },
      'step',
      [],
    ];
    for (const step of bad) {
      writeSceneMetadata(l, { ...base, step } as never);
      expect(readSceneMetadata(l), JSON.stringify(step)).toBeUndefined();
    }
  });

  it('keeps the step block beside a capture block', () => {
    const l = layout();
    writeSceneMetadata(l, {
      ...base,
      step: { round: 2, index: 3, id: 'scroll' },
      capture: { startedAtMs: 1, durationMs: 1000, collectors: ['hitrace'] },
    });
    expect(readSceneMetadata(l)).toMatchObject({
      step: { round: 2, index: 3, id: 'scroll' },
      capture: { durationMs: 1000, collectors: ['hitrace'] },
    });
  });
});
