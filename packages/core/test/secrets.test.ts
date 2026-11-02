import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyProtector } from '../src/index.ts';
import { tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Imite DPAPI : la clé protégée sur un poste ne se déchiffre pas sur un autre. */
class MachineProtector implements KeyProtector {
  readonly mechanism = 'dpapi' as const;
  readonly systemBacked = true;
  failUnprotect = 0;
  failProtect = false;
  constructor(private readonly machine: string) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async protect(key: Buffer): Promise<string> {
    if (this.failProtect) throw new Error('Add-Type refusé');
    return `${this.machine}:${key.toString('base64')}`;
  }
  async unprotect(stored: string): Promise<Buffer> {
    if (this.failUnprotect > 0) {
      this.failUnprotect--;
      throw new Error('powershell : délai dépassé');
    }
    const [machine, data] = stored.split(':');
    if (machine !== this.machine) throw new Error('Clé non valide pour une utilisation dans l’état spécifié');
    return Buffer.from(data!, 'base64');
  }
}

const base = { kind: 'openai-compatible', preset: 'custom', baseUrl: 'https://example.test/v1' } as const;

/** Profil créé sur le poste A avec deux connexions munies d'une clé, puis fermé. */
async function profileFromMachineA() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-secrets-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = tempHarness(dir, { keyProtector: new MachineProtector('pc-a') });
  const p1 = await a.harness.call('providers.create', { ...base, name: 'Un', apiKey: 'sk-ancienne-1111' });
  const p2 = await a.harness.call('providers.create', { ...base, name: 'Deux', apiKey: 'sk-ancienne-2222' });
  await a.cleanup();
  return { dir, p1, p2, masterBefore: readFileSync(join(dir, 'keys', 'master.json'), 'utf8') };
}

function open(dir: string, protector: KeyProtector) {
  const t = tempHarness(dir, { keyProtector: protector });
  let closed = false;
  const close = async () => {
    if (!closed) await t.cleanup();
    closed = true;
  };
  cleanups.push(close);
  return { harness: t.harness, close };
}

const backups = (dir: string) => readdirSync(join(dir, 'keys')).filter((f) => f.startsWith('master.json.unreadable-'));

describe('clé maître illisible (données copiées sur un autre poste)', () => {
  it('ressaisir une clé remplace la clé maître au lieu d’échouer', async () => {
    const { dir, p1, p2, masterBefore } = await profileFromMachineA();
    const b = open(dir, new MachineProtector('pc-b'));
    await expect(b.harness.secrets.get(`provider:${p1.id}`)).rejects.toMatchObject({ code: 'secret_unreadable' });
    expect((await b.harness.call('providers.list')).every((p) => p.keyUnreadable)).toBe(true);

    // Suppression puis recréation de la connexion, comme dans l'interface.
    await b.harness.call('providers.delete', { id: p1.id });
    const recreated = await b.harness.call('providers.create', { ...base, name: 'Un', apiKey: 'sk-nouvelle-3333' });
    expect(recreated).toMatchObject({ hasKey: true, keyHint: '3333', keyUnreadable: false });
    expect(await b.harness.secrets.get(`provider:${recreated.id}`)).toBe('sk-nouvelle-3333');
    // L'autre clé, indéchiffrable sur ce poste, est présentée comme absente : à ressaisir.
    expect(await b.harness.call('providers.list')).toEqual(expect.arrayContaining([expect.objectContaining({ id: p2.id, hasKey: false, keyHint: null, keyUnreadable: false })]));
    const saved = await b.harness.call('providers.setKey', { id: p2.id, apiKey: 'sk-nouvelle-4444' });
    expect(saved).toMatchObject({ hasKey: true, keyHint: '4444' });
    expect((await b.harness.call('app.info')).secretProtection).toMatchObject({ mechanism: 'dpapi', available: true });
    // L'ancienne clé maître est conservée à côté.
    expect(backups(dir).map((f) => readFileSync(join(dir, 'keys', f), 'utf8'))).toEqual([masterBefore]);
    await b.close();

    // Redémarrage sur le nouveau poste : les clés ressaisies restent lisibles.
    const again = open(dir, new MachineProtector('pc-b'));
    expect(await again.harness.secrets.get(`provider:${recreated.id}`)).toBe('sk-nouvelle-3333');
    expect(await again.harness.secrets.get(`provider:${p2.id}`)).toBe('sk-nouvelle-4444');
  });

  it('conserve la clé maître et les secrets après un échec passager', async () => {
    const { dir, p1, p2, masterBefore } = await profileFromMachineA();
    const protector = new MachineProtector('pc-a');
    protector.failUnprotect = 1;
    const a = open(dir, protector);
    await a.harness.call('providers.setKey', { id: p1.id, apiKey: 'sk-nouvelle-3333' });
    expect(await a.harness.secrets.get(`provider:${p2.id}`)).toBe('sk-ancienne-2222');
    expect(readFileSync(join(dir, 'keys', 'master.json'), 'utf8')).toBe(masterBefore);
    expect(backups(dir)).toEqual([]);
  });

  it('ne touche à rien si une nouvelle clé ne peut pas être protégée', async () => {
    const { dir, p1, p2, masterBefore } = await profileFromMachineA();
    const protector = new MachineProtector('pc-b');
    protector.failProtect = true;
    const b = open(dir, protector);
    await expect(b.harness.call('providers.setKey', { id: p1.id, apiKey: 'sk-nouvelle-3333' })).rejects.toMatchObject({ code: 'secret_unavailable' });
    expect(readFileSync(join(dir, 'keys', 'master.json'), 'utf8')).toBe(masterBefore);
    expect(backups(dir)).toEqual([]);
    expect((await b.harness.call('providers.list')).find((p) => p.id === p2.id)?.hasKey).toBe(true);
    await b.close();
    // De retour sur le poste d'origine, les anciennes clés sont intactes.
    const a = open(dir, new MachineProtector('pc-a'));
    expect(await a.harness.secrets.get(`provider:${p1.id}`)).toBe('sk-ancienne-1111');
  });

  it('les écritures concurrentes ne remplacent la clé maître qu’une fois', async () => {
    const { dir, p1, p2 } = await profileFromMachineA();
    const b = open(dir, new MachineProtector('pc-b'));
    await Promise.all([
      b.harness.call('providers.setKey', { id: p1.id, apiKey: 'sk-nouvelle-3333' }),
      b.harness.call('providers.setKey', { id: p2.id, apiKey: 'sk-nouvelle-4444' }),
    ]);
    expect(backups(dir)).toHaveLength(1);
    expect(await b.harness.secrets.get(`provider:${p1.id}`)).toBe('sk-nouvelle-3333');
    expect(await b.harness.secrets.get(`provider:${p2.id}`)).toBe('sk-nouvelle-4444');
  });
});
