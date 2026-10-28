import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ATTACHMENT_LIMITS } from '@monolith/contracts';
import { tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const src = mkdtempSync(join(tmpdir(), 'mh-src-'));
  cleanups.push(() => rmSync(src, { recursive: true, force: true }));
  return { h: t.harness, src };
}

describe('pièces jointes : dossiers et gros fichiers', () => {
  it('dossier : copie sans dépendances ni .git, arborescence et fichiers courts transmis, copie lisible en lecture seule', async () => {
    const { h, src } = setup();
    const dir = join(src, 'site');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'lib'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# Site\nPage d’accueil.');
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const accueil = 42;');
    writeFileSync(join(dir, 'src', 'journal.log'), 'x'.repeat(70 * 1024));
    writeFileSync(join(dir, 'node_modules', 'lib', 'index.js'), 'module.exports = 1;');
    writeFileSync(join(dir, '.git', 'config'), '[core]');

    const ref = await h.call('attachments.fromPath', { path: dir });
    expect(ref).toMatchObject({ kind: 'folder', name: 'site', mime: 'inode/directory' });
    const copy = h.attachments.agentPath(ref.id);
    expect(basename(copy)).toBe('site');
    expect(existsSync(join(copy, 'src', 'app.ts'))).toBe(true);
    expect(existsSync(join(copy, 'node_modules'))).toBe(false);
    expect(existsSync(join(copy, '.git'))).toBe(false);

    const text = h.attachments.promptText(ref.id);
    expect(text).toContain('3 fichier(s)');
    expect(text).toContain('- src/app.ts');
    expect(text).toContain('export const accueil = 42;');
    expect(text).not.toContain('x'.repeat(1000)); // fichier long : listé, pas inséré
    expect(text).toContain(copy);

    // Projet avec ce dossier : ses conversations le lisent, sans pouvoir le modifier.
    const project = await h.call('projects.create', { name: 'Site', attachmentIds: [ref.id] });
    const c = await h.call('conversations.create', { projectId: project.id });
    const { scope } = h.resources.scope(c.id);
    expect(scope.resolve(join(copy, 'src', 'app.ts'))).toContain('app.ts');
    expect(() => scope.resolve(join(copy, 'src', 'app.ts'), { write: true })).toThrow(/lecture seule/);
  });

  it('gros fichier texte : début transmis, fichier complet sous son nom pour les outils ; limite de 100 Mo', async () => {
    const { h, src } = setup();
    const big = join(src, 'export.csv');
    writeFileSync(big, `${'ligne;valeur\n'.repeat(120_000)}FIN`);
    const ref = await h.call('attachments.fromPath', { path: big });
    expect(ref.kind).toBe('text');
    const text = h.attachments.promptText(ref.id);
    expect(text).toContain('[… début seulement');
    expect(text.length).toBeLessThan(300 * 1024);
    const copy = h.attachments.agentPath(ref.id);
    expect(basename(copy)).toBe('export.csv');
    expect(readFileSync(copy, 'utf8').endsWith('FIN')).toBe(true);

    const huge = join(src, 'trop.bin');
    writeFileSync(huge, '');
    truncateSync(huge, ATTACHMENT_LIMITS.fileBytes + 1);
    await expect(h.call('attachments.fromPath', { path: huge })).rejects.toThrow(/maximum/);
    await expect(h.call('attachments.fromPath', { path: 'relatif.txt' })).rejects.toThrow(/absolu/);
  });
});
