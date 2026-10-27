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
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      chunkSizeWarningLimit: 2000,
    },
  },
});
