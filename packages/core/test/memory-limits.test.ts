import { afterEach, describe, expect, it } from 'vitest';
import { tempHarness } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function setup() {
  const t = tempHarness();
  cleanups.push(t.cleanup);
  return t.harness;
}

describe('mémoire : expiration et nombre maximum', () => {
  it('expiration : date future obligatoire, mémoire supprimée une fois la date passée', async () => {
    const h = setup();
    await expect(h.call('memory.save', { scope: 'global', title: 'Passé', content: 'x', expiresAt: '2000-01-01' })).rejects.toThrow(/futur/);
    await expect(h.call('memory.save', { scope: 'global', title: 'Invalide', content: 'x', expiresAt: 'demain' })).rejects.toThrow(/invalide/);
    const m = await h.call('memory.save', { scope: 'global', title: 'Réunion', content: 'Point projet jeudi', expiresAt: '2999-12-31' });
    expect(m.expiresAt).toMatch(/^2999-12-31|^3000-01-01/);
    const permanent = await h.call('memory.save', { scope: 'global', title: 'Préférence', content: 'Réponses courtes' });
    expect(permanent.expiresAt).toBeNull();
    // Mise à jour sans date : l'échéance est conservée.
    expect((await h.call('memory.save', { id: m.id, scope: 'global', title: 'Réunion', content: 'Point projet vendredi' })).expiresAt).toBe(m.expiresAt);
    // La date passe : la mémoire disparaît des listes et du contexte du modèle.
    h.db.run('UPDATE memories SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), m.id);
    expect((await h.call('memory.list', {})).items.map((x) => x.title)).toEqual(['Préférence']);
    expect(h.memory.visible(1, null, null, 10).map((x) => x.title)).toEqual(['Préférence']);
  });

  it('nombre maximum : retire les plus anciennes mémoires de l’agent, jamais celles de l’utilisateur', async () => {
    const h = setup();
    await h.call('settings.update', { memory: { maxItems: 3 } });
    await h.call('memory.save', { scope: 'global', title: 'À moi', content: 'garder' });
    h.memory.save({ scope: 'global', title: 'Agent 1', content: 'a' }, { source: 'agent' });
    h.memory.save({ scope: 'global', title: 'Agent 2', content: 'b' }, { source: 'agent' });
    h.memory.save({ scope: 'global', title: 'Agent 3', content: 'c' }, { source: 'agent' });
    const titles = (await h.call('memory.list', { sort: 'title', order: 'asc' })).items.map((x) => x.title);
    expect(titles).toEqual(['Agent 2', 'Agent 3', 'À moi']);
    // Uniquement des mémoires de l'utilisateur : l'ajout est refusé, rien n'est supprimé.
    await h.call('settings.update', { memory: { maxItems: 1 } });
    await h.call('memory.delete', { id: (await h.call('memory.list', { query: 'Agent' })).items[0]!.id });
    await h.call('memory.delete', { id: (await h.call('memory.list', { query: 'Agent' })).items[0]!.id });
    await expect(h.call('memory.save', { scope: 'global', title: 'Encore', content: 'non' })).rejects.toThrow(/Limite de 1 mémoires/);
    expect((await h.call('memory.list', {})).total).toBe(1);
    // 0 : illimité.
    await h.call('settings.update', { memory: { maxItems: 0 } });
    await h.call('memory.save', { scope: 'global', title: 'Encore', content: 'oui' });
    expect((await h.call('memory.list', {})).total).toBe(2);
  });
});
