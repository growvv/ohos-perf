import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { connect } from '../src/device/device';

/**
 * Real-device acceptance for `ui.gesture`.
 *
 * The unit tests pin command construction and the marker check. This one pins
 * the fact that the shipped `uitest` on the attached device accepts the
 * command and prints the marker over plain `hdc shell` — the measurement P8 is
 * built on. Home is the safest gesture: it always returns to the launcher.
 *
 * Like the other device tests, it is skipped when no device is attached.
 */

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
      const out = execFileSync(hdc, ['list', 'targets'], {
        encoding: 'utf8',
        timeout: 5000,
      });
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

describe.skipIf(HDC === undefined)('ui.gesture on hardware', () => {
  it('injects a Home key and sees the tool accept it', async () => {
    const device = await connect({
      hdcPath: HDC!,
      ...(TARGET === undefined ? {} : { target: TARGET }),
    });
    expect((await device.capabilities()).has('ui.gesture')).toBe(true);
    const result = await device.gesture({ action: 'key', key: 'Home' });
    expect(result.output).toContain('No Error');
  });
});
