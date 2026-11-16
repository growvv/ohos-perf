import { describe, it, expect } from 'vitest';
import { Device } from '../src/device/device';
import type { Gesture } from '../src/device/gesture';

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

describe('Device.gesture', () => {
  it('delegates to the injected driver with the device id', async () => {
    const seen: Array<{ target: string; gesture: Gesture }> = [];
    const device = new Device('t1', probe as never, {
      hdc: hdc as never,
      gesture: {
        perform: async (_hdc: unknown, target: string, gesture: Gesture) => {
          seen.push({ target, gesture });
          return { gesture, output: 'No Error' };
        },
      } as never,
    });
    const gesture: Gesture = { action: 'key', key: 'Home' };
    const result = await device.gesture(gesture);
    expect(seen).toEqual([{ target: 't1', gesture }]);
    expect(result).toEqual({ gesture, output: 'No Error' });
  });

  it('refuses to gesture when uitest is absent, naming the matrix reason', async () => {
    const noUitest = { ...probe, binaries: { ...probe.binaries, uitest: false } };
    const device = new Device('t1', noUitest as never, { hdc: hdc as never });
    await expect(device.gesture({ action: 'key', key: 'Home' })).rejects.toMatchObject({
      code: 'MISSING_CAPABILITY',
      message: expect.stringContaining('uitest not present on device'),
    });
  });
});
