import { afterEach, describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { MessagePart, ToolCallRecord } from '@monolith/contracts';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';
import { thinkingConfig, toGemini } from '../src/providers/gemini.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const gsse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const tools = (parts: MessagePart[]) => parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);

async function base() {
  // Le dossier est supprimé après l'arrêt du moteur (et des agents ACP qui y travaillent).
  const folder = mkdtempSync(join(tmpdir(), 'mh-t5-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const t = tempHarness();
  cleanups.push(t.cleanup);
  writeFileSync(join(folder, 'README.md'), '# Projet T5\n');
  const h = t.harness;
  const project = await h.call('projects.create', { name: 'P' });
  await h.call('projects.addFolder', { id: project.id, path: folder });
  return { h, folder, project };
}

async function lastAssistant(h: Awaited<ReturnType<typeof base>>['h'], conversationId: number) {
  return (await h.call('messages.list', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;
}

describe('Gemini natif', () => {
  it('traduit l’historique, les outils et la réflexion ; renvoie la signature de réflexion', async () => {
    const { h, project } = await base();
    let n = 0;
    const mock = await mockProvider((req, _raw, res: ServerResponse) => {
      if (req.url?.includes('/models?')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }));
        return;
      }
      n++;
      const payload =
        n === 1
          ? gsse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Je regarde.', thought: true }] } }] }) +
            gsse({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'sig-123' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 } })
          : gsse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Le README contient un titre.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 8 } });
      void writeFragmented(res, payload, 11);
    });
    cleanups.push(mock.close);
    const p = await h.call('providers.create', { name: 'Gemini', kind: 'gemini', preset: 'gemini', baseUrl: `${mock.url}beta`, apiKey: 'AIza-test-key' });
    const catalog = await h.call('providers.fetchCatalog', { id: p.id });
    expect(catalog.map((m) => m.id)).toEqual(['gemini-2.5-flash']);
    expect(catalog[0]!.capabilities.reasoningLevels).toEqual(['none', 'low', 'medium', 'high']);
    await h.call('providers.setModels', { id: p.id, models: catalog.map((m) => ({ ...m, enabled: true, source: 'catalog' as const })) });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { providerId: p.id, model: 'gemini-2.5-flash', mode: 'agent', agentMode: 'execute', reasoningLevel: 'low' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Lis le README' } });
    await h.generation.idle();

    const msg = await lastAssistant(h, c.id);
    expect(msg.status).toBe('complete');
    expect(msg.parts.find((x) => x.type === 'reasoning')).toMatchObject({ text: 'Je regarde.' });
    const call = tools(msg.parts)[0] as ToolCallRecord;
    expect(call).toMatchObject({ name: 'read_file', status: 'done', meta: { thoughtSignature: 'sig-123' } });
    expect(msg.parts.at(-1)).toMatchObject({ type: 'text', text: 'Le README contient un titre.' });

    const chats = mock.requests.filter((r) => r.path.includes(':streamGenerateContent'));
    expect(chats[0]!.path).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(chats[0]!.headers['x-goog-api-key']).toBe('AIza-test-key');
    const first = chats[0]!.body as { systemInstruction: { parts: { text: string }[] }; tools: { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[]; generationConfig: { thinkingConfig: unknown } };
    expect(first.systemInstruction.parts[0]!.text.length).toBeGreaterThan(10);
    expect(first.tools[0]!.functionDeclarations.map((f) => f.name)).toContain('read_file');
    expect(first.tools[0]!.functionDeclarations[0]!.parametersJsonSchema).toBeTruthy();
    expect(first.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });
    const second = chats[1]!.body as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const model = second.contents.find((x) => x.role === 'model')!;
    expect(model.parts.find((x) => x.functionCall)).toMatchObject({ functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'sig-123' });
    expect(second.contents.at(-1)!.parts[0]).toMatchObject({ functionResponse: { name: 'read_file' } });
    // Consommation : réflexion comptée dans la sortie.
    expect(msg.usage).toMatchObject({ inputTokens: 130, outputTokens: 23, reasoningTokens: 5, estimated: false });
  });

  it('niveaux de réflexion selon la génération du modèle', () => {
    expect(thinkingConfig('gemini-3-pro-preview', 'low')).toEqual({ thinkingLevel: 'low', includeThoughts: true });
    expect(thinkingConfig('gemini-2.5-pro', 'high')).toEqual({ thinkingBudget: 32768, includeThoughts: true });
    expect(thinkingConfig('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfig('gemini-2.0-flash', null)).toBeNull();
    // Historique sans signature (autre fournisseur) : signature factice documentée pour Gemini 3.
    const g = toGemini([{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }] }, { role: 'tool', toolCallId: 'a', content: 'ok' }], 'gemini-3-pro-preview');
    expect(g.contents[0]!.parts[0]!.thoughtSignature).toBe('skip_thought_signature_validator');
    expect(g.contents[1]!.parts[0]).toMatchObject({ functionResponse: { name: 'x', response: { result: 'ok' } } });
  });
});

describe('Vertex AI', () => {
  it('compte de service : JWT signé localement, jeton Bearer, projet et région', async () => {
    const { h, project } = await base();
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const mock = await mockProvider((req, raw, res: ServerResponse) => {
      if (req.url === '/token') {
        tokenRequests++;
        const assertion = new URLSearchParams(raw).get('assertion') ?? '';
        const [hd, cl, sig] = assertion.split('.');
        const ok = createVerify('RSA-SHA256').update(`${hd}.${cl}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
        const claims = JSON.parse(Buffer.from(cl!, 'base64url').toString()) as { iss: string; scope: string };
        res.writeHead(ok && claims.iss === 'sa@p.iam.gserviceaccount.com' && claims.scope.includes('cloud-platform') ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }));
        return;
      }
      void writeFragmented(res, gsse({ candidates: [{ content: { parts: [{ text: 'Bonjour de Vertex.' }] }, finishReason: 'STOP' }] }));
    });
    cleanups.push(mock.close);
    const origin = mock.url.replace(/\/v1$/, '');
    const sa = JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), project_id: 'mon-projet-42', token_uri: `${origin}/token` }, null, 2);
    const p = await h.call('providers.create', { name: 'Vertex', kind: 'vertex', preset: 'vertex', baseUrl: mock.url, apiKey: sa, options: { google: { project: '', location: 'europe-west1', auth: 'service_account' } } });
    expect(p.hasKey).toBe(true);
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { providerId: p.id, model: 'gemini-2.5-pro' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Bonjour' } });
    await h.generation.idle();
    expect((await lastAssistant(h, c.id)).parts.at(-1)).toMatchObject({ type: 'text', text: 'Bonjour de Vertex.' });
    const call = mock.requests.find((r) => r.path.includes(':streamGenerateContent'))!;
    expect(call.path).toBe('/v1/projects/mon-projet-42/locations/europe-west1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(call.headers.authorization).toBe('Bearer ya29.test');
    expect(tokenRequests).toBe(1);
    // JSON invalide ou token_uri hors Google refusés.
    await expect(h.call('providers.setKey', { id: p.id, apiKey: '{"type":"authorized_user"}' })).rejects.toThrow(/compte de service/);
    await expect(h.call('providers.setKey', { id: p.id, apiKey: JSON.stringify({ type: 'service_account', client_email: 'x', private_key: '-----BEGIN PRIVATE KEY-----', token_uri: 'https://evil.example/token' }) })).rejects.toThrow(/token_uri/);
  });
});

describe('Agent externe ACP', () => {
  it('session, réflexion, plan, demande d’autorisation, écriture dans la portée, message final', async () => {
    const { h, project, folder } = await base();
    const agent = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs');
    const test = await h.call('providers.test', { kind: 'acp', baseUrl: '', options: { acp: { command: process.execPath, args: [agent], env: {} } } });
    expect(test).toMatchObject({ ok: true, message: expect.stringContaining('fake-agent') });
    const p = await h.call('providers.create', { name: 'Agent', kind: 'acp', preset: 'acp', baseUrl: '', options: { acp: { command: process.execPath, args: [agent], env: { FAKE_MODE: '1' } } } });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'agent', label: 'Agent', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'catalog', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: true } }] });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { providerId: p.id, model: 'agent', mode: 'agent', agentMode: 'execute' } });
    const asked: string[] = [];
    h.events.on('permission.requested', (r) => {
      asked.push(r.tool);
      setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5);
    });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Bonjour agent' } });
    await h.generation.idle();
    const msg = await lastAssistant(h, c.id);
    expect(msg.status).toBe('complete');
    expect(asked).toEqual(['acp_edit']);
    expect(readFileSync(join(folder, 'agent.txt'), 'utf8')).toBe("écrit par l'agent : Bonjour agent");
    const calls = tools(msg.parts);
    expect(calls.find((x) => x.name === 'acp_plan')).toMatchObject({ external: true, display: { kind: 'plan' } });
    expect(calls.find((x) => x.id === 'tc1')).toMatchObject({ external: true, status: 'done', target: 'Écrire agent.txt', display: { kind: 'changes' } });
    expect(msg.parts.find((x) => x.type === 'reasoning')).toMatchObject({ text: 'Je réfléchis.' });
    expect(msg.parts.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('Terminé') });

    // Mode Plan : l'écriture est refusée par le moteur, sans demander à l'utilisateur.
    rmSync(join(folder, 'agent.txt'));
    await h.call('conversations.update', { id: c.id, patch: { agentMode: 'plan' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Encore' } });
    await h.generation.idle();
    expect(asked).toEqual(['acp_edit']);
    expect(existsSync(join(folder, 'agent.txt'))).toBe(false);
    expect(tools((await lastAssistant(h, c.id)).parts).find((x) => x.id === 'tc1')!.status).toBe('error');
  });

  it('refuse les variables d’environnement secrètes et signale une commande introuvable', async () => {
    const { h } = await base();
    await expect(h.call('providers.create', { name: 'A', kind: 'acp', preset: 'acp', baseUrl: '', options: { acp: { command: 'x', args: [], env: { OPENAI_API_KEY: 'sk' } } } })).rejects.toThrow(/secret/);
    const r = await h.call('providers.test', { kind: 'acp', baseUrl: '', options: { acp: { command: 'commande-inexistante-mh', args: [], env: {} } } });
    expect(r.ok).toBe(false);
  });
});

describe('Modèle composé', () => {
  it('l’orchestrateur consulte un spécialiste puis répond ; consommation cumulée', async () => {
    const { h, project } = await base();
    let orchCalls = 0;
    const orch = await mockProvider((_req, raw, res: ServerResponse) => {
      orchCalls++;
      const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      if (orchCalls === 1) {
        expect(body.tools?.map((t) => t.function.name)).toContain('consult_specialist');
        const args = JSON.stringify({ specialist: 'traducteur', task: 'Traduis « bonjour » en anglais' });
        let out = sseChunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'consult_specialist', arguments: args } }] });
        out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`;
        return writeFragmented(res, `${out}data: [DONE]\n\n`);
      }
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      expect(String(toolMsg?.content)).toContain('hello');
      return writeFragmented(res, standardStream('Le spécialiste dit : hello.'));
    });
    const spec = await mockProvider((_req, _raw, res: ServerResponse) => writeFragmented(res, standardStream('hello')));
    cleanups.push(orch.close, spec.close);
    const caps = { reasoningLevels: [], reasoningSource: 'unknown' as const, rejectedLevels: [], vision: null, tools: null };
    const po = await h.call('providers.create', { name: 'Orch', kind: 'openai-compatible', preset: 'custom', baseUrl: orch.url });
    const ps = await h.call('providers.create', { name: 'Spec', kind: 'openai-compatible', preset: 'custom', baseUrl: spec.url });
    const pc = await h.call('providers.create', {
      name: 'Composé',
      kind: 'composite',
      preset: 'composite',
      baseUrl: '',
      options: { composite: { orchestrator: { providerId: po.id, model: 'o' }, specialists: [{ name: 'traducteur', description: 'traductions', providerId: ps.id, model: 's' }], maxConsultations: 3 } },
    });
    expect((await h.call('providers.test', { providerId: pc.id, kind: 'composite', baseUrl: '' })).ok).toBe(true);
    await h.call('providers.setModels', { id: pc.id, models: [{ id: 'composite', label: 'Composé', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'catalog', capabilities: caps }] });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { providerId: pc.id, model: 'composite' } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Comment dit-on bonjour ?' } });
    await h.generation.idle();
    const msg = await lastAssistant(h, c.id);
    expect(msg.status).toBe('complete');
    const consult = tools(msg.parts)[0]!;
    expect(consult).toMatchObject({ name: 'consult_specialist', external: true, status: 'done', result: 'hello' });
    expect(consult.target).toContain('Spec');
    expect(msg.parts.at(-1)).toMatchObject({ type: 'text', text: 'Le spécialiste dit : hello.' });
    expect(msg.usage!.inputTokens).toBeGreaterThanOrEqual(100);
    // Un composé ne peut pas en contenir un autre ; noms en double refusés.
    await expect(h.call('providers.update', { id: pc.id, patch: { options: { composite: { orchestrator: { providerId: po.id, model: 'o' }, specialists: [{ name: 'a', description: '', providerId: ps.id, model: 's' }, { name: 'a', description: '', providerId: ps.id, model: 's' }], maxConsultations: 3 } } } })).rejects.toThrow(/même nom/);
  });
});
