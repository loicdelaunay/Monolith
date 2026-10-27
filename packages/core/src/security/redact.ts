/**
 * Expurgeur central : tout texte écrit dans les logs, diagnostics ou exports passe ici.
 * Il masque les secrets connus du moteur (valeurs exactes déchiffrées pendant la session)
 * et les formes courantes de jetons.
 */
const knownSecrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value && value.length >= 6) knownSecrets.add(value);
}

export function forgetSecret(value: string): void {
  knownSecrets.delete(value);
}

const PATTERNS: [RegExp, string][] = [
  [/([?&](?:key|api_key|apikey|token|access_token|sig|signature)=)[^&\s"']+/gi, '$1[masqué]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [masqué]'],
  [/\b(sk|pk|rk|gsk|xai|nvapi|sk-or-v1|sk-ant|hf)[-_][A-Za-z0-9._-]{12,}/g, '[clé masquée]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[clé masquée]'],
  [/\bya29\.[0-9A-Za-z._-]{20,}/g, '[jeton masqué]'],
  [/("(?:api[_-]?key|apikey|authorization|x-api-key|x-goog-api-key|token|password|secret)"\s*:\s*")[^"]*(")/gi, '$1[masqué]$2'],
];

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[secret masqué]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(api[_-]?key|authorization|password|secret|token|x-api-key)$/i.test(k) ? '[masqué]' : redactValue(v);
    }
    return out;
  }
  return value;
}
