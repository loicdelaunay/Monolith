import { describe, expect, it } from 'vitest';
import { comboFromEvent, nextMode, nextReasoning, sanitizeShortcuts, shortcutPatch } from '../src/shortcuts.ts';

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, code?: string) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('raccourcis', () => {
  it('normalise les combinaisons d’après la touche physique', () => {
    expect(comboFromEvent(ev('M', { ctrlKey: true, shiftKey: true }, 'KeyM'))).toBe('Ctrl+Shift+M');
    expect(comboFromEvent(ev('&', { altKey: true }, 'Digit1'))).toBe('Alt+1');
    expect(comboFromEvent(ev('Shift', { shiftKey: true }))).toBeNull();
    expect(comboFromEvent(ev('F5'))).toBe('F5');
  });

  it('valide, déduplique et refuse les combinaisons réservées ou sans modificateur', () => {
    const items = sanitizeShortcuts([
      { keys: 'Alt+1', label: 'Rapide', providerId: 3, model: 'm', mode: 'agent', agentMode: 'plan', reasoningLevel: 'low' },
      { keys: 'Alt+1', label: 'doublon' },
      { keys: 'K', label: 'sans modificateur' },
      { keys: 'Ctrl+Shift+M', label: 'réservé' },
      { keys: 'Ctrl+Alt+P', reasoningLevel: 'nimporte' },
    ]);
    expect(items.map((i) => i.keys)).toEqual(['Alt+1', 'Ctrl+Alt+P']);
    expect(items[1]!.reasoningLevel).toBeNull();
    expect(shortcutPatch(items[0]!)).toEqual({ providerId: 3, model: 'm', mode: 'agent', agentMode: 'plan', reasoningLevel: 'low' });
  });

  it('fait tourner les modes et les niveaux de réflexion', () => {
    expect(nextMode('chat', 'execute')).toEqual({ mode: 'agent', agentMode: 'plan' });
    expect(nextMode('agent', 'execute')).toEqual({ mode: 'chat' });
    expect(nextReasoning('auto', ['low', 'high'])).toBe('low');
    expect(nextReasoning('high', ['low', 'high'])).toBe('auto');
    expect(nextReasoning('auto', [])).toBe('auto');
  });
});
