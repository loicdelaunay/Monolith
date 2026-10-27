#!/usr/bin/env node
// Build GUI testable : un dossier par version dans artifacts/GUI/v<version>/ (zip portable,
// installeur et dossier décompressé), pour ne jamais écraser une version en cours d'utilisation.
// Usage : node scripts/build-gui.mjs [win|linux]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = process.argv[2] === 'linux' ? '--linux' : '--win';
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
run('npm run build -w @monolith/desktop', root);
run(`npx electron-builder ${target} --config electron-builder.yml --config.directories.output=../../artifacts/GUI/v${version}`, join(root, 'apps', 'desktop'));
console.log(`Build GUI : artifacts/GUI/v${version}/`);
