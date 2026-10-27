import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { mockProvider, standardStream, tempHarness, writeFragmented } from './helpers.ts';
import { nextRun, parseCron } from '../src/services/scheduler.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(dir?: string) {
  const t = tempHarness(dir);
  cleanups.push(t.cleanup);
  return t;
}

describe('sauvegardes', () => {
  it('création, liste, restauration appliquée au démarrage suivant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-bk-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const t1 = tempHarness(dir);
    await t1.harness.call('conversations.create', { projectId: null, title: 'Avant' });
    const b = await t1.harness.call('backup.create');
    expect(b).toMatchObject({ kind: 'manual' });
    await t1.harness.call('conversations.create', { projectId: null, title: 'Après' });
    expect((await t1.harness.call('backup.list')).some((x) => x.name === b.name)).toBe(true);
    expect(await t1.harness.call('backup.restore', { name: b.name })).toEqual({ restartRequired: true });
    await expect(t1.harness.call('backup.restore', { name: '../../etc' })).rejects.toThrow();
    await t1.harness.close();
    const t2 = tempHarness(dir);
    cleanups.push(() => t2.harness.close());
    expect((await t2.harness.call('conversations.list', {})).map((c) => c.title)).toEqual(['Avant']);
    // La base remplacée est elle-même conservée.
    expect((await t2.harness.call('backup.list')).some((x) => x.name.includes('avant-restauration'))).toBe(true);
  });
});

describe('tableau de bord et diagnostics', () => {
  it('agrégats par jour, modèle et type ; export CSV ; diagnostics', async () => {
    const { harness: h } = await setup();
    const u = h.usage;
    for (const [model, kind, out] of [['a', 'chat', 10], ['a', 'chat', 30], ['b', 'naming', 5]] as const) {
      const id = u.start({ kind, conversationId: null, projectId: null, providerId: 1, providerName: 'P', model });
      u.finish(id, { firstTokenMs: 100, inputTokens: 20, outputTokens: out, cachedInputTokens: null, reasoningTokens: null, estimated: false, status: 'ok' });
    }
    const failed = u.start({ kind: 'chat', conversationId: null, projectId: null, providerId: 1, providerName: 'P', model: 'a' });
    u.finish(failed, { firstTokenMs: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, estimated: true, status: 'error' });
    const d = await h.call('dashboard.data', {});
    expect(d.byDay).toHaveLength(30);
    expect(d.totals).toMatchObject({ requests: 4, inputTokens: 60, outputTokens: 45, errors: 1, avgFirstTokenMs: 100 });
    expect(d.byModel[0]).toMatchObject({ key: 'P · a', requests: 3, outputTokens: 40 });
    expect((await h.call('dashboard.data', { kind: 'naming' })).totals.requests).toBe(1);
    const csv = await h.call('dashboard.csv', {});
    expect(csv.split('\n')).toHaveLength(5);
    expect(csv.split('\n')[0]).toContain('tokens_sortie');
    const diag = await h.call('diagnostics.info');
    expect(diag.app.schemaVersion).toBeGreaterThanOrEqual(7);
    expect(diag.engine.rssMb).toBeGreaterThan(0);
    expect(diag.storage.databaseMb).toBeGreaterThan(0);
    expect(await h.call('diagnostics.export', { extra: { gpu: 'test', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456' } })).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });
});

describe('tâches planifiées', () => {
  it('CRON : champs, macros, listes, pas, fuseau horaire', () => {
    expect(() => parseCron('* * *')).toThrow(/5 champs/);
    expect(() => parseCron('61 * * * *')).toThrow(/minute/);
    const spec = parseCron('30 9 * * mon-fri');
    expect([...spec.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('@daily').hours]).toEqual([0]);
    // Samedi 31 octobre 2026, 12:00 UTC → lundi 2 novembre 9:30 à Paris (UTC+1 après le changement d'heure).
    const next = nextRun(spec, 'Europe/Paris', Date.parse('2026-10-31T12:00:00Z'));
    expect(new Date(next!).toISOString()).toBe('2026-11-02T08:30:00.000Z');
    expect(new Date(nextRun(parseCron('0 0 1 1 *'), 'UTC', Date.parse('2026-06-01T00:00:00Z'))!).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('enregistrement, prochaines échéances, exécution immédiate, historique et notification', async () => {
    const { harness: h } = await setup();
    const mock = await mockProvider((_req, _raw, res: ServerResponse) => writeFragmented(res, standardStream('Rapport du matin.')));
    cleanups.push(mock.close);
    const p = await h.call('providers.create', { name: 'M', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false } });
    await expect(h.call('scheduler.save', { name: 'x', cron: '* *', timezone: 'UTC', prompt: 'y', projectId: null, conversationId: null, mode: 'chat', agentMode: 'plan', providerId: null, model: null, enabled: true })).rejects.toThrow(/CRON/);
    await expect(h.call('scheduler.preview', { cron: '0 8 * * *', timezone: 'Mars/Olympus' })).rejects.toThrow(/Fuseau/);
    expect((await h.call('scheduler.preview', { cron: '0 8 * * *', timezone: 'Europe/Paris', count: 3 })).next).toHaveLength(3);
    const task = await h.call('scheduler.save', { name: 'Veille', cron: '0 8 * * *', timezone: 'Europe/Paris', prompt: 'Fais le point', projectId: null, conversationId: null, mode: 'chat', agentMode: 'plan', providerId: null, model: null, enabled: true });
    expect(task.nextRunAt).not.toBeNull();
    const run = await h.call('scheduler.runNow', { id: task.id });
    expect(run).toMatchObject({ status: 'done', taskName: 'Veille' });
    const msgs = await h.call('messages.list', { conversationId: run.conversationId! });
    expect(msgs.at(-1)!.parts.at(-1)).toMatchObject({ type: 'text', text: 'Rapport du matin.' });
    expect((await h.call('conversations.get', { id: run.conversationId! })).title).toContain('Veille');
    expect((await h.call('scheduler.history', {})).map((r) => r.status)).toEqual(['done']);
    const notes = await h.call('notifications.list', {});
    expect(notes[0]).toMatchObject({ level: 'success', title: 'Tâche planifiée « Veille »', read: false });
    await h.call('notifications.markRead', {});
    expect((await h.call('notifications.list', {}))[0]!.read).toBe(true);
    await h.call('notifications.clear');
    expect(await h.call('notifications.list', {})).toEqual([]);
    await h.call('scheduler.save', { ...task, enabled: false });
    expect((await h.call('scheduler.list'))[0]!.nextRunAt).toBeNull();
  });
});

describe('maintenance et réglages', () => {
  it('archivage automatique, nettoyage des pièces jointes orphelines, validation des réglages', async () => {
    const { harness: h } = await setup();
    const old = await h.call('conversations.create', { projectId: null, title: 'Ancienne' });
    const recent = await h.call('conversations.create', { projectId: null, title: 'Récente' });
    h.db.run('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', old.id);
    const att = await h.call('attachments.upload', { name: 'note.txt', mime: 'text/plain', dataBase64: Buffer.from('orpheline').toString('base64') });
    h.db.run('UPDATE attachments SET created_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', att.id);
    await h.call('settings.update', { maintenance: { autoArchiveDays: 30 } });
    const report = await h.call('maintenance.run');
    expect(report).toMatchObject({ archived: 1, attachments: 1 });
    expect((await h.call('conversations.get', { id: old.id })).archived).toBe(true);
    expect((await h.call('conversations.get', { id: recent.id })).archived).toBe(false);
    // Logo : image data: uniquement ; proxy : origine sans identifiants.
    await h.call('settings.update', { appearance: { logoLight: 'javascript:alert(1)', appName: '  Mon atelier  ', backgroundAnimation: 'disco' as 'none' } });
    const s = await h.call('settings.get');
    expect(s.appearance).toMatchObject({ logoLight: null, appName: 'Mon atelier', backgroundAnimation: 'none' });
    await expect(h.call('settings.update', { web: { httpProxyUrl: 'http://u:p@proxy:1' } })).rejects.toThrow(/identifiants/);
  });
});
