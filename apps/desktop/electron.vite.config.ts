import { builtinModules } from 'node:module';

import { defineConfig } from 'electron-vite';

// `electron` and node builtins MUST stay external for both main and preload.
// If `electron` is bundled, its npm path-shim (getElectronPath, require('child_process'))
// is inlined — which crashes the main process at launch AND fails to load the
// sandboxed preload (no child_process in a sandbox). electron-updater (main only) is
// NOT in this list, so it gets bundled, keeping the main output self-contained for
// electron-builder (bun's hoisted node_modules aren't reliably packable).
const external = ['electron', /^node:/, ...builtinModules];

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts' },
        output: { format: 'cjs', entryFileNames: '[name].js' },
        external,
      },
    },
  },
  // CJS output is required for the sandboxed preloads (site + title bar).
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          titlebar: 'src/preload/titlebar.ts',
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
        external,
      },
    },
  },
});
