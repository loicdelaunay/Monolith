import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mockProvider, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };

describe('/orchestration : orchestration forcée par conversation', () => {
  it('délégation exposée et demandée au modèle dans cette conversation seulement, même sous-agents désactivés', async () => {
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
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, defaultMode: 'execute' }, subagents: { mode: 'off' } });
    const forced = await h.call('conversations.create', { projectId: null });
    const normal = await h.call('conversations.create', { projectId: null });
    expect((await h.call('conversations.update', { id: forced.id, patch: { orchestration: true } })).orchestration).toBe(true);

    await h.call('chat.send', { conversationId: forced.id, input: { text: 'Gros travail' } });
    await h.generation.idle();
    await h.call('chat.send', { conversationId: normal.id, input: { text: 'Petit travail' } });
    await h.generation.idle();
    const names = (b: Body) => (b.tools ?? []).map((x) => x.function.name);
    const system = (b: Body) => String(b.messages[0]?.content ?? '');
    expect(names(bodies[0]!)).toContain('delegate_tasks');
    expect(system(bodies[0]!)).toContain('Délégation');
    expect(names(bodies[1]!)).not.toContain('delegate_tasks');
    expect(system(bodies[1]!)).not.toContain('Délégation');
  });
});
