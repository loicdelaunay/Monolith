import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { MessagePart } from '@monolith/contracts';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';
import { htmlToText, parseDuckDuckGo, safeFetch } from '../src/tools/web.ts';
import { parseSkillFile } from '../src/tools/knowledge.ts';
import { chunkText } from '../src/services/rag.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
type Step = { tool: string; args: Record<string, unknown> } | { text: string };

function toolStream(name: string, args: Record<string, unknown>, id: string): string {
  let out = sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`;
  return `${out}data: [DONE]\n\n`;
}

async function setup(steps: Step[]) {
  const folder = mkdtempSync(join(tmpdir(), 'mh-t6-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const bodies: Body[] = [];
  let n = 0;
  const mock = await mockProvider((req, raw, res: ServerResponse) => {
    if (req.url?.endsWith('/embeddings')) {
      // Embeddings déterministes : présence de quelques mots-clés.
      const input = (JSON.parse(raw) as { input: string[] }).input;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map((s, index) => ({ index, embedding: ['chat', 'chien', 'facture', 'paiement'].map((w) => (s.toLowerCase().includes(w) ? 1 : 0.01)) })) }));
      return;
    }
    const body = JSON.parse(raw || '{}') as Body;
    bodies.push(body);
    const step = steps[Math.min(n++, steps.length - 1)]!;
    void writeFragmented(res, 'tool' in step ? toolStream(step.tool, step.args, `call_${n}`) : standardStream(step.text), 13);
  });
  cleanups.push(mock.close);
  const h = t.harness;
  writeFileSync(join(folder, 'README.md'), '# Projet\nLe chat dort sur le canapé.\n');
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'src', 'billing.ts'), 'export function payer(facture: number) {\n  // paiement de la facture\n  return facture;\n}\n');
  const project = await h.call('projects.create', { name: 'P' });
  await h.call('projects.addFolder', { id: project.id, path: folder });
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false } });
  const c = await h.call('conversations.create', { projectId: project.id });
  await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
  h.events.on('permission.requested', (r) => setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5));
  return { h, folder, project, conversationId: c.id, bodies, providerId: p.id };
}

const tools = (parts: MessagePart[]) => parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);
async function lastAssistant(h: Awaited<ReturnType<typeof setup>>['h'], conversationId: number) {
  return (await h.call('messages.list', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;
}

describe('mémoire', () => {
  it('portées, recherche, versions et lecture forcée dans les instructions', async () => {
    const { h, project, conversationId, bodies } = await setup([{ tool: 'memory_save', args: { title: 'Langue', content: 'L’utilisateur préfère le tutoiement', scope: 'user' } }, { text: 'Noté.' }]);
    const g = await h.call('memory.save', { scope: 'global', title: 'Style', content: 'Réponses concises avec exemples' });
    await h.call('memory.save', { scope: 'project', projectId: project.id, title: 'Pile', content: 'TypeScript et Vue' });
    const other = await h.call('projects.create', { name: 'Autre' });
    await h.call('memory.save', { scope: 'project', projectId: other.id, title: 'Secret projet', content: 'invisible ailleurs' });
    await h.call('memory.save', { id: g.id, scope: 'global', title: 'Style', content: 'Réponses très concises' });
    const full = await h.call('memory.get', { id: g.id });
    expect(full.version).toBe(2);
    expect(full.versions[0]).toMatchObject({ version: 1, content: 'Réponses concises avec exemples' });
    expect((await h.call('memory.list', { query: 'concises' })).total).toBe(1);
    expect((await h.call('memory.list', { scope: 'project', sort: 'title', order: 'asc' })).items.map((m) => m.title)).toEqual(['Pile', 'Secret projet']);

    await h.call('settings.update', { memory: { forcedRead: true, forcedReadCount: 10 } });
    await h.call('chat.send', { conversationId, input: { text: 'Retiens que je préfère le tutoiement' } });
    await h.generation.idle();
    const system = String(bodies[0]!.messages[0]!.content);
    expect(system).toContain('Réponses très concises');
    expect(system).toContain('TypeScript et Vue');
    expect(system).not.toContain('invisible ailleurs');
    const saved = (await h.call('memory.list', { scope: 'user' })).items[0]!;
    expect(saved).toMatchObject({ title: 'Langue', source: 'agent', sourceConversationId: conversationId });
  });
});

describe('index.ohm', () => {
  it('création, navigation, recherche, explications et explication périmée', async () => {
    const { h, folder, conversationId } = await setup([
      { tool: 'file_index_create', args: {} },
      { tool: 'file_index_describe', args: { entries: [{ path: 'src/billing.ts', description: 'Calcul et paiement des factures' }] } },
      { tool: 'file_index_read', args: { query: 'factures' } },
      { text: 'Fait.' },
      { tool: 'file_index_read', args: { path: 'src' } },
      { text: 'Relu.' },
    ]);
    await h.call('settings.update', { skills: { enabled: { ...(await h.call('settings.get')).skills.enabled, file_index: true } } });
    await h.call('chat.send', { conversationId, input: { text: 'Indexe' } });
    await h.generation.idle();
    const calls = tools((await lastAssistant(h, conversationId)).parts);
    expect(calls.map((c) => c.status)).toEqual(['done', 'done', 'done']);
    expect(calls[2]!.result).toContain('src/billing.ts');
    const doc = JSON.parse(readFileSync(join(folder, 'index.ohm'), 'utf8')) as { entries: { path: string; descriptionSource: string; descriptionStale: boolean; generatedDescription: string }[] };
    const billing = doc.entries.find((e) => e.path === 'src/billing.ts')!;
    expect(billing).toMatchObject({ descriptionSource: 'model', descriptionStale: false });
    expect(billing.generatedDescription).toContain('payer');
    expect(doc.entries.some((e) => e.path === 'index.ohm')).toBe(false);
    // Modification externe : l'explication du modèle est conservée mais marquée à revoir.
    writeFileSync(join(folder, 'src', 'billing.ts'), 'export const x = 1;\n');
    await h.call('chat.send', { conversationId, input: { text: 'Relis' } });
    await h.generation.idle();
    const after = JSON.parse(readFileSync(join(folder, 'index.ohm'), 'utf8')) as typeof doc;
    expect(after.entries.find((e) => e.path === 'src/billing.ts')).toMatchObject({ descriptionSource: 'model', descriptionStale: true });
  });
});

describe('RAG', () => {
  it('indexation incrémentale, recherche lexicale et vectorielle, index périmé', async () => {
    const { h, folder, conversationId, providerId } = await setup([{ text: 'ok' }]);
    let status = await h.call('rag.index', { conversationId });
    expect(status.roots[0]).toMatchObject({ files: 2, stale: 0, embeddingModel: null });
    expect(chunkText(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 40).map((c) => [c.start, c.end])).toEqual([[1, 40], [35, 74], [69, 100]]);
    const rag = (h as unknown as { rag: { search: (r: string[], q: string, k: number, s: AbortSignal) => Promise<{ path: string; startLine: number }[]> } }).rag;
    expect((await rag.search([folder], 'facture', 5, AbortSignal.timeout(5000)))[0]!.path).toBe('src/billing.ts');
    writeFileSync(join(folder, 'notes.txt'), 'nouveau fichier');
    expect((await h.call('rag.status', { conversationId })).roots[0]!.stale).toBe(1);
    // Embeddings : tout est réindexé avec le modèle configuré ; la recherche fusionne les deux classements.
    await h.call('settings.update', { rag: { embeddingProviderId: providerId, embeddingModel: 'emb' } });
    status = await h.call('rag.index', { conversationId });
    expect(status.roots[0]).toMatchObject({ files: 3, stale: 0, embeddingModel: 'emb' });
    const hits = await rag.search([folder], 'chat', 3, AbortSignal.timeout(5000));
    expect(hits[0]!.path).toBe('README.md');
    expect((await h.call('rag.clear', { conversationId })).roots[0]!.files).toBe(0);
  });
});

describe('web', () => {
  it('extrait le texte, lit les résultats DuckDuckGo et refuse les adresses privées', async () => {
    const { title, text } = htmlToText('<html><head><title>Titre &amp; test</title><style>x{}</style></head><body><nav>menu</nav><h1>Bonjour</h1><p>Un <a href="https://ex.com/a">lien</a>.</p><script>alert(1)</script><ul><li>un</li><li>deux</li></ul></body></html>');
    expect(title).toBe('Titre & test');
    expect(text).toContain('# Bonjour');
    expect(text).toContain('[lien](https://ex.com/a)');
    expect(text).toContain('- deux');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('menu');
    const results = parseDuckDuckGo('<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&amp;rut=x">Exemple <b>page</b></a><a class="result__snippet" href="#">Un extrait</a></div>');
    expect(results).toEqual([{ title: 'Exemple page', url: 'https://example.org/page', snippet: 'Un extrait' }]);
    await expect(safeFetch('http://127.0.0.1:1/', { signal: AbortSignal.timeout(2000) })).rejects.toThrow(/privée|locale/);
    await expect(safeFetch('file:///etc/passwd', { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});

describe('skills personnalisés', () => {
  it('découverte SKILL.md, liste dans les instructions, chargement et création', async () => {
    const { h, folder, conversationId, bodies, project } = await setup([{ tool: 'load_skill', args: { name: 'revue-securite' } }, { tool: 'create_skill', args: { name: 'nouveau', description: 'Un skill créé', instructions: 'Faire X' } }, { text: 'ok' }]);
    mkdirSync(join(folder, '.monolith', 'skills', 'revue-securite'), { recursive: true });
    writeFileSync(join(folder, '.monolith', 'skills', 'revue-securite', 'SKILL.md'), '---\nname: revue-securite\ndescription: "Vérifie les failles courantes"\n---\n\n# Étapes\n1. Lire\n');
    writeFileSync(join(folder, '.monolith', 'skills', 'revue-securite', 'grille.md'), 'grille');
    expect(parseSkillFile('pas de frontmatter')).toBeNull();
    expect((await h.call('skills.custom', { projectId: project.id })).map((s) => s.name)).toEqual(['revue-securite']);
    await h.call('chat.send', { conversationId, input: { text: 'Applique' } });
    await h.generation.idle();
    expect(String(bodies[0]!.messages[0]!.content)).toContain('revue-securite : Vérifie les failles courantes');
    const calls = tools((await lastAssistant(h, conversationId)).parts);
    expect(calls[0]!.result).toContain('# Étapes');
    expect(calls[0]!.result).toContain('grille.md');
    expect(calls[1]!.status).toBe('done');
    expect(readFileSync(join(folder, '.monolith', 'skills', 'nouveau', 'SKILL.md'), 'utf8')).toContain('name: nouveau');
  });
});

describe('MCP', () => {
  it('stdio : connexion, outils exposés, appel, secret chiffré, activation par conversation', async () => {
    const { h, conversationId, bodies } = await setup([{ tool: 'mcp__fake__echo', args: { text: 'salut' } }, { tool: 'mcp__fake__secret_env', args: {} }, { text: 'ok' }, { text: 'sans MCP' }]);
    const server = join(import.meta.dirname, 'fixtures', 'fake-mcp-server.mjs');
    const preview = await h.call('mcp.previewImport', { json: JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server], env: { FAKE_TOKEN: 'abc123', MODE: 'test' } }, ancien: { type: 'sse', url: 'http://x/sse' } } }) });
    expect(preview.servers[0]).toMatchObject({ name: 'fake', transport: 'stdio', secrets: { FAKE_TOKEN: 'abc123' }, config: { env: { MODE: 'test' } } });
    expect(preview.errors[0]).toContain('SSE');
    const [created] = await h.call('mcp.import', { json: JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [server], env: { FAKE_TOKEN: 'abc123' } } } }) });
    expect(created!.config.secretEnv).toEqual(['FAKE_TOKEN']);
    expect(JSON.stringify(created!.config)).not.toContain('abc123');
    const connected = await h.call('mcp.connect', { id: created!.id });
    expect(connected).toMatchObject({ status: 'connected', serverInfo: { name: 'fake-mcp' } });
    expect(connected.tools.map((t) => [t.name, t.readOnly])).toEqual([['echo', true], ['secret_env', false]]);

    await h.call('chat.send', { conversationId, input: { text: 'Utilise MCP' } });
    await h.generation.idle();
    expect(bodies[0]!.tools!.map((t) => t.function.name)).toEqual(expect.arrayContaining(['mcp__fake__echo', 'mcp__fake__secret_env']));
    const calls = tools((await lastAssistant(h, conversationId)).parts);
    expect(calls[0]).toMatchObject({ status: 'done', permission: { source: 'automatic' } });
    expect(calls[0]!.result).toContain('écho : salut');
    expect(calls[1]!.result).toContain('jeton présent (6 car.)');

    await h.call('mcp.setConversation', { conversationId, serverId: created!.id, enabled: false });
    await h.call('chat.send', { conversationId, input: { text: 'Sans MCP' } });
    await h.generation.idle();
    expect(bodies.at(-1)!.tools?.some((t) => t.function.name.startsWith('mcp__')) ?? false).toBe(false);
  });

  it('HTTP streamable : session, réponse en flux SSE, en-tête secret', async () => {
    const { h } = await setup([{ text: 'ok' }]);
    const seen: { auth: string | undefined; session: string | undefined }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined });
        if (req.method === 'DELETE') return res.writeHead(200).end();
        const msg = JSON.parse(raw) as { id?: number; method: string };
        if (msg.id === undefined) return res.writeHead(202).end();
        const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-mcp', version: '1' } } : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-42' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const s = await h.call('mcp.create', { name: 'distant', transport: 'http', config: { url }, secrets: { Authorization: 'Bearer secret-xyz' } });
    expect(s.config.secretHeaders).toEqual(['Authorization']);
    const c = await h.call('mcp.connect', { id: s.id });
    expect(c).toMatchObject({ status: 'connected', serverInfo: { name: 'http-mcp' }, tools: [{ name: 'ping' }] });
    expect(seen.every((x) => x.auth === 'Bearer secret-xyz')).toBe(true);
    expect(seen.at(-1)!.session).toBe('sess-42');
    await h.call('mcp.delete', { id: s.id });
    expect(await h.call('mcp.list')).toEqual([]);
  });
});
