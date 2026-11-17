import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type QueryHandle } from '../src/db/driver';
import { PerfQuery, isUnresolvedSymbol } from '../src/query/perf';

/*
 * Symbol resolution, tested against the shape a real capture has.
 *
 * On a measured HarmonyOS capture every `perf_callchain.name` was a
 * `data_dict` id and 437,767 of 437,767 frames with a symbol hit their
 * `(file_id, serial_id)` row exactly. The frames that missed were frames whose
 * `symbol_id` is `-1` — the recorder had no symbol — and the shipped code gave
 * them the first `perf_files` row of their file instead: 7.14% of all leaf
 * weight was attributed to a neighbour.
 *
 * These fixtures are that shape in miniature.
 */

const PERF_THREAD_DDL = `CREATE TABLE perf_thread(id INT, thread_id INT, process_id INT,
  thread_name TEXT)`;
const PERF_SAMPLE_DDL = `CREATE TABLE perf_sample(id INT, callchain_id INT, timeStamp INT,
  thread_id INT, event_count INT, event_type_id INT, timestamp_trace INT, cpu_id INT,
  thread_state TEXT)`;
const PERF_CALLCHAIN_DDL = `CREATE TABLE perf_callchain(id INT, callchain_id INT, depth INT,
  ip INT, vaddr_in_file INT, offset_to_vaddr INT, file_id INT, symbol_id INT, name INT,
  source_file_id INT, line_number INT)`;
const PERF_FILES_DDL = `CREATE TABLE perf_files(id INT, file_id INT, serial_id INT,
  symbol TEXT, path TEXT)`;
const DATA_DICT_DDL = 'CREATE TABLE data_dict(id INT, data TEXT)';

let dir: string;

/** A database holding the perf tables plus `data_dict`, built from raw SQL. */
function withDb(name: string, build: (d: DatabaseSync) => void): QueryHandle {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  build(db);
  db.close();
  return openDb(path);
}

/**
 * The measured shape: file 2 has two symbols, `dlopen` (serial 0) sorting
 * before `dladdr` (serial 1). The `symbol_id = -1` frame in file 2 must not
 * inherit `dlopen`.
 */
function measuredDb(name = 'measured.db'): QueryHandle {
  return withDb(name, (d) => {
    d.exec(PERF_THREAD_DDL);
    d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
    d.exec(PERF_SAMPLE_DDL);
    d.exec(`INSERT INTO perf_sample VALUES
      (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
      (1, 11, 1100, 100, 7, 1, 1100, 0, 'S'),
      (2, 12, 1200, 100, 3, 1, 1200, 0, 'S')`);
    d.exec(PERF_CALLCHAIN_DDL);
    d.exec(`INSERT INTO perf_callchain VALUES
      (0, 10, 0, 0, 0, 0, 2, -1, 9675, 0, 0),
      (1, 11, 0, 0, 0, 0, 2, 1, 488, 0, 0),
      (2, 12, 0, 0, 0, 0, 3, 9, 9800, 0, 0)`);
    d.exec(PERF_FILES_DDL);
    d.exec(`INSERT INTO perf_files VALUES
      (0, 2, 0, 'dlopen', '/system/lib/ld-musl.so'),
      (1, 2, 1, 'dladdr', '/system/lib/ld-musl.so'),
      (2, 3, 0, 'JDImageLoad', '/lib/libjdimage.so')`);
    d.exec(DATA_DICT_DDL);
    d.exec(`INSERT INTO data_dict VALUES
      (488, 'start'),
      (9675, 'ld-musl.so+0xa2df8'),
      (9800, 'libjdimage.so+0x1cce24')`);
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohosperf-symbols-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isUnresolvedSymbol', () => {
  it('treats an empty symbol and a file+0xoffset reference as unresolved', () => {
    expect(isUnresolvedSymbol('')).toBe(true);
    expect(isUnresolvedSymbol('libfoo.so+0x1cce24')).toBe(true);
    expect(isUnresolvedSymbol('entry.hap+0x22b621e')).toBe(true);
  });

  it('treats a name as resolved', () => {
    expect(isUnresolvedSymbol('dladdr')).toBe(false);
    expect(isUnresolvedSymbol('base::Thread::ThreadMain()')).toBe(false);
    expect(isUnresolvedSymbol('libfoo.so')).toBe(false);
    // A space means the text is a sentence or a demangled signature with
    // parameters, never the converter's `file+0xoffset` form.
    expect(isUnresolvedSymbol('a b+0x1')).toBe(false);
  });
});

describe('PerfQuery symbol resolution', () => {
  it('takes an exact (file_id, serial_id) row as authoritative', () => {
    const db = measuredDb('exact.db');
    try {
      const chains = new PerfQuery(db).callchains([100], { startNs: 1100, endNs: 1100 });
      // file 2 / symbol 1 is `dladdr`; data_dict[488] is 'start', which the
      // exact row beats.
      expect(chains[0]!.functions).toEqual([
        { symbol: 'dladdr', name: 'dladdr', filePath: '/system/lib/ld-musl.so' },
      ]);
    } finally {
      db.close();
    }
  });

  it('never gives a symbol_id = -1 frame its file\'s first symbol', () => {
    const db = measuredDb('minus-one.db');
    try {
      const rows = new PerfQuery(db).leafAttribution([100], { startNs: 1000, endNs: 1000 });
      // The regression test for the measured defect: `dlopen` sorts first in
      // file 2, and the shipped code called this frame `dlopen`.
      expect(rows).toEqual([{
        symbol: 'ld-musl.so+0xa2df8',
        filePath: '/system/lib/ld-musl.so',
        samples: 5,
        unresolved: true,
      }]);
    } finally {
      db.close();
    }
  });

  it('falls through to data_dict when the exact row is missing', () => {
    const db = measuredDb('missing-exact.db');
    try {
      const rows = new PerfQuery(db).leafAttribution([100], { startNs: 1200, endNs: 1200 });
      // file 3 / symbol 9 has no perf_files row; data_dict names the address.
      expect(rows).toEqual([{
        symbol: 'libjdimage.so+0x1cce24',
        filePath: '/lib/libjdimage.so',
        samples: 3,
        unresolved: true,
      }]);
    } finally {
      db.close();
    }
  });

  it('falls through to data_dict when the exact row\'s symbol is empty', () => {
    const db = withDb('empty-symbol.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES (0, 10, 1000, 100, 4, 1, 1000, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 2, 1, 100, 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(`INSERT INTO perf_files VALUES (0, 2, 1, '', '/lib/libx.so')`);
      d.exec(DATA_DICT_DDL);
      d.exec(`INSERT INTO data_dict VALUES (100, 'libx.so+0xbeef')`);
    });
    try {
      const rows = new PerfQuery(db).leafAttribution([100], { startNs: 0, endNs: 2000 });
      expect(rows).toEqual([{
        symbol: 'libx.so+0xbeef', filePath: '/lib/libx.so', samples: 4, unresolved: true,
      }]);
    } finally {
      db.close();
    }
  });

  it('drops a leaf with no symbol from anywhere, as before', () => {
    const db = withDb('no-symbol.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES (0, 10, 1000, 100, 4, 1, 1000, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 2, 1, 100, 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(`INSERT INTO perf_files VALUES (0, 2, 1, '', '/lib/libx.so')`);
      d.exec(DATA_DICT_DDL);
    });
    try {
      // `leafAttribution` is the resolved population; a frame with no symbol
      // at all contributes nothing to it. `symbolStats` still counts it.
      expect(new PerfQuery(db).leafAttribution([100], { startNs: 0, endNs: 2000 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('resolves the file path from file_id alone, so an unresolved frame names its library', () => {
    const db = measuredDb('path-only.db');
    try {
      const rows = new PerfQuery(db).unresolvedSymbols([100], { startNs: 1000, endNs: 1000 });
      // The path is a property of the file (one path per file_id on a real
      // capture), so it resolves even when no symbol does. Without it the
      // evidence would say "something was unresolved" and name nothing.
      expect(rows[0]!.filePath).toBe('/system/lib/ld-musl.so');
    } finally {
      db.close();
    }
  });

  it('falls back to the raw name when there is no data_dict table', () => {
    const db = withDb('no-dict.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES (0, 10, 1000, 100, 4, 1, 1000, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 2, -1, 9675, 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(`INSERT INTO perf_files VALUES (0, 2, 0, 'dlopen', '/lib/libx.so')`);
    });
    try {
      const rows = new PerfQuery(db).leafAttribution([100], { startNs: 0, endNs: 2000 });
      // No dictionary to consult: the raw column is all there is.
      expect(rows).toEqual([{
        symbol: '9675', filePath: '/lib/libx.so', samples: 4, unresolved: false,
      }]);
    } finally {
      db.close();
    }
  });

  it('keeps a name that is already a symbol rather than reading it as an id', () => {
    const db = withDb('name-is-symbol.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES (0, 10, 1000, 100, 4, 1, 1000, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      // `name` here is the text 'start', not an id. A fixture — or a future
      // converter — that writes symbols into this column must not be blanked.
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, NULL, NULL, 'start', 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(DATA_DICT_DDL);
      d.exec(`INSERT INTO data_dict VALUES (488, 'unrelated')`);
    });
    try {
      const rows = new PerfQuery(db).leafAttribution([100], { startNs: 0, endNs: 2000 });
      expect(rows).toEqual([{ symbol: 'start', filePath: '', samples: 4, unresolved: false }]);
    } finally {
      db.close();
    }
  });
});

describe('PerfQuery.symbolStats', () => {
  it('sums weight per (symbol, filePath, unresolved), sorted deterministically', () => {
    const db = measuredDb('stats.db');
    try {
      const rows = new PerfQuery(db).symbolStats([100], { startNs: 0, endNs: 2000 });
      expect(rows).toEqual([
        {
          symbol: 'dladdr', filePath: '/system/lib/ld-musl.so', samples: 7, unresolved: false,
        },
        {
          symbol: 'ld-musl.so+0xa2df8',
          filePath: '/system/lib/ld-musl.so',
          samples: 5,
          unresolved: true,
        },
        {
          symbol: 'libjdimage.so+0x1cce24',
          filePath: '/lib/libjdimage.so',
          samples: 3,
          unresolved: true,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('is the whole window: resolved rows plus unresolved weight equal eventCount', () => {
    const db = measuredDb('identity.db');
    try {
      const q = new PerfQuery(db);
      const rows = q.symbolStats([100], { startNs: 0, endNs: 2000 });
      const total = rows.reduce((sum, row) => sum + row.samples, 0);
      expect(total).toBe(q.eventCount([100], { startNs: 0, endNs: 2000 }));
    } finally {
      db.close();
    }
  });

  it('keeps the weight of a chain with no frames in the identity', () => {
    // A capture can hold a `perf_sample` whose `callchain_id` has no
    // `perf_callchain` rows — a truncated conversion, or a kernel chain the
    // recorder dropped. That weight names nothing, but it is still weight in
    // the window: dropping it makes the analyzer's "resolved plus unresolved
    // is the window" claim false, and makes the unresolved share read better
    // than the capture is.
    const db = withDb('frame-less-chain.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES
        (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
        (1, 11, 1100, 100, 5, 1, 1100, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      // Chain 10 has a frame; chain 11 has none at all.
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 1, 0, 900, 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(`INSERT INTO perf_files VALUES (0, 1, 0, 'main', '/system/bin/app_process')`);
      d.exec(DATA_DICT_DDL);
      d.exec(`INSERT INTO data_dict VALUES (900, 'main')`);
    });
    try {
      const q = new PerfQuery(db);
      const rows = q.symbolStats([100], { startNs: 0, endNs: 2000 });
      expect(rows.reduce((sum, row) => sum + row.samples, 0))
        .toBe(q.eventCount([100], { startNs: 0, endNs: 2000 }));
      // The frame-less weight is named by nothing, so it is unresolved.
      expect(rows.find((row) => row.samples === 5 && row.unresolved && row.symbol === ''))
        .toBeDefined();
    } finally {
      db.close();
    }
  });

  it('keeps the weight of a sample that recorded no call chain at all', () => {
    // A recorder that could not unwind still records the sample: the row
    // exists with `callchain_id` NULL. `eventCount` counts its weight, so a
    // table that skips it makes the documented identity false and every
    // `symbol.stats` share sum to less than 100%.
    const db = withDb('null-chain.db', (d) => {
      d.exec(PERF_THREAD_DDL);
      d.exec(`INSERT INTO perf_thread VALUES (0, 100, 500, 'main')`);
      d.exec(PERF_SAMPLE_DDL);
      d.exec(`INSERT INTO perf_sample VALUES
        (0, 10, 1000, 100, 5, 1, 1000, 0, 'S'),
        (1, NULL, 1100, 100, 5, 1, 1100, 0, 'S')`);
      d.exec(PERF_CALLCHAIN_DDL);
      d.exec(`INSERT INTO perf_callchain VALUES (0, 10, 0, 0, 0, 0, 1, 0, 900, 0, 0)`);
      d.exec(PERF_FILES_DDL);
      d.exec(`INSERT INTO perf_files VALUES (0, 1, 0, 'main', '/system/bin/app_process')`);
      d.exec(DATA_DICT_DDL);
      d.exec(`INSERT INTO data_dict VALUES (900, 'main')`);
    });
    try {
      const q = new PerfQuery(db);
      const rows = q.symbolStats([100], { startNs: 0, endNs: 2000 });
      expect(rows.reduce((sum, row) => sum + row.samples, 0))
        .toBe(q.eventCount([100], { startNs: 0, endNs: 2000 }));
      // It names nothing, so it is unresolved weight.
      expect(rows.find((row) => row.symbol === '' && row.filePath === '' && row.unresolved))
        .toMatchObject({ samples: 5, unresolved: true });
    } finally {
      db.close();
    }
  });

  it('reports unresolvedSymbols as a subset of symbolStats, never additional', () => {
    const db = measuredDb('subset.db');
    try {
      const q = new PerfQuery(db);
      const all = q.symbolStats([100], { startNs: 0, endNs: 2000 });
      const unresolved = q.unresolvedSymbols([100], { startNs: 0, endNs: 2000 });
      expect(unresolved).toEqual(all.filter((row) => row.unresolved));
      // Adding the two populations would double-count this weight.
      expect(unresolved.reduce((sum, row) => sum + row.samples, 0)).toBe(8);
      expect(all.reduce((sum, row) => sum + row.samples, 0)).toBe(15);
    } finally {
      db.close();
    }
  });

  it('returns [] for an empty thread list and for a database without the perf tables', () => {
    const empty = withDb('stats-empty.db', () => {});
    try {
      expect(new PerfQuery(empty).symbolStats([], { startNs: 0, endNs: 10 })).toEqual([]);
      expect(new PerfQuery(empty).symbolStats([1], { startNs: 0, endNs: 10 })).toEqual([]);
      expect(new PerfQuery(empty).unresolvedSymbols([1], { startNs: 0, endNs: 10 })).toEqual([]);
    } finally {
      empty.close();
    }
  });
});
