#!/usr/bin/env node
// Inventaire des licences des dépendances embarquées dans les bundles (desktop et CLI).
// Produit THIRD-PARTY-LICENSES.txt et docs/LICENSES.md ; échoue si une licence n'est pas
// dans la liste des licences compatibles avec la distribution MIT du projet.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
// Racines réellement regroupées dans les bundles (Electron est fourni avec ses propres licences par electron-builder).
const ROOTS = {
  desktop: ['vue', 'primevue', '@primeuix/themes', 'primeicons', 'vue-i18n', 'markdown-it', 'shiki', 'katex', 'mermaid', 'undici', '@lobehub/icons-static-svg'],
  cli: ['ink', 'react', 'undici'],
};
// Paquets exclus des bundles (remplacés par un module local) et licences déclarées hors package.json.
const EXCLUDED = new Set(['elkjs']);
const KNOWN_LICENSES = { khroma: 'MIT' };
// Texte de licence absent du paquet publié : copie du texte amont (dépôt lobehub/lobe-icons).
const KNOWN_TEXTS = { '@lobehub/icons-static-svg': join(root, 'apps/desktop/build/licenses/lobe-icons-LICENSE.txt') };
const ALLOWED = new Set(['(MPL-2.0 OR Apache-2.0)', 'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'MIT-0', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'PSF-2.0', '(MIT OR CC0-1.0)', '(MIT OR Apache-2.0)', 'MIT OR Apache-2.0']);

function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

const found = new Map();
function visit(name, fromDir, app) {
  if (EXCLUDED.has(name)) return;
  const pkgPath = resolvePackage(name, fromDir);
  if (!pkgPath) return;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  const entry = found.get(key);
  if (entry) {
    entry.apps.add(app);
    return;
  }
  const dir = dirname(pkgPath);
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const license = KNOWN_LICENSES[pkg.name] ?? (typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN')));
  found.set(key, { name: pkg.name, version: pkg.version, license, apps: new Set([app]), text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : KNOWN_TEXTS[pkg.name] ? readFileSync(KNOWN_TEXTS[pkg.name], 'utf8').trim() : null, homepage: pkg.homepage ?? pkg.repository?.url ?? '' });
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir, app);
}

for (const [app, roots] of Object.entries(ROOTS)) {
  const base = join(root, 'apps', app);
  for (const r of roots) visit(r, base, app);
}

const entries = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
const rejected = entries.filter((e) => !ALLOWED.has(e.license));

let txt = 'Monolith Harness — licences des composants tiers\n\nLes composants ci-dessous sont regroupés dans les exécutables. Electron et Chromium sont accompagnés de leurs licences par electron-builder (LICENSE.electron.txt, LICENSES.chromium.html).\n\n';
for (const e of entries) {
  txt += `${'='.repeat(78)}\n${e.name} ${e.version} — ${e.license} (${[...e.apps].join(', ')})\n${e.homepage}\n\n${e.text ?? '(texte de licence absent du paquet : licence déclarée ci-dessus)'}\n\n`;
}
writeFileSync(join(root, 'THIRD-PARTY-LICENSES.txt'), txt);

let md = `# Licences des dépendances\n\nGénéré par \`npm run licenses\`. ${entries.length} paquets regroupés dans les bundles. Texte complet : [THIRD-PARTY-LICENSES.txt](../THIRD-PARTY-LICENSES.txt).\n\n| Paquet | Version | Licence | Utilisé par |\n| --- | --- | --- | --- |\n`;
for (const e of entries) md += `| ${e.name} | ${e.version} | ${e.license} | ${[...e.apps].join(', ')} |\n`;
md += `\nPrimeVue est volontairement figé en **4.5.x (MIT)** : PrimeVue 5 est distribué sous licence propriétaire PrimeUI.\n`;
writeFileSync(join(root, 'docs/LICENSES.md'), md);

console.log(`${entries.length} paquets inventoriés.`);
if (rejected.length) {
  console.error('Licences à examiner :');
  for (const e of rejected) console.error(`  ${e.name}@${e.version} : ${e.license}`);
  process.exit(1);
}
