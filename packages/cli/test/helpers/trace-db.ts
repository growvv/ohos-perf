import { DatabaseSync } from 'node:sqlite';

/**
 * Minimal trace database the analyzer can query.
 *
 * Same fixture as the inline `createTraceDb` in `deps.test.ts` (two
 * `frame_slice` rows and an empty `process` table), lifted into a helper so
 * the entry-point tests can exercise a successful `analyze` without the
 * 17.9 MB `spike/out/emu_big.db`, which is gitignored and absent on a clean
 * checkout. `deps.test.ts` keeps its own copy so its existing assertions are
 * untouched.
 */
export function createTraceDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE frame_slice(id INT, ts INT, vsync INT, ipid INT, itid INT,
    callstack_id INT, dur INT, src TEXT, dst INT, type INT, type_desc TEXT,
    flag INT, depth INT, frame_no INT)`);
  db.exec(`INSERT INTO frame_slice VALUES
    (0, 1000, 0, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 0),
    (1, 2000, 1, 17, 44, 0, 16000000, '', 0, 0, 'actural', 0, 0, 1)`);
  db.exec(`CREATE TABLE process(id INT, ipid INT, pid INT, name TEXT, start_ts INT,
    switch_count INT, thread_count INT, slice_count INT, mem_count INT)`);
  db.close();
}
