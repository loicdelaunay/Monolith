import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { APP_VERSION } from '@monolith/contracts';
import { Harness, MemoryProtector, silentLogger } from '../src/index.ts';
import { compareVersions } from '../src/services/updates.ts';
import { UPDATER_SCRIPT } from '../src/desktop/updater-script.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REPO = 'loicdelaunay/Monolith';
const PKG = Buffer.alloc(200_000, 3);
const SHA = createHash('sha256').update(PKG).digest('hex');

async function github(opts: { digest?: string; redirectTo?: string } = {}) {
  let base = '';
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith(`/repos/${REPO}/releases`)) {
      const asset = (version: string, extra: Record<string, unknown> = {}) => ({ name: `MonolithHarness-v${version}-win-x64.zip`, browser_download_url: `${base}/${REPO}/releases/download/v${version}/MonolithHarness-v${version}-win-x64.zip`, size: PKG.length, digest: `sha256:${opts.digest ?? SHA}`, ...extra });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify([
          { tag_name: 'v9.0.0', draft: true, assets: [asset('9.0.0')] },
          { tag_name: 'v8.0.0', prerelease: false, assets: [asset('8.0.0', { browser_download_url: 'https://example.com/x.zip' })] },
          { tag_name: 'v7.0.0', prerelease: false, assets: [asset('7.0.0', { digest: '' })] },
          { tag_name: 'v4.0.0-beta.2', prerelease: true, html_url: `${base}/${REPO}/releases/tag/v4.0.0-beta.2`, body: 'Notes', assets: [{ name: 'autre.zip' }, asset('4.0.0-beta.2')] },
          { tag_name: 'v3.0.0-alpha.1', prerelease: true, assets: [asset('3.0.0-alpha.1')] },
        ]),
      );
    }
    if (url.includes('/releases/download/')) {
      if (opts.redirectTo) {
        res.writeHead(302, { location: opts.redirectTo });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': PKG.length });
      return res.end(PKG);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
  return base;
}

function harness(base: string, root = mkdtempSync(join(tmpdir(), 'mh-upd-'))) {
  const jobs: Record<string, unknown>[] = [];
  const h = new Harness({
    host: 'desktop',
    data: { dir: root, source: 'argument', portable: false, locationFile: null },
    logger: silentLogger,
    keyProtector: new MemoryProtector(),
    changelog: '',
    hostBridge: { request: async (method: string, params: Record<string, unknown>) => (jobs.push({ method, ...params }), { scheduled: true }) as never },
    updates: { apiBase: base, downloadBase: base, installable: true },
  });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => h.close());
  return { h, jobs, root };
}

describe('mises à jour', () => {
  it('ordre des versions SemVer, préversions comprises', () => {
    expect(compareVersions('3.0.0-alpha.10', '3.0.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '3.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('v3.0.0-beta.1', '3.0.0-alpha.12')).toBeGreaterThan(0);
    expect(compareVersions('3.1.0', '3.0.9')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0-alpha.11', '3.0.0-alpha.11')).toBe(0);
  });

  it('choisit la version publiée valide, télécharge, vérifie, sauvegarde puis confie l’installation à l’hôte', async () => {
    const base = await github();
    const { h, jobs, root } = harness(base);
    const s = await h.call('updates.check');
    // Brouillon, paquet hors du dépôt officiel et paquet sans empreinte ignorés.
    expect(s).toMatchObject({ status: 'available', current: APP_VERSION, release: { version: '4.0.0-beta.2', prerelease: true, sha256: SHA, size: PKG.length, notes: 'Notes' } });
    expect((await h.call('notifications.list', {})).map((n) => n.title)).toContain('Mise à jour disponible : 4.0.0-beta.2');

    await h.call('updates.download');
    await h.updates.idle();
    expect(h.updates.state()).toMatchObject({ status: 'ready', progress: 1 });
    const zip = join(root, 'updates', 'MonolithHarness-v4.0.0-beta.2-win-x64.zip');
    expect(readFileSync(zip).equals(PKG)).toBe(true);

    expect(await h.call('backup.list')).toHaveLength(0);
    const after = await h.call('updates.install');
    expect(after.status).toBe('installing');
    expect(await h.call('backup.list')).toHaveLength(1);
    expect(jobs).toEqual([{ method: 'app.installUpdate', script: join(root, 'updates', 'apply-update.ps1'), zip, sha256: SHA, version: '4.0.0-beta.2', when: 'now' }]);
    expect(readFileSync(join(root, 'updates', 'apply-update.ps1'), 'utf8').startsWith('﻿')).toBe(true);
  });

  it('empreinte incorrecte ou redirection non officielle : paquet rejeté', async () => {
    const bad = harness(await github({ digest: 'a'.repeat(64) }));
    await bad.h.call('updates.check');
    await bad.h.call('updates.download');
    await bad.h.updates.idle();
    expect(bad.h.updates.state()).toMatchObject({ status: 'error', error: expect.stringContaining('SHA-256') });
    expect(existsSync(join(bad.root, 'updates', 'MonolithHarness-v4.0.0-beta.2-win-x64.zip'))).toBe(false);
    await expect(bad.h.call('updates.install')).rejects.toThrow(/Téléchargez/);

    const redirected = harness(await github({ redirectTo: 'http://localhost:1/x.zip' }));
    await redirected.h.call('updates.check');
    await redirected.h.call('updates.download');
    await redirected.h.updates.idle();
    expect(redirected.h.updates.state().error).toMatch(/non officielle/);
  });

  it('résultat de l’installation précédente signalé au démarrage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-upd-'));
    mkdirSync(join(root, 'updates'), { recursive: true });
    writeFileSync(join(root, 'updates', 'update-result.json'), JSON.stringify({ ok: false, message: 'Échec : version précédente restaurée.', at: '2026-10-27T00:00:00Z' }));
    const { h } = harness('http://127.0.0.1:1', root);
    expect(h.updates.state().lastResult).toEqual({ ok: false, message: 'Échec : version précédente restaurée.', at: '2026-10-27T00:00:00Z' });
    await new Promise((r) => setTimeout(r, 10));
    expect((await h.call('notifications.list', {})).map((n) => n.title)).toContain('Échec de la mise à jour');
    expect(existsSync(join(root, 'updates', 'update-result.json'))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('installateur Windows (PowerShell)', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'mh-inst-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, 'app');
    mkdirSync(join(target, 'resources'), { recursive: true });
    mkdirSync(join(target, 'data', 'updates'), { recursive: true });
    writeFileSync(join(target, 'Monolith.exe'), 'ancien');
    writeFileSync(join(target, 'resources', 'app.asar'), 'ancien');
    writeFileSync(join(target, 'old.dll'), 'ancien');
    writeFileSync(join(target, 'data', 'monolith.sqlite'), 'données');
    writeFileSync(join(target, 'monolith.location.json'), '{}');
    const pkg = join(dir, 'pkg', 'win-unpacked');
    mkdirSync(join(pkg, 'resources'), { recursive: true });
    writeFileSync(join(pkg, 'resources', 'app.asar'), 'nouveau');
    writeFileSync(join(pkg, 'new.dll'), 'nouveau');
    const script = join(target, 'data', 'updates', 'apply-update.ps1');
    writeFileSync(script, `﻿${UPDATER_SCRIPT}`, 'utf8');
    const zip = (withExe: boolean) => {
      if (withExe) writeFileSync(join(pkg, 'Monolith.exe'), 'nouveau');
      else rmSync(join(pkg, 'Monolith.exe'), { force: true });
      const out = join(target, 'data', 'updates', 'MonolithHarness-v9.9.9-win-x64.zip');
      rmSync(out, { force: true });
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${join(dir, 'pkg', 'win-unpacked')}' -DestinationPath '${out}'`]);
      return { out, sha: createHash('sha256').update(readFileSync(out)).digest('hex') };
    };
    const run = (z: { out: string; sha: string }, sha = z.sha) => {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Zip', z.out, '-Sha256', sha, '-Target', target, '-Version', '9.9.9']);
      return JSON.parse(readFileSync(join(target, 'data', 'updates', 'update-result.json'), 'utf8')) as { ok: boolean; message: string };
    };
    const read = (rel: string) => (existsSync(join(target, rel)) ? readFileSync(join(target, rel), 'utf8') : null);
    return { zip, run, read, target };
  }

  it('remplace l’application, conserve les données et garde l’ancienne version', { timeout: 60_000 }, () => {
    const s = setup();
    const r = s.run(s.zip(true));
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('9.9.9') });
    expect([s.read('Monolith.exe'), s.read('resources/app.asar'), s.read('new.dll'), s.read('old.dll')]).toEqual(['nouveau', 'nouveau', 'nouveau', null]);
    expect([s.read('data/monolith.sqlite'), s.read('monolith.location.json')]).toEqual(['données', '{}']);
    expect([s.read('data/updates/previous/Monolith.exe'), s.read('data/updates/previous/old.dll')]).toEqual(['ancien', 'ancien']);
  });

  it('empreinte incorrecte ou paquet invalide : rien n’est modifié', { timeout: 60_000 }, () => {
    const s = setup();
    expect(s.run(s.zip(true), 'b'.repeat(64))).toMatchObject({ ok: false, message: expect.stringContaining('SHA-256') });
    expect(s.run(s.zip(false))).toMatchObject({ ok: false, message: expect.stringContaining('Monolith.exe absent') });
    expect([s.read('Monolith.exe'), s.read('old.dll'), s.read('new.dll'), s.read('data/monolith.sqlite')]).toEqual(['ancien', 'ancien', null, 'données']);
  });
});
