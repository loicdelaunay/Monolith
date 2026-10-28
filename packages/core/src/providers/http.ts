import { HarnessError, type HarnessErrorCode } from '@monolith/contracts';
import type { Logger } from '../log/logger.ts';
import { completeCertificateChain, describeTlsError, isMissingIssuer, tlsErrorCode } from '../net/certificates.ts';
import { redact } from '../security/redact.ts';

/** Erreur HTTP/transport d'un fournisseur, classée pour la politique de retry. */
export class ProviderError extends HarnessError {
  constructor(
    code: HarnessErrorCode,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly body: string = '',
  ) {
    super(code, message, { status, retryable });
  }
}

/** Détecte le cas ciblé « 400 : JSON de la requête tronqué par une passerelle ». */
export function isTruncatedJson400(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /unexpected end of (json|input|data)|unterminated (string|json)|eof while parsing|json[^.\n]{0,40}(truncat|incomplete|premature)|(truncat|incomplete)[^.\n]{0,40}json|failed to parse (the )?(request )?(body|json)[^.\n]{0,40}(eof|end)/i.test(
    body,
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return Math.min(120_000, Math.max(0, sec * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(120_000, Math.max(0, date - Date.now())) : null;
}

function extractMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string; detail?: string };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? j.detail);
    if (m) return String(m);
  } catch {
    /* corps non JSON */
  }
  return body.slice(0, 500);
}

export function classifyHttpError(status: number, body: string, retryAfter: string | null): ProviderError {
  const msg = redact(extractMessage(body)) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError('provider_auth', msg, status, false, null, body);
  if (status === 404) {
    const noModel = /model/i.test(msg);
    return new ProviderError(noModel ? 'provider_no_model' : 'provider_bad_request', msg, status, false, null, body);
  }
  if (status === 408) return new ProviderError('provider_timeout', msg, status, true, parseRetryAfter(retryAfter), body);
  if (status === 429) return new ProviderError('provider_rate_limit', msg, status, true, parseRetryAfter(retryAfter), body);
  if (status >= 500) return new ProviderError('provider_server', msg, status, true, parseRetryAfter(retryAfter), body);
  if (status === 400 && isTruncatedJson400(status, body)) return new ProviderError('provider_bad_request', msg, status, true, null, body);
  return new ProviderError('provider_bad_request', msg, status, false, null, body);
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Corps `application/x-www-form-urlencoded` (échanges de jetons OAuth). */
  form?: Record<string, string>;
  signal: AbortSignal;
  /** Délai jusqu'aux en-têtes de réponse. */
  connectTimeoutMs: number;
}

/**
 * Client HTTP unique des fournisseurs : chaque appel est journalisé (catégorie `network`)
 * avec la méthode, l'hôte, le chemin, le statut et la durée — jamais les en-têtes ni le corps.
 */
export class HttpClient {
  constructor(private readonly logger: Logger) {}

  async request(url: string, options: RequestOptions): Promise<Response> {
    const started = performance.now();
    const target = safeTarget(url);
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(new ProviderError('provider_timeout', `Aucune réponse après ${Math.round(options.connectTimeoutMs / 1000)} s`, null, true)), options.connectTimeoutMs);
    const signal = AbortSignal.any([options.signal, connect.signal]);
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : options.form ? { body: new URLSearchParams(options.form).toString() } : {}),
      signal,
    };
    let response: Response;
    try {
      try {
        response = await fetch(url, init);
      } catch (error) {
        // Serveur sans ses certificats intermédiaires : chaîne complétée comme le ferait un navigateur, puis une seule nouvelle tentative.
        if (signal.aborted || !isMissingIssuer(tlsErrorCode(error)) || !(await completeCertificateChain(url, signal))) throw error;
        this.logger.info('network', 'Chaîne de certificats complétée (intermédiaire téléchargé)', target);
        response = await fetch(url, init);
      }
    } catch (error) {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      if (options.signal.aborted) {
        this.logger.info('network', 'Requête annulée', { ...target, ms });
        throw new HarnessError('cancelled', 'Requête annulée');
      }
      if (connect.signal.aborted) {
        this.logger.warn('network', 'Délai de connexion dépassé', { ...target, ms });
        throw connect.signal.reason as ProviderError;
      }
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error as Error).message;
      this.logger.warn('network', 'Fournisseur injoignable', { ...target, ms, detail });
      const tlsCode = tlsErrorCode(error);
      const explained = tlsCode ? describeTlsError(tlsCode) : null;
      // Une erreur de certificat ne se corrige pas en réessayant.
      if (explained) throw new ProviderError('provider_unreachable', `Fournisseur injoignable : ${explained}`, null, false);
      throw new ProviderError('provider_unreachable', `Fournisseur injoignable (${detail})`, null, true);
    }
    clearTimeout(timer);
    this.logger.info('network', 'Réponse', { ...target, status: response.status, ms: Math.round(performance.now() - started) });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw classifyHttpError(response.status, body, response.headers.get('retry-after'));
    }
    return response;
  }

  async json<T>(url: string, options: RequestOptions): Promise<T> {
    const r = await this.request(url, options);
    const text = await r.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError('provider_stream', 'Réponse JSON invalide du fournisseur', r.status, false);
    }
  }
}

function safeTarget(url: string): { method?: string; host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: '?', path: '?' };
  }
}

/**
 * Itère sur le corps d'une réponse avec un délai d'inactivité entre deux fragments.
 */
export async function* readBody(response: Response, idleTimeoutMs: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new HarnessError('cancelled', 'Génération annulée'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('provider_timeout', `Flux inactif depuis ${Math.round(idleTimeoutMs / 1000)} s`, null, true)), idleTimeoutMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle, aborted]);
        if (done) return;
        if (value) yield value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}
