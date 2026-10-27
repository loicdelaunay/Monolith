import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError, type HarnessEvents, type Message } from '@monolith/contracts';
import { Database } from '../src/storage/database.ts';
import { silentLogger } from '../src/log/logger.ts';
import { MIGRATIONS } from '../src/storage/migrations.ts';
import { resolveDataDir } from '../src/platform/paths.ts';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  return t;
}

async function provider(url: string, h = setup().harness) {
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: url, apiKey: 'test-key-ABCDEFGH' });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'mock-model', label: 'Mock', enabled: true, contextWindow: 8000, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'mock-model' } });
  return p;
}

function waitFinished(h: ReturnType<typeof setup>['harness'], conversationId: number): Promise<Message> {
  return new Promise((resolve) => {
    const off = h.events.on('message.updated', ({ message }) => {
      if (message.conversationId === conversationId && message.role === 'assistant' && message.status !== 'streaming') {
        off();
        resolve(message);
      }
    });
  });
}

describe('stockage', () => {
  it('applique les migrations, enregistre les sommes et refuse une migration modifiée', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'm.sqlite');
    const db = Database.open({ path, backupDir: join(dir, 'b'), logger: silentLogger });
    expect(db.info.schemaVersion).toBe(MIGRATIONS.at(-1)!.version);
    db.close();
    const tampered = MIGRATIONS.map((m) => (m.version === 1 ? { ...m, sql: m.sql + '\n-- modifié' } : m));
    expect(() => Database.open({ path, backupDir: join(dir, 'b'), logger: silentLogger, migrations: tampered })).toThrow(/ne correspond pas/);
  });

  it('sauvegarde avant migration et ouvre en lecture seule une base plus récente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'm.sqlite');
    Database.open({ path, backupDir: join(dir, 'b'), logger: silentLogger }).close();
    const next = [...MIGRATIONS, { version: 99, name: 'test', sql: 'CREATE TABLE extra (x INTEGER);' }];
    Database.open({ path, backupDir: join(dir, 'b'), logger: silentLogger, migrations: next }).close();
    expect(readdirSync(join(dir, 'b')).some((f) => f.startsWith(`monolith-v${MIGRATIONS.at(-1)!.version}-`))).toBe(true);
    const old = Database.open({ path, backupDir: join(dir, 'b'), logger: silentLogger });
    expect(old.info.readOnly).toBe(true);
    expect(() => old.run('DELETE FROM settings')).toThrow(/lecture seule/);
    old.close();
  });

  it('résout le dossier portable puis le fichier de redirection', () => {
    const exe = mkdtempSync(join(tmpdir(), 'mh-exe-'));
    cleanups.push(() => rmSync(exe, { recursive: true, force: true }));
    expect(resolveDataDir({ exeDir: exe, env: {} })).toMatchObject({ source: 'portable', portable: true, dir: join(exe, 'data') });
    const alt = join(exe, 'ailleurs');
    mkdirSync(alt);
    writeFileSync(join(exe, 'monolith.location.json'), JSON.stringify({ dataDir: alt }));
    expect(resolveDataDir({ exeDir: exe, env: {} })).toMatchObject({ source: 'location-file', dir: alt });
    expect(resolveDataDir({ exeDir: exe, env: { MONOLITH_DATA_DIR: '/x' } }).source).toBe('environment');
    expect(resolveDataDir({ exeDir: exe, explicit: '/y', env: {} }).source).toBe('argument');
  });
});

describe('réglages', () => {
  it('fusionne, borne, ignore les clés inconnues et persiste', async () => {
    const { harness, dir } = setup();
    const s = await harness.call('settings.update', { appearance: { zoom: 9, theme: 'fluent-dark-v2', bogus: 1 } as never, chat: { reasoningDisplay: 'expanded' } });
    expect(s.appearance.zoom).toBe(1.6);
    expect(s.appearance.theme).toBe('fluent-dark-v2');
    expect((s.appearance as Record<string, unknown>).bogus).toBeUndefined();
    await harness.close();
    const again = tempHarness(dir);
    cleanups.push(again.cleanup);
    expect((await again.harness.call('settings.get')).chat.reasoningDisplay).toBe('expanded');
    expect((await again.harness.call('settings.reset', { section: 'appearance' })).appearance.zoom).toBe(1);
  });
});

describe('projets et conversations', () => {
  it('gère le cycle de vie, l’ordre, les dossiers et la recherche', async () => {
    const { harness } = setup();
    const a = await harness.call('projects.create', { name: 'Alpha', color: '#1D6FC8', icon: 'code' });
    const b = await harness.call('projects.create', { name: 'Beta' });
    await harness.call('projects.reorder', { ids: [b.id, a.id] });
    expect((await harness.call('projects.list')).map((p) => p.name)).toEqual(['Beta', 'Alpha']);

    const folder = mkdtempSync(join(tmpdir(), 'mh-src-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const withFolder = await harness.call('projects.addFolder', { id: a.id, path: folder });
    expect(withFolder.folders[0]).toMatchObject({ path: folder, available: true });
    await expect(harness.call('projects.addFolder', { id: a.id, path: folder })).rejects.toMatchObject({ code: 'conflict' });
    await expect(harness.call('projects.addFolder', { id: a.id, path: 'relatif' })).rejects.toMatchObject({ code: 'invalid_argument' });

    const c1 = await harness.call('conversations.create', { projectId: a.id });
    const c2 = await harness.call('conversations.create', { projectId: a.id, title: 'Deuxième' });
    const personal = await harness.call('conversations.create', { projectId: null });
    expect((await harness.call('conversations.list', { projectId: a.id })).map((c) => c.id)).toEqual([c2.id, c1.id]);
    await harness.call('conversations.reorder', { projectId: a.id, ids: [c1.id, c2.id] });
    await harness.call('conversations.update', { id: c2.id, patch: { pinned: true, favorite: true } });
    expect((await harness.call('conversations.list', { projectId: a.id })).map((c) => c.id)).toEqual([c2.id, c1.id]);
    await harness.call('conversations.update', { id: c1.id, patch: { archived: true } });
    expect((await harness.call('conversations.list', { projectId: a.id })).map((c) => c.id)).toEqual([c2.id]);
    expect((await harness.call('conversations.list', { projectId: a.id, includeArchived: true })).length).toBe(2);
    expect((await harness.call('conversations.list', { projectId: null })).map((c) => c.id)).toEqual([personal.id]);

    await harness.call('conversations.saveDraft', { id: c2.id, draft: 'brouillon en cours' });
    expect((await harness.call('conversations.get', { id: c2.id })).draft).toBe('brouillon en cours');
    expect((await harness.call('conversations.search', { query: 'Deux' })).map((h) => h.conversationId)).toContain(c2.id);

    await harness.call('projects.delete', { id: a.id, deleteConversations: false });
    expect((await harness.call('conversations.get', { id: c2.id })).projectId).toBeNull();
    await harness.call('conversations.delete', { id: c2.id });
    await expect(harness.call('conversations.get', { id: c2.id })).rejects.toBeInstanceOf(HarnessError);
  });
});

describe('fournisseurs et secrets', () => {
  it('chiffre la clé, n’expose que l’indice et accepte des formats variés', async () => {
    const { harness, dir } = setup();
    const p = await harness.call('providers.create', { name: 'X', kind: 'openai-compatible', preset: 'custom', baseUrl: 'https://example.test/v1/', apiKey: 'gsk_live.Weird-Format:123/abc=' });
    expect(p).toMatchObject({ hasKey: true, keyHint: 'abc=', baseUrl: 'https://example.test/v1' });
    expect(JSON.stringify(p)).not.toContain('Weird-Format');
    const raw = new DatabaseSync(join(dir, 'monolith.sqlite'), { readOnly: true });
    const dump = JSON.stringify(raw.prepare('SELECT * FROM secrets').all(), (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    raw.close();
    expect(dump).not.toContain('Weird-Format');
    await expect(harness.call('providers.setKey', { id: p.id, apiKey: 'avec espace' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(harness.call('providers.update', { id: p.id, patch: { options: { headers: { Authorization: 'Bearer x' } } } })).rejects.toMatchObject({ code: 'invalid_argument' });
    const copy = await harness.call('providers.duplicate', { id: p.id });
    expect(copy).toMatchObject({ hasKey: true, keyHint: 'abc=' });
    await harness.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm' } });
    await harness.call('providers.delete', { id: p.id });
    expect((await harness.call('settings.get')).chat.defaultProviderId).toBeNull();
    expect((await harness.call('providers.list')).map((x) => x.id)).toEqual([copy.id]);
    const cleared = await harness.call('providers.clearKey', { id: copy.id });
    expect(cleared.hasKey).toBe(false);
  });

  it('refuse un type de connexion non encore implémenté avec une explication', async () => {
    const { harness } = setup();
    await expect(harness.call('providers.create', { name: 'L', kind: 'local', preset: 'local', baseUrl: '' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('teste la connexion et importe le catalogue', async () => {
    const mock = await mockProvider((req, _b, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'b-model', context_length: 32000 }, { id: 'models/a-model', architecture: { input_modalities: ['text', 'image'] } }] }));
      } else res.writeHead(404).end();
    });
    cleanups.push(mock.close);
    const { harness } = setup();
    const ok = await harness.call('providers.test', { kind: 'openai-compatible', baseUrl: mock.url, apiKey: 'k-12345678' });
    expect(ok).toMatchObject({ ok: true, modelCount: 2, usedCompletion: false });
    expect(mock.requests[0]!.headers.authorization).toBe('Bearer k-12345678');
    const p = await harness.call('providers.create', { name: 'M', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    const catalog = await harness.call('providers.fetchCatalog', { id: p.id });
    expect(catalog.map((m) => m.id)).toEqual(['a-model', 'b-model']);
    expect(catalog[0]!.capabilities.vision).toBe(true);
    expect(catalog[1]!.contextWindow).toBe(32000);
    const bad = await harness.call('providers.test', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('provider_unreachable');
  });
});

describe('génération', () => {
  it('diffuse une réponse fragmentée, conserve la chronologie et les compteurs', async () => {
    const mock = await mockProvider((_req, _b, res) => writeFragmented(res, standardStream('Bonjour à tous', 'Je réfléchis'), 5));
    cleanups.push(mock.close);
    const { harness } = setup();
    await provider(mock.url, harness);
    const c = await harness.call('conversations.create', { projectId: null });
    await harness.call('conversations.saveDraft', { id: c.id, draft: 'Salut' });
    const deltas: HarnessEvents['message.delta'][] = [];
    harness.events.on('message.delta', (d) => deltas.push(d));
    const done = waitFinished(harness, c.id);
    await harness.call('chat.send', { conversationId: c.id, input: { text: 'Salut' } });
    const final = await done;
    expect(final.status).toBe('complete');
    expect(final.parts).toEqual([
      { type: 'reasoning', text: 'Je réfléchis' },
      { type: 'text', text: 'Bonjour à tous' },
    ]);
    expect(final.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, estimated: false });
    expect(final.snapshot).toMatchObject({ model: 'mock-model', providerName: 'Mock' });
    expect(deltas.length).toBeGreaterThan(0);
    const conv = await harness.call('conversations.get', { id: c.id });
    expect(conv.draft).toBe('');
    expect(conv.title).toBe('Salut');
    const body = mock.requests[0]!.body as { messages: { role: string; content: string }[]; stream: boolean };
    expect(body.stream).toBe(true);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Salut' });
  });

  it('retente un 503 puis réussit, sans retenter un 400 ordinaire', async () => {
    let calls = 0;
    const mock = await mockProvider((_req, _b, res) => {
      calls++;
      if (calls === 1) res.writeHead(503, { 'retry-after': '0' }).end('{"error":{"message":"overloaded"}}');
      else writeFragmented(res, standardStream('ok'));
    });
    cleanups.push(mock.close);
    const { harness } = setup();
    await provider(mock.url, harness);
    await harness.call('settings.update', { network: { retryBaseDelayMs: 100 } });
    const c = await harness.call('conversations.create', { projectId: null });
    const states: string[] = [];
    harness.events.on('generation.state', (s) => states.push(s.status));
    const done = waitFinished(harness, c.id);
    await harness.call('chat.send', { conversationId: c.id, input: { text: 'x' } });
    expect((await done).status).toBe('complete');
    expect(calls).toBe(2);
    expect(states).toContain('retrying');

    let badCalls = 0;
    const bad = await mockProvider((_req, _b, res) => {
      badCalls++;
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"unknown parameter"}}');
    });
    cleanups.push(bad.close);
    const p2 = await harness.call('providers.create', { name: 'Bad', kind: 'openai-compatible', preset: 'custom', baseUrl: bad.url });
    await harness.call('conversations.update', { id: c.id, patch: { providerId: p2.id, model: 'm' } });
    const done2 = waitFinished(harness, c.id);
    await harness.call('chat.send', { conversationId: c.id, input: { text: 'y' } });
    const failed = await done2;
    expect(failed.status).toBe('error');
    expect(failed.error).toMatchObject({ code: 'provider_bad_request', status: 400 });
    expect(badCalls).toBe(1);
  });

  it('retente le 400 « JSON tronqué » ciblé', async () => {
    let calls = 0;
    const mock = await mockProvider((_req, _b, res) => {
      calls++;
      if (calls === 1) res.writeHead(400).end('{"error":{"message":"Unexpected end of JSON input"}}');
      else writeFragmented(res, standardStream('ok'));
    });
    cleanups.push(mock.close);
    const { harness } = setup();
    await provider(mock.url, harness);
    await harness.call('settings.update', { network: { retryBaseDelayMs: 100 } });
    const c = await harness.call('conversations.create', { projectId: null });
    const done = waitFinished(harness, c.id);
    await harness.call('chat.send', { conversationId: c.id, input: { text: 'x' } });
    expect((await done).status).toBe('complete');
    expect(calls).toBe(2);
  });

  it('annule une génération en conservant le contenu partiel, sans retry', async () => {
    let calls = 0;
    const mock = await mockProvider(async (_req, _b, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk({ content: 'Début ' }));
      await new Promise((r) => setTimeout(r, 5000));
      res.end();
    });
    cleanups.push(mock.close);
    const { harness } = setup();
    await provider(mock.url, harness);
    const c = await harness.call('conversations.create', { projectId: null });
    const done = waitFinished(harness, c.id);
    await harness.call('chat.send', { conversationId: c.id, input: { text: 'x' } });
    await new Promise<void>((resolve) => {
      const off = harness.events.on('message.delta', () => {
        off();
        resolve();
      });
    });
    expect((await harness.call('chat.cancel', { conversationId: c.id })).cancelled).toBe(true);
    const final = await done;
    expect(final.status).toBe('cancelled');
    expect(final.parts).toEqual([{ type: 'text', text: 'Début ' }]);
    expect(calls).toBe(1);
    expect((await harness.call('conversations.get', { id: c.id })).generating).toBe(false);
  });

  it('fige la configuration au démarrage et génère en parallèle dans deux conversations', async () => {
    const mock = await mockProvider((_req, _b, res) => writeFragmented(res, standardStream('réponse longue en plusieurs mots'), 3, 15));
    cleanups.push(mock.close);
    const { harness } = setup();
    const p = await provider(mock.url, harness);
    const c1 = await harness.call('conversations.create', { projectId: null });
    const c2 = await harness.call('conversations.create', { projectId: null });
    const d1 = waitFinished(harness, c1.id);
    const d2 = waitFinished(harness, c2.id);
    await harness.call('chat.send', { conversationId: c1.id, input: { text: 'a' } });
    await harness.call('chat.send', { conversationId: c2.id, input: { text: 'b' } });
    await expect(harness.call('chat.send', { conversationId: c1.id, input: { text: 'c' } })).rejects.toMatchObject({ code: 'busy' });
    expect((await harness.call('chat.active')).length).toBe(2);
    // Changement de modèle pendant la génération : sans effet sur la requête en cours.
    await harness.call('conversations.update', { id: c1.id, patch: { providerId: p.id, model: 'autre-modele' } });
    const [m1, m2] = await Promise.all([d1, d2]);
    expect(m1.snapshot!.model).toBe('mock-model');
    expect(m1.status).toBe('complete');
    expect(m2.status).toBe('complete');
    expect(mock.requests.every((r) => (r.body as { model: string }).model === 'mock-model')).toBe(true);
  });

  it('marque comme interrompue une génération coupée par un arrêt', async () => {
    const { harness, dir } = setup();
    const c = await harness.call('conversations.create', { projectId: null });
    harness.messages.create({ conversationId: c.id, role: 'assistant', status: 'streaming', parts: [{ type: 'text', text: 'partiel' }] });
    await harness.close();
    const again = tempHarness(dir);
    cleanups.push(again.cleanup);
    const [m] = await again.harness.call('messages.list', { conversationId: c.id });
    expect(m).toMatchObject({ status: 'interrupted', parts: [{ type: 'text', text: 'partiel' }] });
  });

  it('refuse l’envoi sans fournisseur avec un code explicite', async () => {
    const { harness } = setup();
    const c = await harness.call('conversations.create', { projectId: null });
    await expect(harness.call('chat.send', { conversationId: c.id, input: { text: 'x' } })).rejects.toMatchObject({ code: 'provider_no_model' });
    expect(await harness.call('messages.list', { conversationId: c.id })).toEqual([]);
  });

  it('expose le changelog intégré', async () => {
    const { harness } = setup();
    expect(await harness.call('app.changelog')).toContain('Changelog');
    expect(readFileSync).toBeTypeOf('function');
  });
});
