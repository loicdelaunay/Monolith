import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { MessagePart, PermissionPolicy, PermissionRequest } from '@monolith/contracts';
import { mockProvider, sseChunk, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { model: string; messages: { role: string; content: unknown }[] };
type Verdict = (actionId: string) => string;

const done = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;

/**
 * Faux fournisseur : le modèle « agent » écrit un fichier par tour (puis termine) ; le modèle
 * « juge » répond au validateur avec le verdict fourni (l'identifiant d'action est relu dans la requête).
 */
async function setup(policy: PermissionPolicy, verdict: Verdict | null, writes = 1) {
  const validatorBodies: Body[] = [];
  let turn = 0;
  const mock = await mockProvider((_req, raw, res: ServerResponse) => {
    const body = JSON.parse(raw || '{}') as Body;
    if (body.model === 'juge') {
      validatorBodies.push(body);
      const id = /action_id: (\w+)/.exec(String(body.messages.at(-1)?.content))?.[1] ?? '';
      return writeFragmented(res, sseChunk({ content: verdict!(id) }) + done, 64);
    }
    turn++;
    return writeFragmented(res, turn <= writes ? toolCall('write_file', { path: `f${turn}.txt`, content: 'x' }, `call_${turn}`) : sseChunk({ content: 'fin' }) + done, 64);
  });
  cleanups.push(mock.close);
  const t = tempHarness();
  cleanups.push(t.cleanup);
  const h = t.harness;
  const folder = mkdtempSync(join(tmpdir(), 'mh-pol-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const project = await h.call('projects.create', { name: 'P' });
  await h.call('projects.addFolder', { id: project.id, path: folder });
  const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
  const caps = { reasoningLevels: [], reasoningSource: 'unknown' as const, rejectedLevels: [], vision: null, tools: null };
  await h.call('providers.setModels', { id: p.id, models: ['m', 'juge'].map((id) => ({ id, label: id, enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual' as const, capabilities: caps })) });
  await h.call('settings.update', {
    chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false },
    permissions: { policy, validatorProviderId: verdict ? p.id : null, validatorModel: verdict ? 'juge' : null },
  });
  const c = await h.call('conversations.create', { projectId: project.id });
  await h.call('conversations.update', { id: c.id, patch: { mode: 'agent', agentMode: 'execute' } });
  const requests: PermissionRequest[] = [];
  h.events.on('permission.requested', (r) => {
    requests.push(r);
    setTimeout(() => void h.call('permissions.respond', { requestId: r.requestId, decision: 'allow', scope: 'once' }), 5);
  });
  const run = async () => {
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Écris les fichiers' } });
    await h.generation.idle();
    const msg = (await h.call('messages.list', { conversationId: c.id })).filter((m) => m.role === 'assistant').at(-1)!;
    return msg.parts.filter((x): x is Extract<MessagePart, { type: 'tool' }> => x.type === 'tool').map((x) => x.call);
  };
  return { h, folder, project, requests, validatorBodies, run };
}

const json = (risk: string, reason = 'raison') => (id: string) => JSON.stringify({ action_id: id, risk, reason });

describe('politiques Autoriser tout et Automatique', () => {
  it('Autoriser tout : écriture sans demande ; une règle Refuser l’emporte toujours', async () => {
    const s = await setup('allow_all', null, 2);
    await s.h.call('permissions.addRule', { scope: 'global', projectId: null, conversationId: null, tool: 'write_file', family: '*', resource: '*f2.txt', decision: 'deny' });
    const [first, second] = await s.run();
    expect(s.requests).toHaveLength(0);
    expect(first).toMatchObject({ status: 'done', permission: { decision: 'allow', source: 'policy', reason: expect.stringContaining('Autoriser tout') } });
    expect(second).toMatchObject({ status: 'denied', permission: { decision: 'deny', source: 'rule' } });
    expect([existsSync(join(s.folder, 'f1.txt')), existsSync(join(s.folder, 'f2.txt'))]).toEqual([true, false]);
  });

  it('Automatique : risque faible accepté par le validateur, sans demande, consommation enregistrée', async () => {
    const s = await setup('auto', json('low', 'écriture locale dans le projet'));
    const [call] = await s.run();
    expect(s.requests).toHaveLength(0);
    expect(call).toMatchObject({ status: 'done', permission: { decision: 'allow', source: 'validator', reason: expect.stringContaining('risque faible — écriture locale dans le projet') } });
    // Le validateur reçoit l'action comme donnée non fiable, sans outils.
    const prompt = String(s.validatorBodies[0]!.messages.at(-1)!.content);
    expect(prompt).toContain('Tool: write_file');
    expect(prompt).toContain('"path":"f1.txt"');
    expect((s.validatorBodies[0] as unknown as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
    const usage = await s.h.call('usage.list', {});
    expect(usage.some((u) => u.kind === 'validation' && u.model === 'juge')).toBe(true);
  });

  it('Automatique : risque élevé, réponse non liée à l’action ou illisible → votre accord est demandé', async () => {
    for (const [verdict, expected] of [
      [json('high', 'suppression'), 'risque élevé — suppression'],
      [() => JSON.stringify({ action_id: 'autre', risk: 'low', reason: 'x' }), 'non conforme'],
      [() => 'Je pense que ça va.', 'illisible'],
    ] as const) {
      const s = await setup('auto', verdict);
      const [call] = await s.run();
      expect(s.requests).toHaveLength(1);
      expect(s.requests[0]!.reason).toContain(expected);
      expect(call).toMatchObject({ status: 'done', permission: { decision: 'allow', source: 'user' } });
    }
  });

  it('Automatique : sans validateur, tout est demandé ; un accord enregistré ne dispense pas de l’analyse ; les lectures restent automatiques', async () => {
    const none = await setup('auto', null);
    await none.run();
    expect(none.requests.map((r) => r.reason)).toEqual([expect.stringContaining('aucun validateur configuré')]);

    const s = await setup('auto', json('medium'));
    await s.h.call('permissions.addRule', { scope: 'global', projectId: null, conversationId: null, tool: 'write_file', family: '*', resource: '', decision: 'allow' });
    await s.run();
    expect(s.validatorBodies).toHaveLength(1);
    expect(s.requests).toHaveLength(1);

    const read = s.h.permissions.evaluate({ conversationId: 1, projectId: null, tool: 'read_file', family: 'sources', effects: ['read'], resources: [] }, 'auto');
    expect(read).toMatchObject({ decision: 'allow', source: 'automatic' });
    const ask = s.h.permissions.evaluate({ conversationId: 1, projectId: null, tool: 'run_command', family: 'terminal', effects: ['exec'], resources: [] }, 'auto');
    expect(ask.decision).toBe('validate');
  });

  it('politique inconnue refusée par les réglages', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    await t.harness.call('settings.update', { permissions: { policy: 'yolo' as PermissionPolicy } });
    expect(t.harness.settings.get().permissions.policy).toBe('rules');
    await t.harness.call('settings.update', { permissions: { policy: 'allow_all' } });
    expect(t.harness.settings.get().permissions.policy).toBe('allow_all');
  });
});
