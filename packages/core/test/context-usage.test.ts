import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const usage = (prompt: number, completion: number) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } })}\n\n`;
const end = (reason: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;

describe('taille du contexte lue chez le fournisseur', () => {
  it('réponse à plusieurs tours d’outils : seule la dernière requête compte (pas la somme des tours)', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    let n = 0;
    const mock = await mockProvider((req: IncomingMessage, _raw, res: ServerResponse) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm', max_context_length: 32000 }] }));
        return;
      }
      n++;
      const body =
        n === 1
          ? sseChunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }) + end('tool_calls') + usage(10_000, 40)
          : sseChunk({ content: 'Terminé.' }) + end('stop') + usage(10_300, 25);
      void writeFragmented(res, `${body}data: [DONE]\n\n`, 64);
    });
    cleanups.push(mock.close);
    const h = t.harness;
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: 8000, maxOutputTokens: null, source: 'catalog', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, defaultMode: 'execute' }, permissions: { policy: 'allow_all' } });
    const c = await h.call('conversations.create', { projectId: null });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Liste les fichiers' } });
    await h.generation.idle();

    const reply = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'assistant').at(-1)!;
    // Consommation facturée : les deux tours ; contexte réel : la dernière requête seulement.
    expect(reply.usage).toMatchObject({ inputTokens: 20_300, outputTokens: 65, contextTokens: 10_325, estimated: false });
    const ctx = await h.call('conversations.contextUsage', { id: c.id });
    expect(ctx.source).toBe('api');
    expect(ctx.tokens).toBeGreaterThanOrEqual(10_325);
    expect(ctx.tokens).toBeLessThan(11_000);

    // Fenêtre annoncée par le fournisseur (Mistral : max_context_length) : remplace l'ancienne valeur au rafraîchissement.
    const refreshed = await h.call('providers.refreshModels', { id: p.id });
    expect(refreshed.models.find((m) => m.id === 'm')?.contextWindow).toBe(32000);
  });
});
