import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function toolStream(name: string, args: Record<string, unknown>, id: string): string {
  const out = sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  return `${out}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
}

describe('vitesse de génération', () => {
  it('ne compte que le temps de génération : ni l’attente d’autorisation ni l’exécution des outils', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    let n = 0;
    const mock = await mockProvider((_req, _raw, res: ServerResponse) => {
      n++;
      void writeFragmented(res, n === 1 ? toolStream('write_file', { path: 'note.txt', content: 'bonjour' }, 'c1') : standardStream('Fichier écrit.'), 13, 5);
    });
    cleanups.push(mock.close);
    const h = t.harness;
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, defaultMode: 'execute' }, permissions: { policy: 'ask' } });
    const c = await h.call('conversations.create', { projectId: null });
    // L'utilisateur met 1,5 s à autoriser l'écriture.
    h.events.on('permission.requested', (r) => setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 1500));
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Écris une note' } });
    await h.generation.idle();
    const reply = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'assistant').at(-1)!;
    expect(reply.durationMs!).toBeGreaterThan(1500);
    expect(reply.usage!.generationMs).toBeGreaterThan(0);
    expect(reply.usage!.generationMs!).toBeLessThan(reply.durationMs! - 1300);
  });
});
