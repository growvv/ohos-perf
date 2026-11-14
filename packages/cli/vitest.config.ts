import { defineConfig } from 'vitest/config';

/**
 * Vitest 2.1's bundled vite-node does not classify `node:sqlite` as a Node
 * builtin on Node >= 24 (Node lists it in `builtinModules` with the `node:`
 * prefix, while vite-node strips that prefix before checking).
 *
 * The CLI never imports `node:sqlite` directly, but it imports
 * `@ohos-perf/core`, which does — so the CLI's own config needs the same shim
 * as the root config. Without it, `npm test -w @ohos-perf/cli` fails with
 * "Failed to load url sqlite".
 */
const nodeSqliteShim = {
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

export default defineConfig({
  plugins: [nodeSqliteShim],
  test: { include: ['test/**/*.test.ts'] },
});
