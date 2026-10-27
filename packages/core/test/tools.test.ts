import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { HarnessEvents, MessagePart, PermissionRequest, ToolCallRecord } from '@monolith/contracts';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';
import { globToRegExp } from '../src/permissions/engine.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
type Step = { tool: string; args: Record<string, unknown> } | { text: string };

function toolCallStream(name: string, args: Record<string, unknown>, id: string): string {
  const json = JSON.stringify(args);
  let out = sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] });
  for (let i = 0; i < json.length; i += 7) out += sseChunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 7) } }] });
  out += `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`;
  return out + 'data: [DONE]\n\n';
}

function textStream(text: string): string {
  return sseChunk({ content: text }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` + 'data: [DONE]\n\n';
}

/** Faux modèle scénarisé : chaque requête de chat consomme l'étape suivante. */
async function scripted(steps: Step[]) {
  const bodies: Body[] = [];
  let n = 0;
  const mock = await mockProvider((_req, raw, res: ServerResponse) => {
    const body = JSON.parse(raw || '{}') as Body;
    bodies.push(body);
    const step = steps[Math.min(n, steps.length - 1)]!;
    n++;
    return writeFragmented(res, 'tool' in step ? toolCallStream(step.tool, step.args, `call_${n}`) : textStream(step.text), 9);
  });
  cleanups.push(mock.close);
  return { url: mock.url, bodies };
}

async function setup(url: string, opts: { mode?: 'chat' | 'agent'; agentMode?: 'plan' | 'propose' | 'execute'; withFolder?: boolean } = {}) {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const h = t.harness;
  const folder = mkdtempSync(join(tmpdir(), 'mh-proj-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'README.md'), '# Projet\nLigne deux\n');
  mkdirSync(join(folder, 'src'));
  writeFileSync(join(folder, 'src', 'a.ts'), 'export const a = 1;\n');
  const project = await h.call('projects.create', { name: 'P' });
  if (opts.withFolder !== false) await h.call('projects.addFolder', { id: project.id, path: folder });
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false } });
  const c = await h.call('conversations.create', { projectId: project.id });
  await h.call('conversations.update', { id: c.id, patch: { mode: opts.mode ?? 'agent', agentMode: opts.agentMode ?? 'execute' } });
  return { h, c, folder, project, dir: t.dir };
}

const toolParts = (parts: MessagePart[]) => parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);
async function lastAssistant(h: Awaited<ReturnType<typeof setup>>['h'], conversationId: number) {
  return (await h.call('messages.list', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;
}

/** Répond automatiquement aux demandes d'autorisation. */
function autoRespond(h: Awaited<ReturnType<typeof setup>>['h'], decision: 'allow' | 'deny', scope: 'once' | 'conversation' = 'once') {
  const seen: PermissionRequest[] = [];
  h.events.on('permission.requested', (r) => {
    seen.push(r);
    setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision, scope }), 5);
  });
  return seen;
}

describe('boucle d’outils', () => {
  it('exécute un outil de lecture puis renvoie son résultat au modèle, dans l’ordre', async () => {
    const m = await scripted([{ tool: 'read_file', args: { path: 'README.md' } }, { text: 'Le projet contient un README.' }]);
    const { h, c } = await setup(m.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Lis le README' } });
    await h.generation.idle();
    const reply = await lastAssistant(h, c.id);
    expect(reply.status).toBe('complete');
    expect(reply.parts.map((p) => p.type)).toEqual(['tool', 'text']);
    const call = toolParts(reply.parts)[0]!;
    expect(call).toMatchObject({ name: 'read_file', status: 'done', target: 'README.md', permission: { decision: 'allow', source: 'automatic' } });
    expect(m.bodies[0]!.tools!.map((t) => t.function.name)).toContain('read_file');
    const second = m.bodies[1]!.messages;
    const assistantCall = second.find((x) => x.role === 'assistant' && x.tool_calls);
    expect(assistantCall).toBeTruthy();
    const toolMsg = second.find((x) => x.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe(call.id);
    expect(String(toolMsg.content)).toContain('Ligne deux');
    // Instructions système : mode et portée.
    expect(String(m.bodies[0]!.messages[0]!.content)).toContain('Mode Agent — Exécution');
  });

  it('refuse les écritures en mode Plan, au niveau du moteur', async () => {
    const m = await scripted([{ tool: 'write_file', args: { path: 'nouveau.txt', content: 'x' } }, { text: 'ok' }]);
    const { h, c, folder } = await setup(m.url, { agentMode: 'plan' });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'écris' } });
    await h.generation.idle();
    expect(m.bodies[0]!.tools!.map((t) => t.function.name)).not.toContain('write_file');
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call).toMatchObject({ status: 'denied', permission: { source: 'mode', decision: 'deny' } });
    expect(existsSync(join(folder, 'nouveau.txt'))).toBe(false);
  });

  it('enregistre une proposition en mode Proposition, puis l’applique ou détecte un conflit', async () => {
    const m = await scripted([{ tool: 'edit_file', args: { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' } }, { text: 'proposé' }]);
    const { h, c, folder } = await setup(m.url, { agentMode: 'propose' });
    autoRespond(h, 'allow');
    await h.call('chat.send', { conversationId: c.id, input: { text: 'change' } });
    await h.generation.idle();
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.status).toBe('proposed');
    expect(readFileSync(join(folder, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const [proposal] = await h.call('proposals.list', { conversationId: c.id });
    expect(proposal!.change).toMatchObject({ path: 'src/a.ts', before: 'export const a = 1;\n', after: 'export const a = 2;\n' });
    await h.call('proposals.apply', { id: proposal!.id });
    expect(readFileSync(join(folder, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    await expect(h.call('proposals.apply', { id: proposal!.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('demande l’autorisation : refus sans effet, accord appliqué, annulation jamais approuvée', async () => {
    const m = await scripted([{ tool: 'write_file', args: { path: 'out.txt', content: 'bonjour' } }, { text: 'fini' }]);
    const { h, c, folder } = await setup(m.url);
    const denied = autoRespond(h, 'deny');
    await h.call('chat.send', { conversationId: c.id, input: { text: 'écris' } });
    await h.generation.idle();
    expect(denied[0]!.preview).toMatchObject({ kind: 'changes', changes: [{ path: 'out.txt', status: 'created', after: 'bonjour' }] });
    let call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call).toMatchObject({ status: 'denied', permission: { decision: 'deny', source: 'user' } });
    expect(call.result).toMatch(/Refusé/);
    expect(existsSync(join(folder, 'out.txt'))).toBe(false);
    expect(String(m.bodies[1]!.messages.find((x) => x.role === 'tool')!.content)).toMatch(/Refusé/);

    const history = await h.call('permissions.history', { conversationId: c.id });
    expect(history[0]).toMatchObject({ tool: 'write_file', decision: 'deny', source: 'user' });
  });

  it('applique un accord persistant pour la conversation puis n’interroge plus', async () => {
    const m = await scripted([{ tool: 'write_file', args: { path: 'out.txt', content: 'v1' } }, { text: 'ok' }, { tool: 'write_file', args: { path: 'out.txt', content: 'v2' } }, { text: 'ok' }]);
    const { h, c, folder } = await setup(m.url);
    const seen = autoRespond(h, 'allow', 'conversation');
    await h.call('chat.send', { conversationId: c.id, input: { text: '1' } });
    await h.generation.idle();
    expect(readFileSync(join(folder, 'out.txt'), 'utf8')).toBe('v1');
    await h.call('chat.send', { conversationId: c.id, input: { text: '2' } });
    await h.generation.idle();
    expect(readFileSync(join(folder, 'out.txt'), 'utf8')).toBe('v2');
    expect(seen).toHaveLength(1);
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.permission).toMatchObject({ source: 'rule', scope: 'conversation' });
  });

  it('annule une demande d’autorisation en attente : refus, rien n’est écrit', async () => {
    const m = await scripted([{ tool: 'write_file', args: { path: 'out.txt', content: 'x' } }, { text: 'ok' }]);
    const { h, c, folder } = await setup(m.url);
    h.events.on('permission.requested', () => setTimeout(() => h.call('chat.cancel', { conversationId: c.id }), 5));
    await h.call('chat.send', { conversationId: c.id, input: { text: 'écris' } });
    await h.generation.idle();
    const reply = await lastAssistant(h, c.id);
    expect(reply.status).toBe('cancelled');
    expect(toolParts(reply.parts)[0]!.status).toBe('cancelled');
    expect(existsSync(join(folder, 'out.txt'))).toBe(false);
    expect(await h.call('permissions.pending')).toEqual([]);
  });

  it('exécute une commande avec code de retour, après règle d’autorisation', async () => {
    const m = await scripted([{ tool: 'run_command', args: { command: process.platform === 'win32' ? 'Write-Output "salut é"; exit 3' : 'echo "salut é"; exit 3' } }, { text: 'ok' }]);
    const { h, c } = await setup(m.url);
    await h.call('permissions.addRule', { scope: 'global', projectId: null, conversationId: null, tool: 'run_command', family: '*', resource: '', decision: 'allow' });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'lance' } });
    await h.generation.idle();
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.permission).toMatchObject({ source: 'rule', decision: 'allow' });
    expect(call.display).toMatchObject({ kind: 'command', exitCode: 3 });
    expect(call.result).toContain('salut é');
    expect(call.result).toContain('Code de sortie : 3');
  }, 30_000);

  it('patch multi-fichiers atomique : rien n’est écrit si une modification échoue', async () => {
    const m = await scripted([
      { tool: 'apply_patch', args: { changes: [{ path: 'src/b.ts', action: 'create', content: 'b' }, { path: 'src/a.ts', action: 'update', edits: [{ old_string: 'introuvable', new_string: 'x' }] }] } },
      { text: 'ok' },
    ]);
    const { h, c, folder } = await setup(m.url);
    await h.call('permissions.addRule', { scope: 'global', projectId: null, conversationId: null, tool: '*', family: 'edit', resource: '', decision: 'allow' });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'patch' } });
    await h.generation.idle();
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.status).toBe('error');
    expect(call.result).toMatch(/changes\[1\]/);
    expect(existsSync(join(folder, 'src', 'b.ts'))).toBe(false);
  });
});

describe('portée des ressources', () => {
  it('refuse la lecture hors des racines et des chemins protégés', async () => {
    const m = await scripted([{ tool: 'read_file', args: { path: '../secret.txt' } }, { text: 'ok' }]);
    const { h, c } = await setup(m.url);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'lis' } });
    await h.generation.idle();
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.status).toBe('error');
    expect(call.result).toMatch(/Hors de la portée/);
  });

  it('un fichier joint n’ouvre pas son dossier parent ; une conversation sans dossier a un espace privé', async () => {
    const m = await scripted([{ tool: 'list_files', args: {} }, { text: 'ok' }]);
    const { h, c, folder } = await setup(m.url, { withFolder: false });
    let info = await h.call('resources.get', { conversationId: c.id });
    expect(info.roots).toEqual([info.privateDir]);
    info = await h.call('resources.add', { conversationId: c.id, kind: 'file', path: join(folder, 'README.md') });
    expect(info.mode).toBe('custom');
    expect(info.files).toEqual([join(folder, 'README.md')]);
    expect(info.roots).toEqual([info.privateDir]);
    const scope = h.resources.scope(c.id).scope;
    expect(scope.resolve(join(folder, 'README.md'))).toContain('README.md');
    expect(() => scope.resolve(join(folder, 'src', 'a.ts'))).toThrow(/Hors de la portée/);
    info = await h.call('resources.reset', { conversationId: c.id });
    expect(info.mode).toBe('inherit');
  });

  it('un lien symbolique ne permet pas de sortir de la racine', async () => {
    const m = await scripted([{ text: 'ok' }]);
    const { h, c, folder } = await setup(m.url);
    const outside = mkdtempSync(join(tmpdir(), 'mh-out-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      symlinkSync(outside, join(folder, 'lien'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // création de lien non autorisée sur ce poste
    }
    const scope = h.resources.scope(c.id).scope;
    expect(() => scope.resolve('lien/secret.txt')).toThrow(/Hors de la portée/);
  });

  it('les données de l’application restent protégées même dans une racine', async () => {
    const m = await scripted([{ text: 'ok' }]);
    const { h, c, project, dir } = await setup(m.url);
    await h.call('projects.addFolder', { id: project.id, path: dir });
    const scope = h.resources.scope(c.id).scope;
    expect(() => scope.resolve(join(dir, 'monolith.sqlite'))).toThrow(/protégé/);
    expect(() => scope.resolve(join(dir, 'keys', 'master.json'))).toThrow(/protégé/);
  });
});

describe('règles d’autorisation', () => {
  it('un refus explicite l’emporte ; la règle la plus spécifique décide sinon', async () => {
    const { h, c, project } = await setup('http://127.0.0.1:9/v1');
    const q = (tool: string, resources: string[]) => h.permissions.evaluate({ conversationId: c.id, projectId: project.id, tool, family: 'edit', effects: ['write'], resources }, 'rules');
    expect(q('write_file', ['src/a.ts']).decision).toBe('ask');
    await h.call('permissions.addRule', { scope: 'global', projectId: null, conversationId: null, tool: '*', family: 'edit', resource: '', decision: 'allow' });
    expect(q('write_file', ['src/a.ts']).decision).toBe('allow');
    await h.call('permissions.addRule', { scope: 'project', projectId: project.id, conversationId: null, tool: 'write_file', family: '*', resource: 'secret/**', decision: 'deny' });
    expect(q('write_file', ['secret/x.txt'])).toMatchObject({ decision: 'deny', source: 'rule' });
    expect(q('write_file', ['src/a.ts']).decision).toBe('allow');
    await h.call('permissions.addRule', { scope: 'conversation', projectId: null, conversationId: c.id, tool: 'edit_file', family: '*', resource: 'src/**', decision: 'ask' });
    expect(q('edit_file', ['src/a.ts']).decision).toBe('ask');
    expect(h.permissions.evaluate({ conversationId: c.id, projectId: project.id, tool: 'read_file', family: 'sources', effects: ['read'], resources: [] }, 'deny_all').decision).toBe('deny');
    expect(globToRegExp('src/**/*.ts').test('src/x/y.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/y.ts')).toBe(false);
  });

  it('prévisualise et importe un permission.json', async () => {
    const { h, project } = await setup('http://127.0.0.1:9/v1');
    const json = JSON.stringify({ allow: ['read_file', 'run_command(npm test)'], deny: ['write_file(.env)'], rules: [{ tool: 'edit_file', resource: 'src/**', decision: 'ask' }] });
    const preview = await h.call('permissions.previewImport', { projectId: project.id, json });
    expect(preview.errors).toEqual([]);
    expect(preview.rules.map((r) => `${r.decision}:${r.tool}:${r.resource}`)).toEqual(['ask:edit_file:src/**', 'allow:read_file:', 'allow:run_command:npm test', 'deny:write_file:.env']);
    await h.call('permissions.import', { projectId: project.id, json });
    expect((await h.call('permissions.rules', { projectId: project.id })).length).toBe(4);
    const bad = await h.call('permissions.previewImport', { projectId: project.id, json: '{"allow": "x"}' });
    expect(bad.errors.length).toBeGreaterThan(0);
  });
});

describe('interactions', () => {
  it('pose des questions et transmet les réponses ; une annulation n’est pas une réponse', async () => {
    const m = await scripted([{ tool: 'ask_user', args: { questions: [{ prompt: 'Couleur ?', options: ['Bleu', 'Vert'] }, { prompt: 'Nom ?' }] } }, { text: 'merci' }]);
    const { h, c } = await setup(m.url, { mode: 'chat' });
    h.events.on('question.requested', (q) => {
      expect(q.questions.map((x) => x.kind)).toEqual(['single', 'text']);
      setTimeout(() => h.call('questions.answer', { conversationId: c.id, callId: q.callId, answers: [{ questionId: 'q1', optionIds: ['o2'], text: null }, { questionId: 'q2', optionIds: [], text: 'Alice' }] }), 5);
    });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'demande-moi' } });
    await h.generation.idle();
    const call = toolParts((await lastAssistant(h, c.id)).parts)[0]!;
    expect(call.result).toContain('→ Vert');
    expect(call.result).toContain('→ Alice');
    expect(call.display).toMatchObject({ kind: 'question', cancelled: false });
  });

  it('propose des actions déclenchables une seule fois', async () => {
    const m = await scripted([{ tool: 'propose_actions', args: { actions: [{ kind: 'new_chat', title: 'Approfondir', instructions: 'Explique en détail' }] } }, { text: 'Voici mes propositions.' }, { text: 'Réponse détaillée' }]);
    const { h, c } = await setup(m.url, { mode: 'chat' });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'idées ?' } });
    await h.generation.idle();
    const reply = await lastAssistant(h, c.id);
    const call = toolParts(reply.parts)[0]! as ToolCallRecord & { display: { kind: 'actions'; actions: { id: string }[] } };
    const actionId = call.display.actions[0]!.id;
    const r = await h.call('actions.trigger', { conversationId: c.id, messageId: reply.id, callId: call.id, actionId });
    expect(r.conversationId).not.toBe(c.id);
    await h.generation.idle();
    expect((await h.call('messages.list', { conversationId: r.conversationId }))[0]!.parts[0]).toEqual({ type: 'text', text: 'Explique en détail' });
    await expect(h.call('actions.trigger', { conversationId: c.id, messageId: reply.id, callId: call.id, actionId })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('détecte une boucle et arrête le travail sur décision de l’utilisateur', async () => {
    const m = await scripted([{ tool: 'list_files', args: { path: '.' } }]);
    const { h, c } = await setup(m.url);
    await h.call('settings.update', { loop: { threshold: 3 } });
    const reports: HarnessEvents['loop.detected'][] = [];
    h.events.on('loop.detected', (r) => {
      reports.push(r);
      setTimeout(() => h.call('loop.resolve', { conversationId: c.id, decision: 'stop' }), 5);
    });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'boucle' } });
    await h.generation.idle();
    expect(reports[0]!.calls[0]).toMatchObject({ name: 'list_files', count: 3 });
    const reply = await lastAssistant(h, c.id);
    expect(reply.status).toBe('cancelled');
    expect(toolParts(reply.parts).map((p) => p.status)).toEqual(['done', 'done', 'cancelled']);
  });

  it('inclut les fichiers d’instructions avec leur portée en mode Agent', async () => {
    const m = await scripted([{ text: 'ok' }]);
    const { h, c, folder } = await setup(m.url);
    writeFileSync(join(folder, 'AGENTS.md'), 'Toujours tester.');
    writeFileSync(join(folder, 'src', 'AGENTS.md'), 'Style fonctionnel.');
    await h.call('chat.send', { conversationId: c.id, input: { text: 'x' } });
    await h.generation.idle();
    const system = String(m.bodies[0]!.messages[0]!.content);
    expect(system).toContain('Toujours tester.');
    expect(system).toMatch(/portée : .*src et ses sous-dossiers uniquement/);
  });
});
