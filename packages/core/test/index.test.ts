import { describe, it, expect } from 'vitest';
import * as api from '../src/index';

describe('public surface', () => {
  it('exports the connect entry point', () => {
    expect(typeof api.connect).toBe('function');
  });

  it('exports all error classes', () => {
    for (const n of ['OhosPerfError', 'HdcNotFoundError', 'DeviceNotFoundError',
                     'StreamerNotFoundError', 'IngestError']) {
      expect((api as any)[n]).toBeTypeOf('function');
    }
  });

  it('exports analyzers, queries and models', () => {
    for (const n of ['FrameQuery', 'ProcessQuery', 'ThreadQuery', 'FrameAnalyzer',
                     'CapabilityMatrix', 'buildMatrix', 'metric', 'evidence',
                     'Device', 'Hdc', 'Streamer', 'Scene', 'openDb',
                     'HitraceCollector', 'HITRACE_DEFAULT_CATEGORIES',
                     'runProbe', 'createSceneLayout', 'ingestScene',
                     'tableRowCounts']) {
      expect((api as any)[n]).toBeDefined();
    }
  });

  it('does NOT leak internal implementation details', () => {
    // Value seams: under `export *` these WOULD become runtime properties.
    const valueSeams = [
      'num', 'str', 'DatabaseSync', 'parseBinaries', 'parseHiperfEvents',
      'buildConvertArgv', 'parseVersion', 'normalizeLocalPath', 'parseSize',
    ];
    // Type-only seams: erased at runtime by construction. Listing them
    // documents intent; only the value seams actually catch an `export *`
    // regression at runtime.
    const typeSeams = ['HdcOp', 'HdcArgvParams', 'SpawnSpec', 'SpawnResult'];
    for (const n of [...valueSeams, ...typeSeams]) {
      expect((api as any)[n]).toBeUndefined();
    }
  });
});
