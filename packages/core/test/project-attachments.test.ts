import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ATTACHMENT_LIMITS } from '@monolith/contracts';
import { mockProvider, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[] };
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const text = (content: unknown) => (typeof content === 'string' ? content : (content as { type: string; text?: string }[]).map((p) => p.text ?? `[${p.type}]`).join(''));

describe('pièces jointes du projet', () => {
  it('rattachées à la création, transmises au début de chaque conversation du projet, retirables', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    const bodies: Body[] = [];
    const mock = await mockProvider((_req, raw, res: ServerResponse) => {
      bodies.push(JSON.parse(raw || '{}') as Body);
      void writeFragmented(res, standardStream('ok'), 13);
    });
    cleanups.push(mock.close);
    const h = t.harness;
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false } });

    const doc = await h.call('attachments.upload', { name: 'charte.md', mime: 'text/markdown', dataBase64: b64('# Charte\nToujours tutoyer le client.') });
    const project = await h.call('projects.create', { name: 'Support', instructions: 'Réponds en français.', attachmentIds: [doc.id] });
    expect(project.attachments).toEqual([expect.objectContaining({ id: doc.id, name: 'charte.md', kind: 'text' })]);

    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Bonjour' } });
    await h.generation.idle();
    const first = bodies[0]!.messages;
    expect(text(first[0]!.content)).toContain('Réponds en français.');
    const user = first.filter((m) => m.role === 'user');
    expect(user).toHaveLength(1);
    expect(text(user[0]!.content)).toContain('Toujours tutoyer le client.');
    expect(text(user[0]!.content)).toContain('Bonjour');

    // Conversation hors projet : rien n'est transmis.
    const perso = await h.call('conversations.create', { projectId: null });
    await h.call('chat.send', { conversationId: perso.id, input: { text: 'Salut' } });
    await h.generation.idle();
    expect(JSON.stringify(bodies.at(-1))).not.toContain('tutoyer');

    const removed = await h.call('projects.removeAttachment', { id: project.id, attachmentId: doc.id });
    expect(removed.attachments).toEqual([]);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Encore' } });
    await h.generation.idle();
    expect(JSON.stringify(bodies.at(-1))).not.toContain('tutoyer');
  });

  it('limite par projet et pièce jointe inconnue refusées', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    const h = t.harness;
    const project = await h.call('projects.create', { name: 'P' });
    await expect(h.call('projects.addAttachments', { id: project.id, attachmentIds: [9999] })).rejects.toThrow(/introuvable/);
    const ids: number[] = [];
    for (let i = 0; i <= ATTACHMENT_LIMITS.perProject; i++) ids.push((await h.call('attachments.upload', { name: `n${i}.txt`, mime: 'text/plain', dataBase64: b64(`note ${i}`) })).id);
    await expect(h.call('projects.addAttachments', { id: project.id, attachmentIds: ids })).rejects.toThrow(/maximum/);
    expect((await h.call('projects.addAttachments', { id: project.id, attachmentIds: ids.slice(0, 3) })).attachments).toHaveLength(3);
  });
});
