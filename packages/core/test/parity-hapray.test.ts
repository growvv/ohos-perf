import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type QueryHandle } from '../src/db/driver';
import { computeFaultTree } from '../src/analyze/fault-tree';

/**
 * HapRay parity on the recorded traces.
 *
 * The traces live in the gitignored `spike/out/` directory, so each case skips
 * visibly when the file is absent; when present it must run. The golden files
 * are the `step1` payload produced by HapRay rev `9386e4e` (see
 * `scripts/parity/README.md`), not values authored here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures/hapray');
const SPIKE_OUT = join(here, '../../../spike/out');

const EMU_DB = join(SPIKE_OUT, 'emu_big.db');
const REAL_DB = join(SPIKE_OUT, 'real_device.db');

function readGolden<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** Runs `fn` with a read-only handle and always closes it. */
function withDb<T>(path: string, fn: (db: QueryHandle) => T): T {
  const db = openDb(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('HapRay parity', () => {
  describe('fault tree', () => {
    it.skipIf(!existsSync(EMU_DB))(
      'emu_big matches the FaultTreeAnalyzer golden',
      () => {
        const actual = withDb(EMU_DB, (db) =>
          computeFaultTree(db, { appPids: [16702] }),
        );
        expect(actual).toEqual(readGolden('fault-tree.emu_big.json'));

        // Pinned values so a same-shape regression cannot hide behind the
        // deep-equal (the golden is regenerated rarely).
        expect(actual.arkui.HandleOnAreaChangeEvent).toBe(51);
        expect(actual.arkui.MarshRSTransactionData).toBe(56);
        expect(actual.RS.UnMarshRSTransactionData).toBe(63);
        expect(actual.RS.ProcessedNodes).toEqual({ ts: 28.604984, count: 34 });
        expect(actual.RS.AnimateSize).toEqual({
          nodeSizeSum: 67,
          totalAnimationSizeSum: 67,
        });
      },
    );

    it.skipIf(!existsSync(REAL_DB))(
      'real_device matches the FaultTreeAnalyzer golden',
      () => {
        const actual = withDb(REAL_DB, (db) =>
          computeFaultTree(db, { appPids: [6115] }),
        );
        expect(actual).toEqual(readGolden('fault-tree.real_device.json'));

        expect(actual.arkui.GetDefaultDisplay).toBe(4);
        expect(actual.RS.ProcessedNodes).toEqual({ ts: 0.04111198, count: 84 });
        expect(actual.RS.DisplayNodeSkipTimes).toBe(4);
        expect(actual.RS.UnMarshRSTransactionData).toBe(1);
        expect(actual.RS.AnimateSize).toEqual({
          nodeSizeSum: 79,
          totalAnimationSizeSum: 87,
        });
      },
    );
  });
});
