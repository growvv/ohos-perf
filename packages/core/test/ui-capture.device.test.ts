import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../src/device/device';
import { createSceneLayout } from '../src/ingest/scene';
import { readSceneMetadata } from '../src/ingest/metadata';
import { decodePng } from '../src/image/png';
import { readUiTree } from '../src/query/ui';

/**
 * Real-device acceptance for the UI capture.
 *
 * The unit tests pin the collector's protocol against a fake hdc; this pins
 * what the device actually produces — a decodable PNG whose dimensions are the
 * ones `scene.json` recorded, beside a tree with at least one node.
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
const TARGET = process.env.OHOS_PERF_TARGET;
const DEBUG_APP = process.env.OHOS_PERF_DEBUG_APP ?? 'com.example.image';

describe.skipIf(HDC === undefined)('UI capture on a real device', () => {
  it('captures a decodable screenshot and a tree that agree with scene.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ui-capture-device-'));
    try {
      const device = await connect({
        ...(HDC === undefined ? {} : { hdcPath: HDC }),
        ...(TARGET === undefined ? {} : { target: TARGET }),
      });
      const layout = createSceneLayout(root);
      const session = await device.collect({
        app: DEBUG_APP,
        durationMs: 1000,
        sceneRoot: root,
        uitest: true,
        screenshot: true,
      });
      const scene = await session.ingest();
      scene.close();

      expect(existsSync(layout.screenshotFile)).toBe(true);
      const bytes = new Uint8Array(readFileSync(layout.screenshotFile));
      const image = decodePng(bytes);
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);

      // The descriptor is the record of what was captured; it must agree with
      // the file the decoder just read, not merely claim a capture ran.
      const metadata = readSceneMetadata(layout);
      expect(metadata?.capture?.collectors).toContain('screenshot');
      expect(metadata?.capture?.screenshot).toEqual({
        width: image.width,
        height: image.height,
        bytes: bytes.length,
      });

      const tree = readUiTree(layout.uiFile);
      expect(tree?.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);
});
