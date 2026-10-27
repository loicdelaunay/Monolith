import type { Message } from '@monolith/contracts';

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} k`;
  return String(n);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Débit de sortie (tokens/s) mesuré après le premier élément reçu. */
export function throughput(m: Message): number | null {
  if (!m.usage?.outputTokens || !m.durationMs) return null;
  const window = m.durationMs - (m.firstTokenMs ?? 0);
  if (window < 200) return null;
  return m.usage.outputTokens / (window / 1000);
}

export function relativeDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (diff < 60) return rtf.format(-Math.round(diff), 'second');
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86_400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 7 * 86_400) return rtf.format(-Math.round(diff / 86_400), 'day');
  return d.toLocaleDateString(locale);
}

/** Retire les séquences de contrôle ANSI (couleurs, curseur) d'une sortie de terminal. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '');
}
