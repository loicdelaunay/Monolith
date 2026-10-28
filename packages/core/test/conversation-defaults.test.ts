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
});
