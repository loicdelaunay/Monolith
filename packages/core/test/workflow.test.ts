import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HarnessEvents, Message, ModelCapabilities } from '@monolith/contracts';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';
import { planReasoning, documentedLevels, isReasoningRejection } from '../src/generation/reasoning.ts';
import { sniffImage } from '../src/services/attachments.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { model: string; messages: { role: string; content: unknown }[]; reasoning_effort?: string; reasoning?: unknown; thinking?: unknown };

function stream(text: string, extra: { reasoning?: string; usage?: { prompt_tokens: number; completion_tokens: number } } = {}): string {
  let out = extra.reasoning ? sseChunk({ reasoning_content: extra.reasoning }) : '';
  for (const piece of text.match(/.{1,5}/gs) ?? []) out += sseChunk({ content: piece });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += `data: ${JSON.stringify({ choices: [], usage: extra.usage ?? { prompt_tokens: 50, completion_tokens: 10 } })}\n\n`;
  return out + 'data: [DONE]\n\n';
}

/** Faux fournisseur qui distingue chat, nommage et compactage, avec un délai réglable. */
async function smartMock(opts: { delayMs?: number; onChat?: (body: Body, res: ServerResponse) => boolean | Promise<boolean> } = {}) {
  const mock = await mockProvider(async (req: IncomingMessage, raw, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'gpt-5-mini' }, { id: 'mock-model' }] }));
      return;
    }
    const body = JSON.parse(raw || '{}') as Body;
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.includes('titre court')) return writeFragmented(res, stream('Titre généré'), 50);
    if (system.includes('Tu résumes')) return writeFragmented(res, stream('RÉSUMÉ: faits importants'), 50);
    if (opts.onChat && (await opts.onChat(body, res))) return;
    const last = body.messages.at(-1)!;
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    return writeFragmented(res, stream(`Réponse à ${text.slice(0, 40)}`), 6, opts.delayMs ?? 0);
  });
  cleanups.push(mock.close);
  return mock;
}

async function setup(url: string, model = 'mock-model', caps: Partial<ModelCapabilities> = {}, preset = 'custom') {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset, baseUrl: url });
  await h.call('providers.setModels', {
    id: p.id,
    models: [{ id: model, label: model, enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null, ...caps } }],
  });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: model, autoNaming: false } });
  const c = await h.call('conversations.create', { projectId: null });
  return { ...t, h, provider: p, c };
}

const chatBodies = (requests: { body: unknown }[]) => (requests.map((r) => r.body) as Body[]).filter((b) => !String(b.messages[0]?.content).includes('titre court') && !String(b.messages[0]?.content).includes('Tu résumes'));

describe('file d’attente et instructions pendant la génération', () => {
  it('met en file pendant une génération puis envoie automatiquement, dans l’ordre', async () => {
    const mock = await smartMock({ delayMs: 5 });
    const { h, c } = await setup(mock.url);
    const first = await h.call('chat.send', { conversationId: c.id, input: { text: 'un' } });
    expect(first.status).toBe('started');
    const q2 = await h.call('chat.send', { conversationId: c.id, input: { text: 'deux', mode: 'queue' } });
    const q3 = await h.call('chat.send', { conversationId: c.id, input: { text: 'trois', mode: 'queue' } });
    expect([q2.status, q3.status]).toEqual(['queued', 'queued']);
    await expect(h.call('chat.send', { conversationId: c.id, input: { text: 'x' } })).rejects.toMatchObject({ code: 'busy' });
    await h.call('queue.reorder', { conversationId: c.id, ids: [q3.queuedId!, q2.queuedId!] });
    await h.call('queue.update', { id: q2.queuedId!, text: 'deux modifié' });
    await h.generation.idle();
    const users = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'user');
    expect(users.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['un', 'trois', 'deux modifié']);
    expect(users.map((m) => m.origin)).toEqual(['direct', 'queue', 'queue']);
    expect(await h.call('queue.list', { conversationId: c.id })).toEqual([]);
  });

  it('transmet une instruction à la frontière du tour, avec le même instantané', async () => {
    const mock = await smartMock({ delayMs: 10 });
    const { h, c, provider } = await setup(mock.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'tâche longue' } });
    const steer = await h.call('chat.send', { conversationId: c.id, input: { text: 'précise en français', mode: 'steer' } });
    expect(steer.status).toBe('steered');
    // Le modèle de la conversation change pendant la génération : sans effet sur le tour suivant.
    await h.call('conversations.update', { id: c.id, patch: { providerId: provider.id, model: 'autre' } });
    await h.generation.idle();
    const list = await h.call('messages.list', { conversationId: c.id });
    expect(list.map((m) => `${m.role}:${m.origin}`)).toEqual(['user:direct', 'assistant:direct', 'user:steer', 'assistant:direct']);
    expect(list[3]!.status).toBe('complete');
    expect(chatBodies(mock.requests).map((b) => b.model)).toEqual(['mock-model', 'mock-model']);
    const last = chatBodies(mock.requests)[1]!;
    expect(last.messages.at(-1)).toEqual({ role: 'user', content: 'précise en français' });
  });

  it('« Orienter » un message en file : pris en compte dans la génération en cours, sinon envoyé tout de suite', async () => {
    const mock = await smartMock({ delayMs: 10 });
    const { h, c } = await setup(mock.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'tâche longue' } });
    const q = await h.call('chat.send', { conversationId: c.id, input: { text: 'ajoute des tests', mode: 'queue' } });
    const later = await h.call('chat.send', { conversationId: c.id, input: { text: 'ensuite la doc', mode: 'queue' } });
    await h.call('queue.setKind', { id: q.queuedId!, kind: 'steer' });
    expect((await h.call('queue.list', { conversationId: c.id })).map((i) => [i.text, i.kind])).toEqual([['ajoute des tests', 'steer'], ['ensuite la doc', 'queue']]);
    await h.generation.idle();
    const list = await h.call('messages.list', { conversationId: c.id });
    // Orientation : intégrée à la génération en cours ; le message en file part après elle.
    expect(list.filter((m) => m.role === 'user').map((m) => `${(m.parts[0] as { text: string }).text}:${m.origin}`)).toEqual(['tâche longue:direct', 'ajoute des tests:steer', 'ensuite la doc:queue']);
    expect(await h.call('queue.list', { conversationId: c.id })).toEqual([]);
    void later;
  });

  it('« Orienter » quand rien ne génère : le message part en premier', async () => {
    const mock = await smartMock({
      onChat: async (_b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseChunk({ content: 'début ' }));
        await new Promise((r) => setTimeout(r, 4000));
        res.end();
        return true;
      },
    });
    const { h, c } = await setup(mock.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'a' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'b', mode: 'queue' } });
    const urgent = await h.call('chat.send', { conversationId: c.id, input: { text: 'urgent', mode: 'queue' } });
    await new Promise<void>((resolve) => {
      const off = h.events.on('message.delta', () => (off(), resolve()));
    });
    await h.call('chat.cancel', { conversationId: c.id });
    await h.generation.idle();
    // File en pause après l'annulation : « Orienter » envoie ce message tout de suite, avant « b ».
    await h.call('queue.setKind', { id: urgent.queuedId!, kind: 'steer' });
    const users = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'user');
    expect(users.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['a', 'urgent']);
    expect((await h.call('queue.list', { conversationId: c.id })).map((i) => i.text)).toEqual(['b']);
    await h.call('chat.cancel', { conversationId: c.id });
    await h.generation.idle();
  });

  it('suspend la file après une annulation et convertit les instructions non consommées', async () => {
    const mock = await smartMock({
      onChat: async (_b, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sseChunk({ content: 'début ' }));
        await new Promise((r) => setTimeout(r, 4000));
        res.end();
        return true;
      },
    });
    const { h, c } = await setup(mock.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'a' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'b', mode: 'queue' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'c', mode: 'steer' } });
    await new Promise<void>((resolve) => {
      const off = h.events.on('message.delta', () => (off(), resolve()));
    });
    await h.call('chat.cancel', { conversationId: c.id });
    await h.generation.idle();
    const queue = await h.call('queue.list', { conversationId: c.id });
    expect(queue.map((q) => `${q.kind}:${q.text}`)).toEqual(['queue:b', 'queue:c']);
    expect((await h.call('messages.list', { conversationId: c.id })).length).toBe(2);
  });
});

describe('bifurcation, reprise et export', () => {
  it('bifurque, reprend en sauvegardant l’historique et exporte en Markdown', async () => {
    const mock = await smartMock();
    const { h, c } = await setup(mock.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'premier' } });
    await h.generation.idle();
    await h.call('chat.send', { conversationId: c.id, input: { text: 'second' } });
    await h.generation.idle();
    const list = await h.call('messages.list', { conversationId: c.id });
    expect(list).toHaveLength(4);

    const fork = await h.call('conversations.fork', { id: c.id, messageId: list[1]!.id });
    expect(fork.forkedFrom).toEqual({ conversationId: c.id, messageId: list[1]!.id });
    expect((await h.call('messages.list', { conversationId: fork.id })).map((m) => m.role)).toEqual(['user', 'assistant']);

    const resets: HarnessEvents['conversation.messagesReset'][] = [];
    h.events.on('conversation.messagesReset', (e) => resets.push(e));
    const resumed = await h.call('conversations.resumeFrom', { id: c.id, messageId: list[2]!.id });
    expect(resumed.text).toBe('second');
    expect((await h.call('messages.list', { conversationId: c.id })).length).toBe(2);
    expect((await h.call('conversations.get', { id: c.id })).draft).toBe('second');
    const backup = await h.call('conversations.get', { id: resumed.backupConversationId });
    expect(backup.archived).toBe(true);
    expect((await h.call('messages.list', { conversationId: backup.id })).length).toBe(4);
    expect(resets).toEqual([{ conversationId: c.id }]);
    await expect(h.call('conversations.resumeFrom', { id: c.id, messageId: list[1]!.id })).rejects.toMatchObject({ code: 'invalid_argument' });

    const exported = await h.call('conversations.exportMarkdown', { id: backup.id });
    expect(exported.fileName).toMatch(/\.md$/);
    expect(exported.markdown).toContain('## Vous');
    expect(exported.markdown).toContain('Réponse à second');
  });
});

describe('pièces jointes', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f10000000049454e44ae426082', 'hex');

  it('valide le contenu réel : images, texte, autres fichiers gardés comme fichiers', async () => {
    const { h } = await setup('http://127.0.0.1:9/v1');
    expect(sniffImage(PNG)).toBe('image/png');
    const img = await h.call('attachments.upload', { name: 'pixel.png', mime: 'image/png', dataBase64: PNG.toString('base64') });
    expect(img).toMatchObject({ kind: 'image', mime: 'image/png', size: PNG.length });
    const txt = await h.call('attachments.upload', { name: 'notes.md', mime: '', dataBase64: Buffer.from('# Titre\nContenu é').toString('base64') });
    expect(txt.kind).toBe('text');
    await expect(h.call('attachments.upload', { name: 'faux.png', mime: 'image/png', dataBase64: Buffer.from('pas une image').toString('base64') })).rejects.toMatchObject({ code: 'invalid_argument' });
    // PDF et binaires : fichiers lisibles par les outils, jamais insérés comme texte.
    expect(await h.call('attachments.upload', { name: 'doc.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.7').toString('base64') })).toMatchObject({ kind: 'file', mime: 'application/pdf' });
    expect(await h.call('attachments.upload', { name: 'bin.dat', mime: '', dataBase64: Buffer.from([0, 1, 2, 255]).toString('base64') })).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });
    const read = await h.call('attachments.read', { id: img.id });
    expect(Buffer.from(read.dataBase64, 'base64').equals(PNG)).toBe(true);
  });

  it('envoie le texte joint et l’image au modèle, et retire l’image d’un modèle sans vision', async () => {
    const mock = await smartMock();
    const { h, c, provider } = await setup(mock.url);
    const img = await h.call('attachments.upload', { name: 'pixel.png', mime: 'image/png', dataBase64: PNG.toString('base64') });
    const txt = await h.call('attachments.upload', { name: 'notes.txt', mime: 'text/plain', dataBase64: Buffer.from('contenu du fichier').toString('base64') });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'regarde', attachmentIds: [txt.id, img.id] } });
    await h.generation.idle();
    const sent = chatBodies(mock.requests)[0]!.messages.at(-1)!.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(sent[0]).toEqual({ type: 'text', text: 'regarde' });
    expect(sent[1]!.text).toContain('<fichier nom="notes.txt" type="text/plain">\ncontenu du fichier\n</fichier>');
    expect(sent[2]!.image_url!.url).toMatch(/^data:image\/png;base64,/);

    await h.call('providers.setModels', { id: provider.id, models: [{ id: 'mock-model', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: false, tools: null } }] });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'encore' } });
    await h.generation.idle();
    const second = chatBodies(mock.requests)[1]!;
    expect(JSON.stringify(second)).not.toContain('data:image');
    expect(JSON.stringify(second)).toContain('non transmise');
    const last = (await h.call('messages.list', { conversationId: c.id })).at(-1)!;
    expect(last.parts.some((p) => p.type === 'notice' && p.code === 'images_dropped')).toBe(true);
  });
});

describe('modèles de messages', () => {
  it('crée, modifie et supprime', async () => {
    const { h } = await setup('http://127.0.0.1:9/v1');
    const t = await h.call('templates.create', { name: 'Revue', content: 'Relis ce code :' });
    await h.call('templates.update', { id: t.id, patch: { content: 'Relis attentivement :' } });
    expect((await h.call('templates.list')).map((x) => x.content)).toEqual(['Relis attentivement :']);
    await h.call('templates.delete', { id: t.id });
    expect(await h.call('templates.list')).toEqual([]);
    await expect(h.call('templates.create', { name: ' ', content: 'x' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('réflexion', () => {
  it('ne propose que les niveaux documentés et traduit selon le transport', () => {
    expect(documentedLevels('openai', 'gpt-5-mini')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(documentedLevels('openai', 'gpt-4o')).toEqual([]);
    expect(documentedLevels('zai', 'glm-4.6')).toEqual(['none', 'on']);
    const caps: ModelCapabilities = { reasoningLevels: ['none', 'low', 'high'], reasoningSource: 'documented', rejectedLevels: ['low'], vision: null, tools: null };
    expect(planReasoning('high', caps, 'reasoning_effort').body).toEqual({ reasoning_effort: 'high' });
    expect(planReasoning('none', caps, 'openrouter')).toMatchObject({ body: { reasoning: { enabled: false } }, resolution: { parameter: 'reasoning.enabled=false' } });
    expect(planReasoning('none', caps, 'thinking').body).toEqual({ thinking: { type: 'disabled' } });
    expect(planReasoning('low', caps, 'reasoning_effort')).toMatchObject({ body: {}, resolution: { sent: null } });
    expect(planReasoning('low', caps, 'reasoning_effort').resolution.fallback).toMatch(/refusé/);
    expect(() => planReasoning('none', { ...caps, reasoningLevels: ['high'] }, 'reasoning_effort')).toThrow(/désactivation/);
    expect(isReasoningRejection(400, '{"error":{"message":"Unsupported value: reasoning_effort does not support minimal"}}')).toBe(true);
    expect(isReasoningRejection(400, '{"error":{"message":"bad temperature"}}')).toBe(false);
  });

  it('envoie le paramètre, puis se replie en Auto après un refus explicite et retire le niveau', async () => {
    let calls = 0;
    const mock = await smartMock({
      onChat: (body, res) => {
        calls++;
        if (body.reasoning_effort === 'high') {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Unsupported value: reasoning_effort is not supported with this model"}}');
          return true;
        }
        return false;
      },
    });
    const { h, c, provider } = await setup(mock.url, 'gpt-5-mini', { reasoningLevels: ['low', 'high'], reasoningSource: 'documented' }, 'openai');
    await h.call('conversations.update', { id: c.id, patch: { providerId: provider.id, model: 'gpt-5-mini', reasoningLevel: 'high' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'pense' } });
    await h.generation.idle();
    expect(calls).toBe(2);
    expect(chatBodies(mock.requests)[1]!.reasoning_effort).toBeUndefined();
    const reply = (await h.call('messages.list', { conversationId: c.id })).at(-1)!;
    expect(reply.status).toBe('complete');
    expect(reply.snapshot!.reasoning).toMatchObject({ requested: 'high', sent: null, parameter: null });
    expect(reply.snapshot!.reasoning!.fallback).toMatch(/refusé/);
    const caps = (await h.call('providers.list'))[0]!.models[0]!.capabilities;
    expect(caps.rejectedLevels).toEqual(['high']);
    // Réévaluation : le refus est oublié, la table documentée s'applique.
    const refreshed = await h.call('providers.refreshModels', { id: provider.id });
    expect(refreshed.models[0]!.capabilities).toMatchObject({ rejectedLevels: [], reasoningLevels: ['minimal', 'low', 'medium', 'high'], reasoningSource: 'documented' });
  });

  it('ne remplace jamais « Sans réflexion » en silence', async () => {
    const mock = await smartMock({
      onChat: (_b, res) => {
        res.writeHead(400).end('{"error":{"message":"reasoning_effort none is not supported"}}');
        return true;
      },
    });
    const { h, c, provider } = await setup(mock.url, 'm', { reasoningLevels: ['none', 'high'], reasoningSource: 'user' });
    await h.call('conversations.update', { id: c.id, patch: { providerId: provider.id, model: 'm', reasoningLevel: 'none' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'x' } });
    await h.generation.idle();
    const reply = (await h.call('messages.list', { conversationId: c.id })).at(-1)!;
    expect(reply.status).toBe('error');
    expect(reply.error!.message).toMatch(/désactivation de la réflexion/);
    expect(mock.requests).toHaveLength(1);
    // Désormais refusé avant tout envoi.
    await expect(h.call('chat.send', { conversationId: c.id, input: { text: 'y' } })).rejects.toMatchObject({ code: 'unavailable' });
    expect(mock.requests).toHaveLength(1);
  });
});

describe('nommage et compactage', () => {
  it('nomme la conversation avec une requête dédiée, comptabilisée à part', async () => {
    const mock = await smartMock();
    const { h, c } = await setup(mock.url);
    await h.call('settings.update', { chat: { autoNaming: true } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Comment cuire des pâtes ?' } });
    await h.generation.idle();
    await new Promise<void>((resolve) => {
      const check = async () => ((await h.call('conversations.get', { id: c.id })).titleSource === 'ai' ? resolve() : setTimeout(check, 20));
      void check();
    });
    const conv = await h.call('conversations.get', { id: c.id });
    expect(conv.title).toBe('Titre généré');
    expect((await h.call('usage.list', {})).map((u) => u.kind).sort()).toEqual(['chat', 'naming']);
    await h.call('conversations.update', { id: c.id, patch: { title: 'Mon titre' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'suite' } });
    await h.generation.idle();
    expect((await h.call('conversations.get', { id: c.id })).title).toBe('Mon titre');
  });

  it('compacte manuellement en conservant l’historique et les derniers échanges', async () => {
    const mock = await smartMock();
    const { h, c } = await setup(mock.url);
    await h.call('settings.update', { chat: { compactKeepTurns: 1 } });
    for (const t of ['q1', 'q2', 'q3']) {
      await h.call('chat.send', { conversationId: c.id, input: { text: t } });
      await h.generation.idle();
    }
    const compaction = await h.call('conversations.compact', { id: c.id });
    expect(compaction).toMatchObject({ summary: 'RÉSUMÉ: faits importants', trigger: 'manual', upToSeq: 4 });
    expect((await h.call('messages.list', { conversationId: c.id })).length).toBe(6);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'q4' } });
    await h.generation.idle();
    const body = chatBodies(mock.requests).at(-1)!;
    expect(String(body.messages[0]!.content)).toContain('RÉSUMÉ: faits importants');
    expect(JSON.stringify(body.messages)).not.toContain('"q1"');
    expect(body.messages.map((m) => m.content)).toContain('q3');
    expect((await h.call('usage.list', {})).some((u) => u.kind === 'compaction')).toBe(true);
    const usage = await h.call('conversations.contextUsage', { id: c.id });
    expect(usage).toMatchObject({ source: 'api', compactions: 1 });
  });

  it('compacte automatiquement avant l’envoi quand le seuil est dépassé', async () => {
    const mock = await smartMock({});
    const { h, c, provider } = await setup(mock.url);
    await h.call('providers.setModels', { id: provider.id, models: [{ id: 'mock-model', label: 'm', enabled: true, contextWindow: 3000, maxOutputTokens: 500, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { compactKeepTurns: 1, compactThreshold: 50 } });
    const long = 'x'.repeat(8000);
    await h.call('chat.send', { conversationId: c.id, input: { text: long } });
    await h.generation.idle();
    const states: string[] = [];
    h.events.on('generation.state', (s) => states.push(s.status));
    await h.call('chat.send', { conversationId: c.id, input: { text: 'court' } });
    await h.generation.idle();
    expect(states).toContain('compacting');
    expect(await h.call('compactions.list', { conversationId: c.id })).toHaveLength(1);
    const last = chatBodies(mock.requests).at(-1)!;
    expect(JSON.stringify(last.messages)).not.toContain(long);
    const reply = (await h.call('messages.list', { conversationId: c.id })).at(-1) as Message;
    expect(reply.status).toBe('complete');
  });
});
