// Faux Python pour les tests de l'IA locale : pip (crée le dossier cible), vérification des
// dépendances, et ponts LANCET / embeddings au même protocole JSON que les vrais.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('pip')) {
  mkdirSync(args[args.indexOf('--target') + 1], { recursive: true });
  process.exit(0);
}
const script = args.find((a) => a.endsWith('.py')) ?? '';
if (script.endsWith('check_dependencies.py')) {
  console.log('ok');
  process.exit(0);
}
const folder = args[args.indexOf(script) + 1];
const reply = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (script.endsWith('lancet_bridge.py')) {
  if (!existsSync(join(folder, 'classify.py'))) process.exit(3);
  reply({ ready: true });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const row = JSON.parse(line);
    const c = row.command.includes('rm -rf') ? ['risky', 0.97, 'suppression récursive'] : row.command.includes('curl') ? ['review', 0.55, 'réseau'] : ['not_flagged', 0.02, null];
    reply({ classification: c[0], score: c[1], reason: c[2], request_id: row.request_id });
  });
} else if (script.endsWith('minilm_bridge.py')) {
  if (!existsSync(join(folder, 'tokenizer.json'))) process.exit(3);
  reply({ ready: true });
  // Espace sémantique minuscule : synonymes français/anglais sur la même dimension.
  const AXES = [['facture', 'invoice', 'billing'], ['chat', 'cat', 'félin'], ['voiture', 'car'], ['météo', 'weather']];
  const vec = (t) => {
    const s = t.toLowerCase();
    const v = AXES.map((words) => words.filter((w) => s.includes(w)).length + 0.01);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    const row = JSON.parse(line);
    reply({ vectors: row.texts.map(vec), request_id: row.request_id });
  });
} else {
  process.exit(2);
}
