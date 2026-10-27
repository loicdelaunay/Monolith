import { fr } from './fr.ts';
import { en } from './en.ts';

export type Locale = 'fr' | 'en';
export type Messages = typeof fr;
export const messages: Record<Locale, Messages> = { fr, en };

/** Langue effective : réglage explicite, sinon langue système si prise en charge, sinon anglais. */
export function resolveLocale(setting: 'system' | Locale, systemLocale: string | undefined): Locale {
  if (setting === 'fr' || setting === 'en') return setting;
  return (systemLocale ?? '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** Traduction simple (CLI, moteur) : clés pointées, paramètres `{nom}`. */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  let node: unknown = messages[locale];
  for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== 'string') {
    if (locale !== 'fr') return translate('fr', key, params);
    return key;
  }
  return params ? node.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : node;
}
