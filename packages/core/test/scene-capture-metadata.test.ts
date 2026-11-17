import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSceneLayout } from '../src/ingest/scene';
import { readSceneMetadata, writeSceneMetadata } from '../src/ingest/metadata';

/**
 * The capture sub-records are per-collector facts: a scene says what each
 * optional collector produced, and a later `analyze` reads that to decide
 * whether an input exists at all.
 *
 * The defect this pins: the JS heap snapshot was written into `scene.json` by
 * the collector, but `readSceneMetadata` did not know the field. The validator
 * therefore rejected the whole descriptor as untrustworthy and a scene this
 * package had just written read back as having no metadata at all.
 */

function layout(): ReturnType<typeof createSceneLayout> {
  return createSceneLayout(join(mkdtempSync(join(tmpdir(), 'capture-meta-')), 'scene'));
}

const base = {
  version: 1 as const,
  app: { packageName: 'com.example.app', processNames: ['com.example.app'] },
  pids: [] as number[],
  deviceId: 'd',
};

const capture = {
  startedAtMs: 1,
  durationMs: 1000,
  collectors: ['hitrace', 'jsheap'],
};

describe('scene metadata capture block', () => {
  it('round-trips a jsheap capture', () => {
    const l = layout();
    writeSceneMetadata(l, { ...base, capture: { ...capture, jsheap: { bytes: 4096 } } });
    expect(readSceneMetadata(l)?.capture?.jsheap).toEqual({ bytes: 4096 });
  });

  it('records the collector in the fixed-order list', () => {
    const l = layout();
    writeSceneMetadata(l, { ...base, capture: { ...capture, jsheap: { bytes: 4096 } } });
    expect(readSceneMetadata(l)?.capture?.collectors).toEqual(['hitrace', 'jsheap']);
  });

  it('reads a capture with no jsheap block as absent, not zero', () => {
    const l = layout();
    writeSceneMetadata(l, { ...base, capture });
    const read = readSceneMetadata(l);
    expect(read?.capture?.collectors).toEqual(['hitrace', 'jsheap']);
    expect(read?.capture).not.toHaveProperty('jsheap');
  });

  it('rejects a zero-byte snapshot as an untrustworthy descriptor', () => {
    // The collector treats a zero-byte file as a failed capture, so a zero
    // here describes a file that cannot exist on disk. Accepting it would let
    // a broken capture read back as a real one.
    const l = layout();
    mkdirSync(l.root, { recursive: true });
    writeFileSync(
      l.metadataFile,
      JSON.stringify({ ...base, capture: { ...capture, jsheap: { bytes: 0 } } }),
    );
    expect(readSceneMetadata(l)).toBeUndefined();
  });

  it('rejects a negative or fractional byte count', () => {
    for (const bytes of [-1, 1.5]) {
      const l = layout();
      mkdirSync(l.root, { recursive: true });
      writeFileSync(
        l.metadataFile,
        JSON.stringify({ ...base, capture: { ...capture, jsheap: { bytes } } }),
      );
      expect(readSceneMetadata(l), `bytes ${bytes}`).toBeUndefined();
    }
  });
});
