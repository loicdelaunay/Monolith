// Bundle du CLI : un seul fichier ESM (dist/monolith.mjs), base des exécutables autonomes (Node SEA).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.tsx'],
  outfile: 'dist/monolith.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  loader: { '.md': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      // react-devtools-core : import optionnel d'Ink réservé au développement, remplacé par un module vide.
      name: 'stub-devtools',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} };', loader: 'js' }));
      },
    },
  ],
  banner: {
    js: `#!/usr/bin/env node\nimport { createRequire as __mhCreateRequire } from 'node:module';\nconst require = __mhCreateRequire(import.meta.url);\n// Monolith Harness CLI ${pkg.version}`,
  },
  legalComments: 'linked',
  logLevel: 'info',
});
