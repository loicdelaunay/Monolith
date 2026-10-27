#!/usr/bin/env node
// Aligne la version de GUI, CLI et moteur sur celle du package.json racine.
// Usage : node scripts/sync-version.mjs [nouvelle-version]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const rootPkgPath = join(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const next = process.argv[2] ?? rootPkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`Version SemVer invalide : ${next}`);
  process.exit(1);
}

const manifests = ['package.json', 'packages/contracts/package.json', 'packages/core/package.json', 'apps/desktop/package.json', 'apps/cli/package.json'];
for (const rel of manifests) {
  const path = join(root, rel);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = next;
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) if (name.startsWith('@monolith/')) pkg[field][name] = next;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

const versionTs = join(root, 'packages/contracts/src/version.ts');
writeFileSync(versionTs, readFileSync(versionTs, 'utf8').replace(/APP_VERSION = '[^']+'/, `APP_VERSION = '${next}'`));

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${next} `)) console.warn(`Attention : aucune entrée « ## ${next} — date » dans CHANGELOG.md.`);
console.log(`Version ${next} appliquée à ${manifests.length} manifestes et à packages/contracts/src/version.ts. Exécutez npm install pour mettre à jour le lockfile.`);
