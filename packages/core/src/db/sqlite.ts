/**
 * Single place where the process talks to Node's built-in SQLite.
 *
 * Kept as its own module so tests can substitute a fake constructor without
 * relying on mocking a Node built-in (which some test runners do not resolve
 * to the same module id).
 *
 * `node:sqlite` is loaded lazily on purpose: on Node 22.5-22.12 the module does
 * not exist unflagged, and a top-level re-export would make importing this
 * package fail with `ERR_UNKNOWN_BUILTIN_MODULE` before any of our code can
 * explain the real requirement. `process.getBuiltinModule` exists since Node
 * 22.3.0, so this guard is safe to call on every Node the package can run on.
 */
import { OhosPerfError } from '../errors';

type DatabaseSyncModule = typeof import('node:sqlite');
export type DatabaseSyncCtor = DatabaseSyncModule['DatabaseSync'];

let cached: DatabaseSyncCtor | undefined;

/**
 * Returns the `node:sqlite` `DatabaseSync` constructor, or throws
 * `RUNTIME_UNSUPPORTED` when the running Node does not provide it.
 *
 * The manifests express the same supported set as `^22.13.0 || >=23.4.0`
 * (23.0-23.3 never shipped the module). `engines` is advisory in npm, though:
 * a violation only warns, and `--engine-strict` turns that warning into an
 * install error. This runtime check is what actually turns the gap into a
 * clear error. Callers must not wrap this
 * error: it carries the version guidance, not a database-open failure.
 */
export function loadDatabaseSync(): DatabaseSyncCtor {
  if (cached) return cached;
  const mod = process.getBuiltinModule('node:sqlite') as
    | { DatabaseSync?: DatabaseSyncCtor }
    | undefined;
  if (typeof mod?.DatabaseSync !== 'function') {
    throw new OhosPerfError(
      `This Node.js (${process.version}) does not provide the unflagged node:sqlite module; ` +
        `@ohos-perf/core requires Node.js >=22.13.0 (23.0-23.3 also lack it; use 23.4+). ` +
        `On 22.5-22.12, --experimental-sqlite enables it.`,
      { code: 'RUNTIME_UNSUPPORTED' },
    );
  }
  cached = mod.DatabaseSync;
  return cached;
}
