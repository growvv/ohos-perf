import { defineConfig } from 'vitest/config';
import { nodeSqliteShim } from './vitest.shim';

/**
 * The `unit` project: every fake-injected test. Fast, fully parallel, and what
 * a CI run without an attached device sees.
 *
 * The device suites live in `vitest.workspace.ts` and run serially — they
 * share one device, and hitrace, uitest and hiprofiler each own a single fixed
 * device path.
 */
export default defineConfig({
  plugins: [nodeSqliteShim],
  test: {
    name: 'unit',
    include: ['packages/**/test/**/*.test.ts'],
    exclude: ['packages/**/test/**/*.device.test.ts'],
  },
});
