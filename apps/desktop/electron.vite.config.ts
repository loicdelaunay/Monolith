import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// Les paquets internes (@monolith/*) sont regroupés dans les bundles : aucune dépendance
// n'est résolue à l'exécution depuis node_modules.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue()],
    // elkjs (EPL-2.0, ~2,6 Mo) remplacé par un module qui signale la disposition indisponible.
    resolve: { alias: { 'elkjs/lib/elk.bundled.js': resolve(__dirname, 'src/renderer/src/lib/stubs/elk.ts') } },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      chunkSizeWarningLimit: 2000,
    },
  },
});
