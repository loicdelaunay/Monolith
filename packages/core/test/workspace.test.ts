import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@monolith/contracts';
import { Harness, MemoryProtector, silentLogger, type HostBridge } from '../src/index.ts';
import { isPrivateAddress, assertPublicUrl } from '../src/net/guard.ts';
import { tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function withFolder() {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const folder = mkdtempSync(join(tmpdir(), 'mh-ws-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'README.md'), '# Titre\nune ligne avec AIGUILLE\n');
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'src', 'main.ts'), 'export const x = 1;\n');
  writeFileSync(join(folder, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  writeFileSync(join(folder, 'data.bin'), Buffer.from([1, 0, 2, 0, 3]));
  const h = t.harness;
  const project = await h.call('projects.create', { name: 'P' });
  await h.call('projects.addFolder', { id: project.id, path: folder });
  const c = await h.call('conversations.create', { projectId: project.id });
  return { h, folder, conversationId: c.id };
}

describe('fichiers du panneau', () => {
  it('liste les racines, les dossiers et lit selon le type', async () => {
    const { h, folder, conversationId } = await withFolder();
    const roots = await h.call('files.list', { conversationId });
    expect(roots.entries.some((e) => e.type === 'directory' && e.path.toLowerCase().includes('mh-ws-'))).toBe(true);
    const listing = await h.call('files.list', { conversationId, path: folder });
    expect(listing.entries.map((e) => e.name)).toEqual(['src', 'data.bin', 'logo.png', 'README.md']);
    expect((await h.call('files.read', { conversationId, path: join(folder, 'README.md') })).kind).toBe('text');
    expect((await h.call('files.read', { conversationId, path: join(folder, 'README.md') })).mime).toBe('text/markdown');
    expect((await h.call('files.read', { conversationId, path: join(folder, 'logo.png') })).kind).toBe('image');
    expect((await h.call('files.read', { conversationId, path: join(folder, 'data.bin') })).kind).toBe('binary');
  });

  it('refuse les chemins hors des ressources', async () => {
    const { h, folder, conversationId } = await withFolder();
    await expect(h.call('files.read', { conversationId, path: join(folder, '..', 'ailleurs.txt') })).rejects.toThrow();
    await expect(h.call('files.list', { conversationId, path: tmpdir() })).rejects.toThrow();
  });

  it('vérifie les références citées et lit le numéro de ligne', async () => {
    const { h, conversationId } = await withFolder();
    const refs = await h.call('files.stat', { conversationId, references: ['src/main.ts:12', 'README.md#L2', 'inexistant.ts', '../secret.txt'] });
    expect(refs[0]).toMatchObject({ exists: true, type: 'file', line: 12 });
    expect(refs[1]).toMatchObject({ exists: true, line: 2 });
    expect(refs[2]!.exists).toBe(false);
    expect(refs[3]!.exists).toBe(false);
  });

  it('cherche par nom et dans le contenu', async () => {
    const { h, conversationId } = await withFolder();
    expect((await h.call('files.search', { conversationId, query: 'main' })).map((r) => r.display)).toEqual([expect.stringContaining('main.ts')]);
    const hits = await h.call('files.search', { conversationId, query: 'aiguille', content: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2 });
  });
});

describe.skipIf(!hasGit())('Git', () => {
  it('statut, index, commit, historique et versions', async () => {
    const { h, folder, conversationId } = await withFolder();
    expect((await h.call('git.status', { conversationId })).available).toBe(false);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    let status = await h.call('git.status', { conversationId });
    expect(status.available).toBe(true);
    expect(status.files.find((f) => f.path === 'README.md')).toMatchObject({ index: '?', worktree: '?' });
    await h.call('git.run', { conversationId, action: 'stage', paths: ['README.md', 'src/main.ts'] });
    status = await h.call('git.status', { conversationId });
    expect(status.files.find((f) => f.path === 'README.md')!.index).toBe('A');
    await expect(h.call('git.run', { conversationId, action: 'commit', message: '  ' })).rejects.toThrow();
    await h.call('git.run', { conversationId, action: 'commit', message: 'premier commit' });
    const log = await h.call('git.log', { conversationId });
    expect(log[0]!.subject).toBe('premier commit');
    writeFileSync(join(folder, 'README.md'), '# Titre modifié\n');
    const v = await h.call('git.fileVersions', { conversationId, path: 'README.md', staged: false });
    expect(v.before).toContain('AIGUILLE');
    expect(v.after).toBe('# Titre modifié\n');
    await expect(h.call('git.fileVersions', { conversationId, path: '../../etc/passwd', staged: false })).rejects.toThrow();
    await expect(h.call('git.run', { conversationId, action: 'switch', branch: '--orphan' })).rejects.toThrow();
    expect((await h.call('git.branches', { conversationId })).current).toBe('main');
  });
});

describe('outils de l’hôte', () => {
  it('n’expose les outils du navigateur que si l’hôte les fournit', async () => {
    const make = (hostBridge: HostBridge | null) => {
      const root = mkdtempSync(join(tmpdir(), 'mh-host-'));
      const h = new Harness({ host: 'desktop', data: { dir: root, source: 'argument', portable: false, locationFile: null }, logger: silentLogger, keyProtector: new MemoryProtector(), changelog: '', hostBridge });
      cleanups.push(async () => {
        await h.close();
        rmSync(root, { recursive: true, force: true });
      });
      return h;
    };
    const settings = { ...DEFAULT_SETTINGS, skills: { ...DEFAULT_SETTINGS.skills, enabled: { ...DEFAULT_SETTINGS.skills.enabled, screenshots: true } } };
    const without = make(null).tools.available(settings, 'agent', 'execute', 'desktop').map((t) => t.name);
    expect(without).not.toContain('browser_open');
    expect(without).toContain('git_status');
    const calls: string[] = [];
    const h = make({ request: async (method) => (calls.push(method), { tabId: 't1', url: 'https://example.com/', title: 'Exemple' }) as never });
    const names = h.tools.available(settings, 'agent', 'execute', 'desktop').map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['browser_open', 'browser_read', 'browser_screenshot', 'screenshot_window']));
    // Mode Plan : lecture seulement (pas de clic ni d'ouverture réseau).
    const plan = h.tools.available(settings, 'agent', 'plan', 'desktop').map((t) => t.name);
    expect(plan).not.toContain('browser_click');
    expect(plan).not.toContain('browser_open');
    // L'agent ne peut pas viser le réseau local par le navigateur.
    const open = h.tools.get('browser_open')!;
    await expect(open.execute({ url: 'http://127.0.0.1:8080/' }, { conversationId: 1 } as never)).rejects.toThrow(/privée|locale/);
    expect(calls).toEqual([]);
  });
});

describe('garde réseau', () => {
  it('reconnaît les adresses privées', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('refuse schémas, identifiants et noms locaux', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertPublicUrl('https://user:pw@example.com/')).rejects.toThrow();
    await expect(assertPublicUrl('http://localhost:3000/')).rejects.toThrow();
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow();
    expect((await assertPublicUrl('https://93.184.215.14/')).hostname).toBe('93.184.215.14');
  });
});
