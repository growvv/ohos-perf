/**
 * Vitest 2.1's bundled vite-node does not classify `node:sqlite` as a Node
 * builtin on Node >= 24 (Node lists it in `builtinModules` with the `node:`
 * prefix, while vite-node strips that prefix before checking). Without this
 * shim, importing `node:sqlite` fails with "Failed to load url sqlite".
 *
 * The shim resolves `node:sqlite` (and the stripped `sqlite` id) to a tiny
 * module that re-exports the real builtin via `process.getBuiltinModule`.
 *
 * Shared by both vitest projects (see `vitest.workspace.ts`).
 */
export const nodeSqliteShim = {
  name: 'node-sqlite-shim',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'sqlite' || id === 'node:sqlite') return '\0node-sqlite-shim';
  },
  load(id: string) {
    if (id === '\0node-sqlite-shim') {
      return 'const m = process.getBuiltinModule("node:sqlite"); export const DatabaseSync = m.DatabaseSync; export default m;';
    }
  },
};
