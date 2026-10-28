import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type MessagePart } from '@monolith/contracts';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';
import { allowedUrl } from '../src/tools/local-access.ts';
import type { ToolContext, ToolDefinition } from '../src/tools/types.ts';
import { modeAllows } from '../src/tools/registry.ts';
import { silentLogger } from '../src/log/logger.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { tools?: { function: { name: string } }[] };
type Step = { tool: string; args: Record<string, unknown> } | { text: string };

function toolStream(name: string, args: Record<string, unknown>, id: string): string {
  const out = sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  return `${out}data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
}

async function setup(steps: Step[]) {
  const t = tempHarness(undefined, { chromeMcp: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'fake-chrome-mcp.mjs')] } });
  cleanups.push(t.cleanup);
  const bodies: Body[] = [];
  let n = 0;
  const mock = await mockProvider((_req, raw, res: ServerResponse) => {
    bodies.push(JSON.parse(raw || '{}') as Body);
    const step = steps[Math.min(n++, steps.length - 1)]!;
    void writeFragmented(res, 'tool' in step ? toolStream(step.tool, step.args, `call_${n}`) : standardStream(step.text), 13);
  });
  cleanups.push(mock.close);
  const h = t.harness;
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false } });
  const c = await h.call('conversations.create', { projectId: null });
  await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
  const requests: string[] = [];
  h.events.on('permission.requested', (r) => {
    requests.push(r.target ?? '');
    setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5);
  });
  return { h, conversationId: c.id, bodies, requests };
}

const toolCalls = (parts: MessagePart[]) => parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);

describe('navigateur : intégré ou Chrome du poste (Chrome DevTools MCP)', () => {
  it('Chrome : outils chrome__* exposés, adresse locale soumise à votre accord, retour au navigateur intégré', async () => {
    const { h, conversationId, bodies, requests } = await setup([{ tool: 'chrome__navigate_page', args: { url: 'http://127.0.0.1:5173/' } }, { text: 'ok' }, { text: 'intégré' }]);
    await h.call('settings.update', { browser: { backend: 'chrome' } });
    await h.call('chat.send', { conversationId, input: { text: 'Ouvre mon serveur local' } });
    await h.generation.idle();
    expect(bodies[0]!.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(['chrome__list_pages', 'chrome__navigate_page']));
    expect(requests).toContain('Adresse locale · http://127.0.0.1:5173');
    const messages = await h.call('messages.list', { conversationId });
    const call = toolCalls(messages.filter((m) => m.role === 'assistant').at(-1)!.parts)[0]!;
    expect(call).toMatchObject({ status: 'done' });
    expect(call.result).toContain('Page ouverte : http://127.0.0.1:5173/');

    await h.call('settings.update', { browser: { backend: 'embedded' } });
    await h.call('chat.send', { conversationId, input: { text: 'Et maintenant ?' } });
    await h.generation.idle();
    expect(bodies.at(-1)!.tools?.some((t) => t.function.name.startsWith('chrome__')) ?? false).toBe(false);
  });

  it('les outils du navigateur intégré sont remplacés en mode Chrome', async () => {
    const { h } = await setup([{ text: 'ok' }]);
    const tool = (name: string) => ({ name, family: 'browser' }) as ToolDefinition;
    const chrome = { ...DEFAULT_SETTINGS, browser: { backend: 'chrome' as const, chromePath: '' } };
    expect(h.chrome.allows(tool('browser_open'), chrome)).toBe(false);
    expect(h.chrome.allows(tool('chrome__navigate_page'), chrome)).toBe(true);
    expect(h.chrome.allows(tool('browser_open'), DEFAULT_SETTINGS)).toBe(true);
    expect(h.chrome.allows(tool('chrome__navigate_page'), DEFAULT_SETTINGS)).toBe(false);
  });
});

describe('adresses locales demandées par le modèle', () => {
  const ctx = (answer: boolean, asked: string[]) => ({ authorize: async (resources: string[]) => (asked.push(resources.at(-1)!), answer) }) as unknown as ToolContext;

  it('adresse publique : aucune demande ; adresse locale : accord demandé par hôte et port', async () => {
    const asked: string[] = [];
    expect((await allowedUrl('https://93.184.215.14/', ctx(true, asked))).hostname).toBe('93.184.215.14');
    expect(asked).toEqual([]);
    expect((await allowedUrl('http://localhost:3000/app', ctx(true, asked))).href).toBe('http://localhost:3000/app');
    expect(asked).toEqual(['local-network:localhost:3000']);
  });

  it('refus de l’utilisateur : aucune requête, message explicite ; schémas non web toujours refusés', async () => {
    await expect(allowedUrl('http://127.0.0.1:8080/', ctx(false, []))).rejects.toThrow(/refusé par l’utilisateur/);
    const asked: string[] = [];
    await expect(allowedUrl('file:///C:/Windows/win.ini', ctx(true, asked))).rejects.toThrow(/Schéma non autorisé/);
    expect(asked).toEqual([]);
  });
});

describe('navigateur selon le mode Agent', () => {
  const tool = (name: string, family: ToolDefinition['family'], effects: ToolDefinition['effects']) => ({ name, family, skill: 'x', effects }) as unknown as ToolDefinition;
  it('Proposition : navigateur (intégré et Chrome) et web, mais ni commandes ni bureau ; Plan : lecture seule', () => {
    const allowed = (t: ToolDefinition, m: 'plan' | 'propose' | 'execute') => modeAllows(t, 'agent', m).ok;
    expect(allowed(tool('browser_open', 'browser', ['network']), 'propose')).toBe(true);
    expect(allowed(tool('browser_click', 'browser', ['desktop']), 'propose')).toBe(true);
    expect(allowed(tool('chrome__click', 'browser', ['network', 'desktop']), 'propose')).toBe(true);
    expect(allowed(tool('web_http_request', 'web', ['network']), 'propose')).toBe(true);
    expect(allowed(tool('run_command', 'terminal' as never, ['exec']), 'propose')).toBe(false);
    expect(allowed(tool('desktop_mouse', 'desktop', ['desktop']), 'propose')).toBe(false);
    expect(allowed(tool('mcp__x__do', 'mcp', ['exec', 'network']), 'propose')).toBe(false);
    expect(allowed(tool('browser_open', 'browser', ['network']), 'plan')).toBe(false);
    expect(allowed(tool('chrome__take_snapshot', 'browser', ['read', 'network']), 'plan')).toBe(false);
  });

  it('Chrome DevTools MCP : un seul démarrage pour des générations simultanées', async () => {
    const started: string[] = [];
    const logger = { ...silentLogger, info: (_c: string, message: string) => void (message.includes('Chrome DevTools MCP connecté') && started.push(message)) };
    const t = tempHarness(undefined, { logger, chromeMcp: { command: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'fake-chrome-mcp.mjs')] } });
    cleanups.push(t.cleanup);
    const settings = { ...DEFAULT_SETTINGS, browser: { backend: 'chrome' as const, chromePath: '' } };
    expect(await Promise.all([t.harness.chrome.ensure(settings), t.harness.chrome.ensure(settings), t.harness.chrome.ensure(settings)])).toEqual([null, null, null]);
    expect(started).toHaveLength(1);
  });
});
