import { afterEach, describe, expect, it } from 'vitest';
import { tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('mode des nouvelles conversations', () => {
  it('Agent · Proposition par défaut, réglable (Chat ou autre mode Agent), valeur inconnue ignorée', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    const h = t.harness;
    expect(await h.call('conversations.create', { projectId: null })).toMatchObject({ mode: 'agent', agentMode: 'propose' });
    await h.call('settings.update', { chat: { defaultMode: 'chat' } });
    expect((await h.call('conversations.create', { projectId: null })).mode).toBe('chat');
    await h.call('settings.update', { chat: { defaultMode: 'execute' } });
    expect(await h.call('conversations.create', { projectId: null })).toMatchObject({ mode: 'agent', agentMode: 'execute' });
    await h.call('settings.update', { chat: { defaultMode: 'turbo' as never } });
    expect((await h.call('settings.get')).chat.defaultMode).toBe('execute');
  });

  it('nouvelle conversation : dernier fournisseur / modèle / réflexion utilisé, sinon modèle par défaut', async () => {
    const t = tempHarness();
    cleanups.push(t.cleanup);
    const h = t.harness;
    const caps = { reasoningLevels: ['low', 'high'] as never, reasoningSource: 'unknown' as const, rejectedLevels: [], vision: null, tools: null };
    const model = (id: string, enabled = true) => ({ id, label: id, enabled, contextWindow: null, maxOutputTokens: null, source: 'manual' as const, capabilities: caps });
    const a = await h.call('providers.create', { name: 'A', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1' });
    const b = await h.call('providers.create', { name: 'B', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1' });
    await h.call('providers.setModels', { id: a.id, models: [model('a1')] });
    await h.call('providers.setModels', { id: b.id, models: [model('b1'), model('b2')] });
    await h.call('settings.update', { chat: { defaultProviderId: a.id, defaultModel: 'a1' } });
    // Rien d'utilisé encore : modèle par défaut.
    const first = await h.call('conversations.create', { projectId: null });
    expect(first).toMatchObject({ providerId: a.id, model: 'a1' });
    // Choix dans le sélecteur : repris par la conversation suivante, réflexion comprise.
    await h.call('conversations.update', { id: first.id, patch: { providerId: b.id, model: 'b2', reasoningLevel: 'high' } });
    expect(await h.call('conversations.create', { projectId: null })).toMatchObject({ providerId: b.id, model: 'b2', reasoningLevel: 'high' });
    // Réglage désactivé : modèle par défaut.
    await h.call('settings.update', { chat: { rememberLastModel: false } });
    expect(await h.call('conversations.create', { projectId: null })).toMatchObject({ providerId: a.id, model: 'a1' });
    // Modèle désactivé depuis : retour au modèle par défaut.
    await h.call('settings.update', { chat: { rememberLastModel: true } });
    await h.call('providers.setModels', { id: b.id, models: [model('b1'), model('b2', false)] });
    expect(await h.call('conversations.create', { projectId: null })).toMatchObject({ providerId: a.id, model: 'a1' });
  });
});
