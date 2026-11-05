import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDraftDelta } from '@monolith/contracts';
import { isDraftTool, parsePartialJson, ToolDrafts } from '../src/generation/tool-drafts.ts';
import { mockProvider, sseChunk, tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('JSON incomplet', () => {
  const full = JSON.stringify({ count: 3, ok: true, nested: { a: [1, 'x'] }, path: 'src/é.ts', content: 'ligne "1"\n\ttab \\ 😀 é\nfin', tail: null });
  const value = JSON.parse(full) as { path: string; content: string };

  it('ne casse sur aucune coupure et ne montre jamais autre chose que le début du texte', () => {
    for (let n = 0; n <= full.length; n++) {
      const partial = parsePartialJson(full.slice(0, n)) as { path?: string; content?: string } | null;
      const content = partial?.content ?? '';
      // Une paire de surrogates coupée en deux reste valide : comparaison en unités de code.
      expect(value.content.startsWith(content)).toBe(true);
      expect(value.path.startsWith(partial?.path ?? '')).toBe(true);
    }
    expect(parsePartialJson(full)).toEqual(expect.objectContaining({ path: value.path, content: value.content, count: null, ok: null }));
  });

  it('échappements \\uXXXX, clés hostiles et entrée sans objet', () => {
    expect(parsePartialJson('{"a":"\\u00e9\\ud83d\\ude00')).toEqual(expect.objectContaining({ a: 'é😀' }));
    expect(parsePartialJson('{"a":"x\\u00')).toEqual(expect.objectContaining({ a: 'x' }));
    expect(parsePartialJson('{"a":"x\\')).toEqual(expect.objectContaining({ a: 'x' }));
    expect(({} as { hack?: boolean }).hack).toBeUndefined();
    parsePartialJson('{"__proto__":{"hack":true}}');
    expect(({} as { hack?: boolean }).hack).toBeUndefined();
    expect(parsePartialJson('')).toBeNull();
    expect(parsePartialJson('pas du json')).toBeNull();
  });
});

describe('aperçu par outil', () => {
  const take = (name: string, raw: string) => {
    const d = new ToolDrafts();
    d.update(0, name, raw);
    return d.take();
  };

  it('fichier, passage modifié et lot de fichiers', () => {
    expect(take('write_file', '{"path":"a.ts","content":"const a')).toEqual([{ index: 0, name: 'write_file', path: 'a.ts', offset: 0, append: 'const a' }]);
    expect(take('edit_file', '{"path":"a.ts","old_string":"avant","new_string":"apr')).toEqual([{ index: 0, name: 'edit_file', path: 'a.ts', offset: 0, append: 'apr' }]);
    const patch = take('apply_patch', '{"changes":[{"path":"a.ts","action":"create","content":"un"},{"path":"b.ts","action":"update","edits":[{"old_string":"x","new_string":"deux"}]}]}');
    expect(patch).toMatchObject([{ path: 'b.ts', append: '--- a.ts\nun\n\n--- b.ts\ndeux' }]);
  });

  it('autres outils ignorés', () => {
    expect(isDraftTool('run_command')).toBe(false);
    expect(take('run_command', '{"command":"ls"}')).toEqual([]);
  });

  it('seule la suite du texte est transmise ; un début modifié repart du premier écart', () => {
    const d = new ToolDrafts();
    d.update(0, 'write_file', '{"path":"a","content":"abc');
    expect(d.take()[0]).toMatchObject({ offset: 0, append: 'abc' });
    expect(d.take()).toEqual([]);
    d.update(0, 'write_file', '{"path":"a","content":"abcdef');
    expect(d.take()[0]).toMatchObject({ offset: 3, append: 'def' });
    d.update(0, 'write_file', '{"content":"abX');
    expect(d.take()[0]).toMatchObject({ path: null, offset: 2, append: 'X' });
    expect(d.clear()).toBe(true);
    expect(d.clear()).toBe(false);
  });
});

describe('fichier suivi pendant son écriture', () => {
  const finish = (reason: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Premier tour : `fragments` en morceaux séparés dans le temps ; tours suivants : texte simple. */
  async function setup(name: string, fragments: string[], opts: { failAfter?: boolean } = {}) {
    let turn = 0;
    const mock = await mockProvider(async (_req, _raw, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (turn++ > 0) {
        res.end(sseChunk({ content: 'fini' }) + finish('stop'));
        return;
      }
      res.write(sseChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }));
      for (const f of fragments) {
        res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: f } }] }));
        await pause(130);
      }
      if (opts.failAfter) {
        res.destroy();
        return;
      }
      res.end(finish('tool_calls'));
    });
    cleanups.push(mock.close);
    const folder = mkdtempSync(join(tmpdir(), 'mh-draft-'));
    cleanups.push(() => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }));
    const t = tempHarness(undefined, { host: 'desktop' });
    cleanups.push(t.cleanup);
    const h = t.harness;
    const project = await h.call('projects.create', { name: 'P' });
    await h.call('projects.addFolder', { id: project.id, path: folder });
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false }, network: { retryMaxAttempts: 1 } });
    const c = await h.call('conversations.create', { projectId: project.id });
    await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
    h.events.on('permission.requested', (r) => setTimeout(() => void h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5));
    const drafts: (ToolDraftDelta[] | null)[] = [];
    h.events.on('tool.draft', (e) => drafts.push(e.drafts));
    return { h, c, folder, drafts };
  }
  const rebuilt = (drafts: (ToolDraftDelta[] | null)[]) => {
    let text = '';
    for (const list of drafts) for (const d of list ?? []) text = text.slice(0, d.offset) + d.append;
    return text;
  };

  it('le contenu arrive par morceaux, puis l’outil s’exécute normalement sans trace de l’aperçu', async () => {
    const { h, c, folder, drafts } = await setup('write_file', ['{"path":"nou', 'veau.txt","content":"ligne 1\\n', 'ligne 2\\n', 'ligne 3"}']);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'écris' } });
    await h.generation.idle();
    expect(drafts.length).toBeGreaterThanOrEqual(3);
    expect(drafts.at(-1)).toBeNull();
    expect(drafts.filter((d) => d).length).toBeGreaterThanOrEqual(2);
    expect(drafts.find((d) => d)![0]).toMatchObject({ name: 'write_file', index: 0 });
    expect(drafts.flatMap((d) => d ?? []).at(-1)!.path).toBe('nouveau.txt');
    expect(rebuilt(drafts)).toBe('ligne 1\nligne 2\nligne 3');
    expect(readFileSync(join(folder, 'nouveau.txt'), 'utf8')).toBe('ligne 1\nligne 2\nligne 3');
    const messages = await h.call('messages.list', { conversationId: c.id });
    const parts = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === 'tool').map((p) => (p as { call: { name: string; status: string } }).call)).toMatchObject([{ name: 'write_file', status: 'done' }]);
  });

  it('flux coupé pendant l’écriture : aperçu retiré, rien n’est écrit', async () => {
    const { h, c, folder, drafts } = await setup('write_file', ['{"path":"coupe.txt","content":"debut', ' du fichier'], { failAfter: true });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'écris' } });
    await h.generation.idle();
    expect(drafts.flatMap((d) => d ?? []).length).toBeGreaterThan(0);
    expect(drafts.at(-1)).toBeNull();
    expect(existsSync(join(folder, 'coupe.txt'))).toBe(false);
    const messages = await h.call('messages.list', { conversationId: c.id });
    expect(messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts).filter((p) => p.type === 'tool')).toEqual([]);
  });

  it('autres outils : aucun aperçu', async () => {
    const { h, c, drafts } = await setup('list_files', ['{"pa', 'th":"."}']);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'liste' } });
    await h.generation.idle();
    expect(drafts).toEqual([]);
  });
});
