import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[] };

function stream(text: string, usage: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens: number } }): string {
  let out = '';
  for (const piece of text.match(/.{1,5}/gs) ?? []) out += sseChunk({ content: piece });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  out += `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
  return out + 'data: [DONE]\n\n';
}

/** Fournisseur fictif : `usage` donne le compteur renvoyé pour chaque réponse de chat. */
async function setup(window: number, maxOutput: number | null, usage: (n: number) => Parameters<typeof stream>[1]) {
  let n = 0;
  const mock = await mockProvider(async (_req: IncomingMessage, raw, res: ServerResponse) => {
    const body = JSON.parse(raw || '{}') as Body;
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.includes('Tu résumes')) return writeFragmented(res, stream('RÉSUMÉ', { prompt_tokens: 10, completion_tokens: 2 }), 50);
    return writeFragmented(res, stream('Réponse courte', usage(++n)), 50);
  });
  cleanups.push(mock.close);
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', {
    id: p.id,
    models: [{ id: 'm', label: 'm', enabled: true, contextWindow: window, maxOutputTokens: maxOutput, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }],
  });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, compactKeepTurns: 1, compactThreshold: 80 } });
  const c = await h.call('conversations.create', { projectId: null });
  const send = async (text: string) => {
    await h.call('chat.send', { conversationId: c.id, input: { text } });
    await h.generation.idle();
  };
  return { h, c, send };
}

describe('seuil du compactage automatique', () => {
  it('ne compacte pas une conversation courte quand le modèle annonce une sortie maximale égale à sa fenêtre', async () => {
    // OpenRouter annonce souvent max_completion_tokens = context_length.
    const { h, c, send } = await setup(128_000, 128_000, () => ({ prompt_tokens: 2_000, completion_tokens: 50 }));
    for (const t of ['un', 'deux', 'trois', 'quatre']) await send(t);
    expect(await h.call('compactions.list', { conversationId: c.id })).toHaveLength(0);
  });

  it('ne compacte pas avant le seuil affiché quand la sortie maximale est grande (128k / 64k)', async () => {
    // 60 % de la fenêtre affichée : sous le seuil de 80 %.
    const { h, c, send } = await setup(128_000, 64_000, () => ({ prompt_tokens: 76_800, completion_tokens: 50 }));
    for (const t of ['un', 'deux', 'trois']) await send(t);
    const usage = await h.call('conversations.contextUsage', { id: c.id });
    expect(usage.tokens / usage.contextWindow!).toBeLessThan(0.8);
    expect(await h.call('compactions.list', { conversationId: c.id })).toHaveLength(0);
  });

  it('ne compte pas la réflexion, jamais renvoyée au modèle, dans le contexte', async () => {
    // 60 000 en entrée + 50 000 en sortie dont 45 000 de réflexion : 65 000 restent dans le contexte.
    const { h, c, send } = await setup(128_000, null, () => ({ prompt_tokens: 60_000, completion_tokens: 50_000, completion_tokens_details: { reasoning_tokens: 45_000 } }));
    for (const t of ['un', 'deux', 'trois']) await send(t);
    const usage = await h.call('conversations.contextUsage', { id: c.id });
    expect(usage).toMatchObject({ source: 'api' });
    expect(usage.tokens).toBeGreaterThanOrEqual(65_000);
    expect(usage.tokens).toBeLessThan(70_000);
    expect(await h.call('compactions.list', { conversationId: c.id })).toHaveLength(0);
  });

  it('compacte toujours une fois le seuil dépassé', async () => {
    const { h, c, send } = await setup(128_000, 64_000, (n) => ({ prompt_tokens: n === 1 ? 2_000 : 110_000, completion_tokens: 50 }));
    for (const t of ['un', 'deux', 'trois']) await send(t);
    expect(await h.call('compactions.list', { conversationId: c.id })).toHaveLength(1);
  });
});
