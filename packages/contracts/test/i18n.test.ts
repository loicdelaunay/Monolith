import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { messages, translate } from '../src/index.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(vue|ts|tsx)$/.test(f) ? [p] : [];
  });
}

function has(locale: 'fr' | 'en', key: string): boolean {
  let node: unknown = messages[locale];
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  return typeof node === 'string' || (typeof node === 'object' && node !== null);
}

describe('i18n', () => {
  it('toutes les clés statiques utilisées par le desktop et le CLI existent en français et en anglais', () => {
    const root = join(import.meta.dirname, '../../..');
    const sources = [...files(join(root, 'apps/desktop/src/renderer/src')), ...files(join(root, 'apps/cli/src'))];
    const missing: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt[em]?\(\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) {
        for (const locale of ['fr', 'en'] as const) if (!has(locale, m[1]!)) missing.push(`${locale}:${m[1]} (${file.slice(root.length)})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('interpole les paramètres', () => {
    expect(translate('fr', 'chat.attempts', { count: 3 })).toBe('3 tentative(s)');
    expect(translate('en', 'chat.attempts', { count: 3 })).toBe('3 attempt(s)');
    expect(translate('en', 'clé.inexistante')).toBe('clé.inexistante');
  });
});
