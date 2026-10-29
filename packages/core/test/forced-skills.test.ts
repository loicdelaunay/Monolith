import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockProvider, standardStream, tempHarness, writeFragmented } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Body = { messages: { role: string; content: unknown }[] };

describe('/skill-<nom> : skill imposé dans la conversation', () => {
  it('instructions complètes jointes à chaque requête de la conversation, retirables', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    const skillDir = join(t.harness.layout.skills, 'style-maison');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: style-maison\ndescription: Rédaction au style maison\n---\nToujours conclure par « Bonne journée ».\n');
    const bodies: Body[] = [];
    const mock = await mockProvider((_req, raw, res: ServerResponse) => {
      bodies.push(JSON.parse(raw || '{}') as Body);
      void writeFragmented(res, standardStream('ok'), 13);
    });
    cleanups.push(mock.close);
    const h = t.harness;
    const p = await h.call('providers.create', { name: 'Mock', kind: 'openai-compatible', preset: 'custom', baseUrl: mock.url });
    await h.call('providers.setModels', { id: p.id, models: [{ id: 'm', label: 'm', enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } }] });
    await h.call('settings.update', { chat: { defaultProviderId: p.id, defaultModel: 'm', autoNaming: false, defaultMode: 'chat' } });
    const c = await h.call('conversations.create', { projectId: null });
    expect((await h.call('skills.custom', {})).map((k) => k.name)).toContain('style-maison');

    expect((await h.call('conversations.update', { id: c.id, patch: { forcedSkills: ['style-maison', 'style-maison', 'inconnu'] } })).forcedSkills).toEqual(['style-maison', 'inconnu']);
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Écris un mail' } });
    await h.generation.idle();
    const system = String(bodies[0]!.messages[0]!.content);
    expect(system).toContain('Skill « style-maison » imposé par l’utilisateur');
    expect(system).toContain('Toujours conclure par « Bonne journée ».');
    expect(system).toContain('Skill « inconnu » imposé par l’utilisateur mais introuvable');

    await h.call('conversations.update', { id: c.id, patch: { forcedSkills: [] } });
    await h.call('chat.send', { conversationId: c.id, input: { text: 'Encore' } });
    await h.generation.idle();
    expect(String(bodies.at(-1)!.messages[0]!.content)).not.toContain('Bonne journée');
  });
});
