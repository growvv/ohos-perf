import { defineConfig } from 'tsup';

/**
 * tsup defaults `removeNodeProtocol` to true, rewriting `node:` imports to
 * their bare form. That is wrong for `node:sqlite`: unlike most builtins, it
 * has no bare alias, so the emitted `import ... from "sqlite"` fails to
 * resolve at load time. Keeping the prefix makes `dist/index.js` importable.
 */
export default defineConfig({
  removeNodeProtocol: false,
});
