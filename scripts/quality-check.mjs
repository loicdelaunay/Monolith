#!/usr/bin/env node
// Contrôle qualité reproductible sur la fenêtre réelle (Electron construit) : audit d'accessibilité
// axe-core (WCAG 2.x A/AA) de plusieurs vues et mesures de performance (chargement, ouverture
// d'une conversation, mémoire, taille du DOM). Profil de démonstration isolé, jamais le profil réel.
// Prérequis : npm run build. Usage : node scripts/quality-check.mjs [--strict]
// --strict : code de sortie 1 si une violation « serious » ou « critical » est trouvée.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const strict = process.argv.includes('--strict');
if (!existsSync(join(root, 'apps', 'desktop', 'out', 'main', 'index.js'))) {
  console.error('Construisez d’abord l’application : npm run build');
  process.exit(1);
}
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const outDir = join(root, 'artifacts', 'quality');
mkdirSync(outDir, { recursive: true });

// Profil de démonstration neuf (conversations, projet, fournisseur fictif).
const data = mkdtempSync(join(tmpdir(), 'mh-quality-'));
execFileSync(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', join(root, 'scripts', 'seed-demo.ts'), join(data, 'profil'), '--long'], { cwd: root, stdio: 'ignore' });

const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
const audit = (view) => `(async () => {
  const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
  return { view: ${JSON.stringify(view)}, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160), ...(n.any?.[0]?.data?.contrastRatio ? { contrast: n.any[0].data } : {}) })) })) };
})()`;
const steps = [
  `(async () => ({ perf: true, timeOrigin: performance.timeOrigin, nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null; })() }))()`,
  audit('Accueil'),
  `(async () => {
    const target = [...document.querySelectorAll('.conv-main')].find((b) => b.textContent.includes('Conversation longue'));
    if (!target) return { perf: true, openConversation: null };
    const t = performance.now();
    target.click();
    for (let i = 0; i < 200 && !document.querySelector('article.msg'); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { perf: true, openConversation: Math.round(performance.now() - t), messages: document.querySelectorAll('article.msg').length };
  })()`,
  audit('Conversation'),
  `(async () => { [...document.querySelectorAll('button')].find((b) => /Réglages|Settings/.test(b.textContent))?.click(); ${wait(1200)} return 'ok'; })()`,
  audit('Réglages › Général'),
  `(async () => { [...document.querySelectorAll('.nav-item')].find((b) => /Skills/.test(b.textContent))?.click(); ${wait(1200)} return 'ok'; })()`,
  audit('Réglages › Skills'),
  `(async () => { [...document.querySelectorAll('.nav-item')].find((b) => /propos|About/.test(b.textContent))?.click(); ${wait(1200)} return 'ok'; })()`,
  audit('Réglages › À propos'),
  `(async () => ({ perf: true, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, domNodes: document.getElementsByTagName('*').length }))()`,
];

const started = Date.now();
const env = {
  ...process.env,
  MONOLITH_DATA_DIR: join(data, 'profil'),
  MONOLITH_SMOKE_SHOT: join(outDir, 'quality.png'),
  MONOLITH_SMOKE_STEPS: steps.join('|||'),
  MONOLITH_SMOKE_DELAY: '2500',
  MONOLITH_SMOKE_INJECT: axePath,
};
delete env.ELECTRON_RUN_AS_NODE;
const results = [];
const child = spawn('npx', ['electron', 'apps/desktop'], { cwd: root, env, shell: true });
let buffer = '';
child.stdout.on('data', (d) => {
  buffer += d.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    const m = /^SMOKE (\d+) (.*)$/.exec(line);
    if (m) {
      try {
        results.push(JSON.parse(m[2]));
      } catch {
        results.push(m[2]);
      }
    }
  }
});
const code = await new Promise((r) => child.on('exit', r));
rmSync(data, { recursive: true, force: true });

const perf = Object.assign({}, ...results.filter((r) => r && r.perf));
const launchToWindowMs = perf.timeOrigin ? Math.round(perf.timeOrigin - started) : null;
const audits = results.filter((r) => r && r.view);
const report = {
  date: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  performance: { launchToWindowMs, domContentLoadedMs: perf.nav?.domContentLoaded ?? null, loadMs: perf.nav?.load ?? null, openConversationMs: perf.openConversation ?? null, messages: perf.messages ?? null, heapMb: perf.heapMb ?? null, domNodes: perf.domNodes ?? null },
  accessibility: audits,
};
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));

console.log(`Performance : fenêtre ${launchToWindowMs ?? '?'} ms après le lancement ; DOM prêt ${report.performance.domContentLoadedMs ?? '?'} ms ; conversation ouverte en ${report.performance.openConversationMs ?? '?'} ms (${report.performance.messages ?? 0} messages) ; tas JS ${report.performance.heapMb ?? '?'} Mo ; ${report.performance.domNodes ?? '?'} nœuds DOM.`);
let serious = 0;
for (const a of audits) {
  const list = a.violations.map((v) => `${v.id} (${v.impact}, ${v.nodes})`).join(', ');
  serious += a.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').length;
  console.log(`Accessibilité — ${a.view} : ${a.violations.length ? list : 'aucune violation'}`);
}
console.log(`Rapport : artifacts/quality/report.json${code ? ` (Electron : code ${code})` : ''}`);
if (audits.length < 5) {
  console.error('Audit incomplet : certaines vues n’ont pas été analysées.');
  process.exit(1);
}
process.exit(strict && serious ? 1 : 0);
