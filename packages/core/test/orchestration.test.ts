import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { MessagePart, SubagentItem } from '@monolith/contracts';
import { mockProvider, sseChunk, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
const toolStream = (name: string, args: Record<string, unknown>, id: string) =>
  sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
const tools = (parts: MessagePart[]) => parts.filter((p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool').map((p) => p.call);

/** Faux modèle : le parent et les sous-agents (reconnus à leurs instructions) ont chacun leur scénario. */
async function setup(handler: (body: Body, kind: 'parent' | 'child', res: ServerResponse) => void | Promise<void>, opts: { git?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'mh-t7-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'README.md'), '# Projet\n');
  if (opts.git) {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: folder, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  }
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const bodies: { kind: 'parent' | 'child'; body: Body }[] = [];
  const mock = await mockProvider((_req, raw, res) => {
    const body = JSON.parse(raw || '{}') as Body;
    const kind = String(body.messages[0]?.content).includes('Tu es un sous-agent') ? 'child' : 'parent';
    bodies.push({ kind, body });
    return handler(body, kind, res);
  });
  cleanups.push(mock.close);
  const h = t.harness;
  const project = await h.call('projects.create', { name: 'P' });
  await h.call('projects.addFolder', { id: project.id, path: folder });
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
  await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false }, permissions: { policy: 'rules' } });
  const c = await h.call('conversations.create', { projectId: project.id });
  await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
  h.events.on('permission.requested', (r) => setTimeout(() => h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5));
  return { h, folder, conversationId: c.id, bodies };
}

async function lastAssistant(h: Awaited<ReturnType<typeof setup>>['h'], conversationId: number) {
  return (await h.call('messages.list', { conversationId })).filter((m) => m.role === 'assistant').at(-1)!;
}

describe('sous-agents', () => {
  it('délégation parallèle, mode borné par le parent, profondeur, rapports', async () => {
    let parentCalls = 0;
    const { h, conversationId, bodies } = await setup((body, kind, res) => {
      if (kind === 'child') {
        const task = String(body.messages.at(-1)?.content);
        return writeFragmented(res, standardStream(`Rapport : ${task.includes('Lister') ? 'liste faite' : 'code écrit'}`));
      }
      parentCalls++;
      if (parentCalls === 1) return writeFragmented(res, toolStream('delegate_tasks', { tasks: [{ title: 'Lister', instructions: 'Lister les fichiers', preset: 'explorer' }, { title: 'Coder', instructions: 'Écrire le code', preset: 'implementer' }] }, 'd1'));
      return writeFragmented(res, standardStream('Synthèse des deux rapports.'));
    });
    await h.call('chat.send', { conversationId, input: { text: 'Fais le travail en parallèle' } });
    await h.generation.idle();
    const msg = await lastAssistant(h, conversationId);
    const call = tools(msg.parts)[0]!;
    expect(call).toMatchObject({ name: 'delegate_tasks', status: 'done' });
    const items = (call.display as { kind: 'subagents'; items: SubagentItem[] }).items;
    expect(items.map((i) => [i.title, i.role, i.status])).toEqual([['Lister', 'Explorateur', 'done'], ['Coder', 'Implémenteur', 'done']]);
    expect(items[0]!.summary).toContain('liste faite');
    expect(call.result).toContain('code écrit');
    const children = await h.call('subagents.list', { conversationId });
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentId === conversationId && c.depth === 1)).toBe(true);
    expect(children.find((c) => c.title.includes('Lister'))!.agentMode).toBe('plan');
    expect(children.find((c) => c.title.includes('Coder'))!.agentMode).toBe('execute');
    // Les sous-agents ne figurent pas dans la liste ; profondeur 1 : pas de délégation pour eux.
    expect((await h.call('conversations.list', {})).some((c) => c.parentId !== null)).toBe(false);
    expect(bodies.filter((b) => b.kind === 'child').every((b) => !b.body.tools?.some((t) => t.function.name === 'delegate_tasks'))).toBe(true);
    expect(msg.parts.at(-1)).toMatchObject({ type: 'text', text: 'Synthèse des deux rapports.' });
  });

  it('budget de tours épuisé et annulation propagée', async () => {
    let parentCalls = 0;
    const { h, conversationId } = await setup((body, kind, res) => {
      if (kind === 'child') {
        const task = String(body.messages.find((m) => m.role === 'user')?.content);
        if (task.includes('Lent')) return writeFragmented(res, standardStream('mot '.repeat(400)), 4, 15);
        return writeFragmented(res, toolStream('list_files', {}, `c${Math.random()}`));
      }
      parentCalls++;
      if (parentCalls === 1) return writeFragmented(res, toolStream('delegate_tasks', { tasks: [{ title: 'Boucle', instructions: 'Explore sans fin' }] }, 'd1'));
      if (parentCalls === 2) return writeFragmented(res, standardStream('Suite.'));
      if (parentCalls === 3) return writeFragmented(res, toolStream('delegate_tasks', { tasks: [{ title: 'Lent', instructions: 'Lent' }] }, 'd2'));
      return writeFragmented(res, standardStream('Fin.'));
    });
    await h.call('settings.update', { subagents: { maxRounds: 2 } });
    await h.call('chat.send', { conversationId, input: { text: 'Délègue' } });
    await h.generation.idle();
    let items = (tools((await lastAssistant(h, conversationId)).parts)[0]!.display as { items: SubagentItem[] }).items;
    expect(items[0]!.status).toBe('budget');

    await h.call('chat.send', { conversationId, input: { text: 'Délègue lentement' } });
    await new Promise((r) => setTimeout(r, 700));
    h.generation.cancel(conversationId);
    await h.generation.idle();
    items = (tools((await lastAssistant(h, conversationId)).parts)[0]!.display as { items: SubagentItem[] }).items;
    expect(items[0]!.status).toBe('cancelled');
    expect(h.generation.isActive(items[0]!.conversationId)).toBe(false);
  });

  it('worktree Git dédié par sous-agent', async () => {
    let parentCalls = 0;
    const { h, conversationId, folder } = await setup((body, kind, res) => {
      if (kind === 'child') {
        if (!body.messages.some((m) => m.role === 'tool')) return writeFragmented(res, toolStream('write_file', { path: 'nouveau.txt', content: 'dans le worktree' }, 'w1'));
        return writeFragmented(res, standardStream('Fichier créé.'));
      }
      parentCalls++;
      if (parentCalls === 1) return writeFragmented(res, toolStream('delegate_tasks', { tasks: [{ title: 'Isolé', instructions: 'Crée nouveau.txt', preset: 'implementer', worktree: true }] }, 'd1'));
      return writeFragmented(res, standardStream('ok'));
    }, { git: true });
    await h.call('chat.send', { conversationId, input: { text: 'Travail isolé' } });
    await h.generation.idle();
    const item = (tools((await lastAssistant(h, conversationId)).parts)[0]!.display as { items: SubagentItem[] }).items[0]!;
    expect(item.status).toBe('done');
    expect(item.worktree!.branch).toMatch(/^monolith\/sub-\d+-isol/);
    expect(readFileSync(join(item.worktree!.path, 'nouveau.txt'), 'utf8')).toBe('dans le worktree');
    expect(existsSync(join(folder, 'nouveau.txt'))).toBe(false);
    expect(item.summary).toContain('1 fichier(s) modifié(s)');
    await h.call('subagents.removeWorktree', { conversationId: item.conversationId });
    expect(existsSync(item.worktree!.path)).toBe(false);
  });
});

describe('sandbox', () => {
  it('copie, diff, application sélective, conflit, abandon', async () => {
    let n = 0;
    const { h, conversationId, folder } = await setup((body, _kind, res) => {
      n++;
      if (n === 1) return writeFragmented(res, toolStream('write_file', { path: 'README.md', content: '# Modifié en sandbox\n' }, 'w1'));
      if (n === 2) return writeFragmented(res, toolStream('write_file', { path: 'neuf.txt', content: 'nouveau' }, 'w2'));
      return writeFragmented(res, standardStream('ok'));
    });
    writeFileSync(join(folder, 'autre.txt'), 'original');
    const st = await h.call('sandbox.enable', { conversationId });
    expect(st.enabled).toBe(true);
    const copy = st.roots[0]!.copy;
    expect((await h.call('resources.get', { conversationId })).roots).toEqual([copy]);
    await h.call('chat.send', { conversationId, input: { text: 'Modifie' } });
    await h.generation.idle();
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# Projet\n');
    writeFileSync(join(copy, 'autre.txt'), 'changé en sandbox');
    const diff = await h.call('sandbox.diff', { conversationId });
    expect(diff.map((d) => [d.path, d.status])).toEqual([['autre.txt', 'modified'], ['neuf.txt', 'created'], ['README.md', 'modified']].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(diff.find((d) => d.path === 'README.md')).toMatchObject({ before: '# Projet\n', after: '# Modifié en sandbox\n', conflict: false });
    // L'original de autre.txt change pendant ce temps : conflit, refusé sans confirmation.
    writeFileSync(join(folder, 'autre.txt'), 'changé dehors');
    const r = await h.call('sandbox.apply', { conversationId, files: [{ root: 0, path: 'README.md' }, { root: 0, path: 'autre.txt' }] });
    expect(r).toEqual({ applied: 1, conflicts: ['autre.txt'] });
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# Modifié en sandbox\n');
    expect(readFileSync(join(folder, 'autre.txt'), 'utf8')).toBe('changé dehors');
    expect((await h.call('sandbox.diff', { conversationId })).map((d) => d.path)).toEqual(['autre.txt', 'neuf.txt']);
    const after = await h.call('sandbox.discard', { conversationId });
    expect(after.enabled).toBe(false);
    expect(existsSync(copy)).toBe(false);
    expect((await h.call('resources.get', { conversationId })).mode).toBe('inherit');
    expect(existsSync(join(folder, 'neuf.txt'))).toBe(false);
  });
});
