import { describe, it, expect } from 'vitest';
import { Device } from '../src/device/device';
import type { UiNode } from '../src/query/ui';

/*
 * `Device.uiTree` is what makes a selector action and an assertion possible
 * on a real device. It must not leave a scene artifact behind: a step can
 * dump several times, and none of those dumps belong to the capture.
 */

const probe = {
  identity: {
    abi: 'aarch64', productName: 'BRA-AL00', softwareVersion: 'BRA-AL00 7.0.0.111',
    osFullName: 'OpenHarmony-7.0.0.111', deviceType: 'phone', isEmulator: false,
  },
  abi: 'aarch64',
  isEmulator: false,
  binaries: { hitrace: true, hiperf: true, hidumper: true, hiprofiler_cmd: true, uitest: true },
  hiperfHwEvents: ['hw-cpu-cycles'], hiperfSwEvents: [],
  probes: {},
};

const hdc = { shell: async () => ({ stdout: '', stderr: '', code: 0 }) };

const NODE: UiNode = {
  depth: 0,
  type: 'Button',
  bundleName: 'com.demo',
  abilityName: 'Entry',
  text: 'OK',
  id: 'ok',
  bounds: '[0,0][100,100]',
  clickable: true,
  enabled: true,
  scrollable: false,
  children: 0,
  boundsRect: { left: 0, top: 0, right: 100, bottom: 100 },
};

describe('Device.uiTree', () => {
  it('dumps through the injected collector and returns its nodes', async () => {
    const seen: Array<{ target: string; uiFile: string }> = [];
    const device = new Device('t1', probe as never, {
      hdc: hdc as never,
      uitest: {
        collect: async (_hdc: unknown, target: string, _opts: unknown, layout: { uiFile: string }) => {
          seen.push({ target, uiFile: layout.uiFile });
          return [NODE];
        },
      } as never,
    });
    expect(await device.uiTree()).toEqual([NODE]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toBe('t1');
    // The dump goes to a temporary scene layout, never to a caller's directory.
    expect(seen[0]!.uiFile).toMatch(/ui\.json$/);
  });

  it('removes the temporary directory it dumped into', async () => {
    let uiFile = '';
    const device = new Device('t1', probe as never, {
      hdc: hdc as never,
      uitest: {
        collect: async (_hdc: unknown, _target: string, _opts: unknown, layout: { uiFile: string }) => {
          uiFile = layout.uiFile;
          return [NODE];
        },
      } as never,
    });
    await device.uiTree();
    const { existsSync } = await import('node:fs');
    expect(existsSync(uiFile)).toBe(false);
    expect(existsSync(uiFile.replace(/ui\.json$/, ''))).toBe(false);
  });

  it('removes the temporary directory when the dump fails', async () => {
    let root = '';
    const device = new Device('t1', probe as never, {
      hdc: hdc as never,
      uitest: {
        collect: async (_hdc: unknown, _target: string, _opts: unknown, layout: { uiFile: string }) => {
          root = layout.uiFile.replace(/ui\.json$/, '');
          throw new Error('dump failed');
        },
      } as never,
    });
    await expect(device.uiTree()).rejects.toThrow(/dump failed/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(root)).toBe(false);
  });

  it('asks the collector for full rows, because a selector taps a rect', async () => {
    // The defect this pins: a capture's `ui.json` carries the `bounds` string
    // but not the rect parsed from it, so a selector read that reused the
    // capture's options got 86 nodes and 0 rects on a real device — every
    // `tap` refused with "no parseable bounds" for a valid bounds string.
    let seen: unknown;
    const device = new Device('t1', probe as never, {
      hdc: hdc as never,
      uitest: {
        collect: async (_hdc: unknown, _target: string, opts: unknown) => {
          seen = opts;
          return [NODE];
        },
      } as never,
    });
    await device.uiTree();
    expect(seen).toMatchObject({ full: true });
  });

  it('refuses when uitest is absent, naming the matrix reason', async () => {
    const noUitest = { ...probe, binaries: { ...probe.binaries, uitest: false } };
    const device = new Device('t1', noUitest as never, { hdc: hdc as never });
    await expect(device.uiTree()).rejects.toMatchObject({
      code: 'MISSING_CAPABILITY',
      message: expect.stringContaining('uitest not present on device'),
    });
  });
});
