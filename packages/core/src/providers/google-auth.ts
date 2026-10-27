import { createHash, createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HarnessError } from '@monolith/contracts';
import type { HttpClient } from './http.ts';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface ServiceAccount {
  type: 'service_account';
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

interface AuthorizedUser {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

type Credentials = ServiceAccount | AuthorizedUser;

/** Valide un JSON de compte de service et le renvoie compacté (stockage chiffré dans le champ Clé). */
export function parseServiceAccount(raw: string): string {
  let j: Partial<ServiceAccount>;
  try {
    j = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    throw new HarnessError('invalid_argument', 'JSON de compte de service illisible');
  }
  if (j.type !== 'service_account' || typeof j.client_email !== 'string' || typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY')) {
    throw new HarnessError('invalid_argument', 'Ce fichier n’est pas un compte de service Google (type, client_email et private_key attendus)');
  }
  checkTokenUri(j.token_uri);
  return JSON.stringify({ type: j.type, client_email: j.client_email, private_key: j.private_key, project_id: j.project_id, token_uri: j.token_uri });
}

function checkTokenUri(uri: string | undefined): void {
  if (uri === undefined) return;
  // Le jeton n'est envoyé qu'à Google (ou à un serveur local de test), jamais à une adresse arbitraire du fichier.
  if (!/^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//.test(uri) && !/^http:\/\/127\.0\.0\.1:\d+\//.test(uri)) {
    throw new HarnessError('invalid_argument', `token_uri non autorisé : ${uri}`);
  }
}

/** Emplacements des identifiants par défaut de l'application (ADC), dans l'ordre de gcloud. */
export function adcPath(): string | null {
  const env = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (env) return env;
  const file = process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json') : join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  return existsSync(file) ? file : null;
}

function loadAdc(): Credentials {
  const path = adcPath();
  if (!path) {
    throw new HarnessError('provider_auth', 'Aucun identifiant par défaut (ADC) : exécutez « gcloud auth application-default login » ou définissez GOOGLE_APPLICATION_CREDENTIALS.');
  }
  let j: { type?: string };
  try {
    j = JSON.parse(readFileSync(path, 'utf8')) as { type?: string };
  } catch {
    throw new HarnessError('provider_auth', `Identifiants ADC illisibles : ${path}`);
  }
  if (j.type === 'service_account') return JSON.parse(parseServiceAccount(JSON.stringify(j))) as ServiceAccount;
  if (j.type === 'authorized_user') return j as AuthorizedUser;
  throw new HarnessError('unavailable', `Type d’identifiants ADC non pris en charge : ${j.type ?? 'inconnu'} (comptes de service et connexions gcloud uniquement).`);
}

/**
 * Jetons d'accès Google pour Vertex AI : compte de service (JWT signé localement) ou
 * connexion utilisateur gcloud (jeton de rafraîchissement). Mis en cache jusqu'à expiration.
 */
export class GoogleAuth {
  private readonly cache = new Map<string, { token: string; expires: number }>();

  constructor(private readonly http: HttpClient) {}

  /** Projet par défaut indiqué par les identifiants (compte de service ou projet de quota). */
  defaultProject(mode: 'adc' | 'service_account', secret: string | null): string | null {
    try {
      const c = mode === 'adc' ? loadAdc() : (JSON.parse(secret ?? '{}') as Credentials);
      return c.type === 'service_account' ? (c.project_id ?? null) : (c.quota_project_id ?? null);
    } catch {
      return null;
    }
  }

  async token(mode: 'adc' | 'service_account', secret: string | null, signal: AbortSignal): Promise<string> {
    let creds: Credentials;
    if (mode === 'adc') creds = loadAdc();
    else {
      if (!secret) throw new HarnessError('provider_auth', 'Aucun compte de service enregistré : collez le JSON du compte dans le champ Clé.');
      creds = JSON.parse(parseServiceAccount(secret)) as ServiceAccount;
    }
    const key = createHash('sha256').update(JSON.stringify(creds)).digest('hex');
    const hit = this.cache.get(key);
    if (hit && hit.expires - 60_000 > Date.now()) return hit.token;
    const r = creds.type === 'service_account' ? await this.serviceAccountToken(creds, signal) : await this.refreshToken(creds, signal);
    this.cache.set(key, { token: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 });
    return r.access_token;
  }

  private async serviceAccountToken(sa: ServiceAccount, signal: AbortSignal) {
    const tokenUri = sa.token_uri ?? DEFAULT_TOKEN_URI;
    checkTokenUri(tokenUri);
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    } catch {
      throw new HarnessError('provider_auth', 'Clé privée du compte de service invalide');
    }
    return this.http.json<{ access_token: string; expires_in?: number }>(tokenUri, {
      method: 'POST',
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` },
      signal,
      connectTimeoutMs: 30_000,
    });
  }

  private async refreshToken(u: AuthorizedUser, signal: AbortSignal) {
    return this.http.json<{ access_token: string; expires_in?: number }>(DEFAULT_TOKEN_URI, {
      method: 'POST',
      form: { grant_type: 'refresh_token', client_id: u.client_id, client_secret: u.client_secret, refresh_token: u.refresh_token },
      signal,
      connectTimeoutMs: 30_000,
    });
  }
}
