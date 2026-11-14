import { describe, it, expect } from 'vitest';
import { doctorReport } from '../src/doctor';

describe('doctorReport', () => {
  it('reports hdc failure without throwing', async () => {
    const r = await doctorReport({
      resolveHdc: async () => { throw new Error('no hdc'); },
      resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }),
      connectDevice: async () => { throw new Error('no device'); },
    });
    expect(r.hdc.ok).toBe(false);
    expect(r.hdc.error).toContain('no hdc');
    expect(r.streamer.ok).toBe(true);
    expect(r.device).toBeUndefined();
    expect(r.capabilities).toEqual([]);
  });

  it('reports full success with sorted capabilities', async () => {
    const r = await doctorReport({
      resolveHdc: async () => '/h',
      resolveStreamer: async () => ({ path: '/s', version: '4.3.7' }),
      connectDevice: async () => ({
        id: 't1', kind: 'emulator', abi: 'x86_64',
        capabilities: async () => ({
          all: () => [
            { id: 'ui.tree', available: true, fidelity: 'exact', probe: {} },
            { id: 'perf.pmu', available: false, fidelity: 'exact', reason: 'x', probe: {} },
          ],
        }),
      }) as any,
    });
    expect(r.hdc.ok).toBe(true);
    expect(r.device?.id).toBe('t1');
    expect(r.capabilities.map((c) => c.id)).toEqual(['perf.pmu', 'ui.tree']);
  });

  it('keeps going when streamer fails but hdc and device work', async () => {
    const r = await doctorReport({
      resolveHdc: async () => '/h',
      resolveStreamer: async () => { throw new Error('no streamer'); },
      connectDevice: async () => ({
        id: 't1', kind: 'real', abi: 'aarch64',
        capabilities: async () => ({ all: () => [] }),
      }) as any,
    });
    expect(r.hdc.ok).toBe(true);
    expect(r.streamer.ok).toBe(false);
    expect(r.streamer.error).toContain('no streamer');
    expect(r.device?.id).toBe('t1');
  });
});
