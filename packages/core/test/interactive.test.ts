import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mockProvider, sseChunk, tempHarness } from './helpers.ts';
import type { HostKind } from '../src/platform/capabilities.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type Body = { messages: { role: string; content: string }[] };

/** Prompt système reçu par le fournisseur pour un message envoyé dans cette configuration. */
async function systemPrompt(opts: { host?: HostKind; mode?: 'chat' | 'agent'; agentMode?: 'plan' | 'propose' | 'execute'; enabled?: boolean; subagent?: boolean }): Promise<string> {
  const mock = await mockProvider((_req, _raw, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`${sseChunk({ content: 'ok' })}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  cleanups.push(mock.close);
  const t = tempHarness(undefined, { host: opts.host ?? 'desktop' });
  cleanups.push(t.cleanup);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false }, ...(opts.enabled === undefined ? {} : { render: { interactiveHtml: opts.enabled } }) });
  const c = await h.call('conversations.create', { projectId: null });
  await h.call('conversations.update', { id: c.id, patch: { mode: opts.mode ?? 'chat', ...(opts.agentMode ? { agentMode: opts.agentMode } : {}) } });
  await h.call('chat.send', { conversationId: c.id, input: { text: 'bonjour' } });
  await h.generation.idle();
  const body = mock.requests.find((r) => r.path.endsWith('/chat/completions'))!.body as Body;
  return body.messages[0]!.content;
}

describe('consigne des blocs interactifs', () => {
  it('jointe sur le bureau dans tous les modes, y compris Chat et Proposition', async () => {
    for (const opts of [{ mode: 'chat' as const }, { mode: 'agent' as const, agentMode: 'plan' as const }, { mode: 'agent' as const, agentMode: 'propose' as const }, { mode: 'agent' as const, agentMode: 'execute' as const }]) {
      const system = await systemPrompt(opts);
      expect(system).toContain('```widget Titre court');
      expect(system).toContain('aucun CDN');
      expect(system).toContain('Tailwind CSS 4');
      expect(system).toContain('Chart.js 4');
    }
  });

  it('absente quand le réglage est coupé ou que l’hôte n’exécute pas ces blocs', async () => {
    expect(await systemPrompt({ enabled: false })).not.toContain('```widget');
    expect(await systemPrompt({ host: 'cli' })).not.toContain('```widget');
    expect(await systemPrompt({ host: 'server' })).not.toContain('```widget');
  });
});
