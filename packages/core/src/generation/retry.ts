import { HarnessError } from '@monolith/contracts';
import { ProviderError, isTruncatedJson400 } from '../providers/http.ts';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  retryTruncatedJson400: boolean;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

/**
 * Décide d'une nouvelle tentative. Ne retente QUE les erreurs transitoires
 * (réseau, délai, 408, 429, 5xx, fragment d'erreur en flux) et le cas ciblé du 400
 * « JSON tronqué par une passerelle ». Toute autre erreur 400 n'est jamais retentée.
 *
 * `outputStarted` : si du contenu a déjà été reçu, aucune tentative n'est faite ici ;
 * la reprise d'une réponse interrompue relève d'une logique distincte (aucune double exécution).
 */
export function decideRetry(error: unknown, attempt: number, policy: RetryPolicy, outputStarted: boolean): RetryDecision {
  const no = (reason: string): RetryDecision => ({ retry: false, delayMs: 0, reason });
  if (attempt >= policy.maxAttempts) return no('max_attempts');
  if (outputStarted) return no('output_started');
  if (!(error instanceof HarnessError)) return no('unknown_error');
  if (error.code === 'cancelled') return no('cancelled');
  if (!(error instanceof ProviderError)) return no('not_provider_error');
  if (error.status === 400) {
    if (!policy.retryTruncatedJson400 || !isTruncatedJson400(400, error.body)) return no('bad_request');
    return { retry: true, delayMs: backoff(attempt, policy.baseDelayMs), reason: 'truncated_json_400' };
  }
  if (!error.retryable) return no('not_retryable');
  const delay = error.retryAfterMs ?? backoff(attempt, policy.baseDelayMs);
  return { retry: true, delayMs: delay, reason: error.code };
}

/** Attente exponentielle avec gigue : base · 2^(n-1) · [0,75 ; 1,25], plafonnée à 30 s. */
export function backoff(attempt: number, baseMs: number, random: () => number = Math.random): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(30_000, Math.round(exp * (0.75 + random() * 0.5)));
}
