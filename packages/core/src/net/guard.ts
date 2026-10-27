import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HarnessError } from '@monolith/contracts';

/** Adresse privée, locale, de lien local ou réservée (IPv4 / IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
  }
  return false;
}

/**
 * Protection contre l'accès réseau privé non autorisé (SSRF) pour les accès initiés par le modèle :
 * schéma http(s) uniquement, et toutes les adresses résolues doivent être publiques.
 */
export async function assertPublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HarnessError('invalid_argument', `URL invalide : ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HarnessError('permission_denied', `Schéma non autorisé : ${url.protocol}`);
  if (url.username || url.password) throw new HarnessError('permission_denied', 'Identifiants dans l’URL refusés');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HarnessError('permission_denied', `Adresse locale refusée pour un accès initié par le modèle : ${host}`);
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new HarnessError('provider_unreachable', `Nom d’hôte introuvable : ${host}`);
  });
  const blocked = addresses.find((a) => isPrivateAddress(a.address));
  if (blocked) throw new HarnessError('permission_denied', `Adresse réseau privée refusée (${host} → ${blocked.address}). Ouvrez-la vous-même dans le navigateur si nécessaire.`);
  return url;
}
