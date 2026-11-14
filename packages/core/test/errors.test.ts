import { describe, it, expect } from 'vitest';
import { HdcNotFoundError, IngestError, OhosPerfError } from '../src/errors';

describe('errors', () => {
  it('HdcNotFoundError carries searched paths', () => {
    const e = new HdcNotFoundError(['/a/hdc', '/b/hdc']);
    expect(e).toBeInstanceOf(OhosPerfError);
    expect(e.searchedPaths).toEqual(['/a/hdc', '/b/hdc']);
    expect(e.message).toContain('/a/hdc');
  });

  it('IngestError carries stderr and code', () => {
    const e = new IngestError('streamer failed', 'boom', 'STREAMER_EXIT_1');
    expect(e.stderr).toBe('boom');
    expect(e.code).toBe('STREAMER_EXIT_1');
  });
});
