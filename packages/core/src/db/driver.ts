import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { OhosPerfError } from '../errors';
import { loadDatabaseSync } from './sqlite';

export interface QueryHandle {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
  readonly path: string;
}

/**
 * Opens a trace database read-only.
 *
 * `node:sqlite` only opens the file at construction; it defers header
 * validation and WAL/journal recovery until the first statement. An
 * unreadable database (missing `-shm`, hot rollback journal, corrupt header)
 * therefore surfaces at query time as a plain SQLite error, not at open time.
 * The only errors thrown here are those SQLite reports at open, such as a
 * missing file or directory.
 */
export function openDb(path: string): QueryHandle {
  // Loaded outside the try: a missing node:sqlite module is a
  // RUNTIME_UNSUPPORTED condition, not a DB_OPEN_FAILED one, and wrapping it
  // would hide the version guidance. openDb's signature is unchanged.
  const DatabaseSyncCtor = loadDatabaseSync();
  let db: DatabaseSync;
  try {
    db = new DatabaseSyncCtor(path, { readOnly: true });
  } catch (err) {
    throw new OhosPerfError(`failed to open trace database: ${path}`, {
      cause: err,
      code: 'DB_OPEN_FAILED',
    });
  }

  let closed = false;

  return {
    path,
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

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Counts rows of every user table. Keys are inserted in sorted order so
 * `JSON.stringify` output is byte-stable across runs and platforms.
 *
 * The null prototype keeps a table literally named `__proto__` as an own
 * property. Keys that look like array indices cannot be reordered by
 * insertion, so a proxy reports them in the same sorted order used for
 * `Object.keys`/`JSON.stringify`.
 */
export function tableRowCounts(db: QueryHandle): Record<string, number> {
  const tables = db
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .map((row) => row.name)
    .sort();

  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const name of tables) {
    const [row] = db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(name)}`,
    );
    counts[name] = Number(row?.n ?? 0);
  }
  return new Proxy(counts, {
    ownKeys: () => tables,
    getOwnPropertyDescriptor: (target, key) =>
      Reflect.getOwnPropertyDescriptor(target, key),
  });
}
