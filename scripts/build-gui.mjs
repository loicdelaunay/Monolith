#!/usr/bin/env node
// Build GUI de test : un seul dossier, artifacts/GUI, contenant la dernière version avec
// l'exécutable Monolith.exe. Les données de test (data/, monolith.location.json) sont conservées.
// Les paquets de distribution (zip, installeur) sont produits séparément dans release/.
// Usage : node scripts/build-gui.mjs [win|linux]
import { execSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const linux = process.argv[2] === 'linux';
const staging = join(root, 'artifacts', '.gui-staging');
const gui = join(root, 'artifacts', 'GUI');
const KEEP = new Set(['data', 'monolith.location.json']);
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

rmSync(staging, { recursive: true, force: true });
run('npm run build -w @monolith/desktop', root);
run(`npx electron-builder ${linux ? '--linux' : '--win'} dir --config electron-builder.yml --config.directories.output=../../artifacts/.gui-staging`, join(root, 'apps', 'desktop'));

mkdirSync(gui, { recursive: true });
// Monolith ouvert depuis ce dossier : rien n'est supprimé (sinon l'installation resterait incomplète).
const exe = join(gui, linux ? 'monolith' : 'Monolith.exe');
if (existsSync(exe)) {
  try {
    closeSync(openSync(exe, 'r+'));
  } catch (e) {
    console.error(`artifacts/GUI est utilisé (${e.code ?? e.message}) : fermez Monolith puis relancez la commande. Rien n’a été modifié.`);
    process.exit(1);
  }
}
try {
  for (const name of readdirSync(gui)) if (!KEEP.has(name)) rmSync(join(gui, name), { recursive: true, force: true });
} catch (e) {
  console.error(`Impossible de remplacer artifacts/GUI (${e.code ?? e.message}) : fermez Monolith puis relancez la commande.`);
  process.exit(1);
}
const built = join(staging, linux ? 'linux-unpacked' : 'win-unpacked');
for (const name of readdirSync(built)) cpSync(join(built, name), join(gui, name), { recursive: true });
rmSync(staging, { recursive: true, force: true });
console.log(`Build GUI : artifacts/GUI/${linux ? 'monolith' : 'Monolith.exe'}${existsSync(join(gui, 'data')) ? ' (données conservées)' : ''}`);
