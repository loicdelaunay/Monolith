#!/usr/bin/env node
// Vérifie un dossier d'artefacts avant release et produit SHA256SUMS.txt.
// Refuse tout fichier ressemblant à des données utilisateur (base, clés, logs, profils).
// Aucune publication : ce script ne contacte aucun service.
// Usage : node scripts/prepare-release.mjs <dossier-artefacts>
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage : node scripts/prepare-release.mjs <dossier-artefacts>');
  process.exit(1);
}

const FORBIDDEN = [/\.sqlite(-wal|-shm)?$/i, /(^|[\\/])data[\\/]/i, /(^|[\\/])keys[\\/]/i, /master\.json$/i, /monolith\.location\.json$/i, /\.log$/i, /window-state\.json$/i, /(^|[\\/])\.data[\\/]/i];

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dir).filter((f) => !f.endsWith('SHA256SUMS.txt'));
const leaks = files.filter((f) => FORBIDDEN.some((re) => re.test(relative(dir, f))));
if (leaks.length) {
  console.error('Fichiers interdits dans les artefacts (données utilisateur possibles) :');
  for (const f of leaks) console.error(`  ${relative(dir, f)}`);
  process.exit(1);
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

const top = files.filter((f) => relative(dir, f).split(/[\\/]/).length === 1);
const lines = [];
for (const f of top) lines.push(`${await sha256(f)}  ${relative(dir, f)}`);
writeFileSync(join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`SHA256SUMS.txt : ${lines.length} fichier(s).`);
