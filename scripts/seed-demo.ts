// Prépare un profil de démonstration isolé (jamais le profil réel) pointant vers le faux fournisseur.
// Usage : node scripts/seed-demo.ts <dossier-de-données> [port]
import { Harness, FileProtector, silentLogger } from '@monolith/core';

const dir = process.argv[2];
const port = process.argv[3] ?? '11500';
if (!dir) {
  console.error('Usage : node scripts/seed-demo.ts <dossier-de-données> [port]');
  process.exit(1);
}

const h = new Harness({
  host: 'cli',
  data: { explicit: dir, exeDir: null },
  logger: silentLogger,
  keyProtector: new FileProtector(),
  allowFileKeyFallback: true,
});
const p = await h.call('providers.create', { name: 'Démo locale', kind: 'openai-compatible', preset: 'custom', baseUrl: `http://127.0.0.1:${port}/v1` });
await h.call('providers.setModels', {
  id: p.id,
  models: ['mock-fast', 'mock-reasoner'].map((id) => ({ id, label: id, enabled: true, contextWindow: 32768, maxOutputTokens: null, source: 'catalog' as const, capabilities: { reasoningLevels: [], vision: null, tools: null } })),
});
await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'mock-reasoner', showThroughput: true, showContextUsage: true } });
const project = await h.call('projects.create', { name: 'Site vitrine', icon: 'globe', color: '#1D6FC8', instructions: 'Réponds avec des exemples concrets.' });
// Dossier de démonstration pour les outils (jamais un dossier de l'utilisateur).
const { mkdirSync, writeFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const files = resolve(`${dir}-fichiers`);
mkdirSync(`${files}/src`, { recursive: true });
writeFileSync(`${files}/README.md`, '# Site vitrine\n\nPage d’accueil de démonstration.\n');
writeFileSync(`${files}/src/index.html`, '<h1>Bienvenue</h1>\n');
await h.call('projects.addFolder', { id: project.id, path: files });
await h.call('projects.create', { name: 'Outils internes', icon: 'code', color: '#0f8a7a' });
await h.call('conversations.create', { projectId: project.id, title: 'Refonte de la page d’accueil' });
await h.call('conversations.create', { projectId: null, title: 'Idées de vacances' });
await h.close();
console.log(`Profil de démonstration prêt : ${dir}`);
