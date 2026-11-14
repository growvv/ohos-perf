/**
 * Single place where the process talks to Node's built-in SQLite.
 *
 * Kept as its own module so tests can substitute a fake constructor without
 * relying on mocking a Node built-in (which some test runners do not resolve
 * to the same module id).
 */
export { DatabaseSync } from 'node:sqlite';
