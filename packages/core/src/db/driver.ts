import type { SQLInputValue } from 'node:sqlite';
import { DatabaseSync } from './sqlite';

/** How the underlying SQLite file ended up being opened. */
export type OpenMode = 'read-only' | 'read-write';

export interface QueryHandle {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
  readonly path: string;
  /** `read-write` when the read-only open failed and the fallback was used. */
  readonly mode: OpenMode;
}

/**
 * Read-only opens can fail when the database needs recovery through its
 * `-wal`/`-shm` files (trace_streamer output occasionally does). SQLite's
 * message for this contains "readonly" / "read-only"; anything else is a real
 * error and must propagate.
 */
function isReadOnlyOpenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /read-?only/i.test(message);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Opens a trace database. Tries read-only first; falls back to a writable open
 * only when SQLite reports a read-only-specific failure.
 */
export function openDb(path: string): QueryHandle {
  let db: DatabaseSync;
  let mode: OpenMode = 'read-only';

  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    if (!isReadOnlyOpenError(err)) throw err;
    db = new DatabaseSync(path);
    mode = 'read-write';
  }

  let closed = false;

  return {
    path,
    mode,
    query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * Counts rows of every user table. Keys are inserted in sorted order so
 * `JSON.stringify` output is byte-stable across runs and platforms.
 */
export function tableRowCounts(db: QueryHandle): Record<string, number> {
  const tables = db
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .map((row) => row.name)
    .sort();

  const counts: Record<string, number> = {};
  for (const name of tables) {
    const [row] = db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`,
    );
    counts[name] = Number(row?.n ?? 0);
  }
  return counts;
}
