/** Codes d'erreur stables, traduits par les interfaces (clé i18n `error.<code>`). */
export type HarnessErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'conflict'
  | 'busy'
  | 'unavailable'
  | 'permission_denied'
  | 'secret_unavailable'
  | 'secret_unreadable'
  | 'provider_unreachable'
  | 'provider_auth'
  | 'provider_rate_limit'
  | 'provider_bad_request'
  | 'provider_server'
  | 'provider_timeout'
  | 'provider_refusal'
  | 'provider_no_model'
  | 'provider_stream'
  | 'cancelled'
  | 'storage'
  | 'internal';

export interface SerializedHarnessError {
  name: 'HarnessError';
  code: HarnessErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class HarnessError extends Error {
  override readonly name = 'HarnessError';
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON(): SerializedHarnessError {
    return { name: 'HarnessError', code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }

  static is(value: unknown): value is HarnessError {
    return value instanceof HarnessError;
  }

  static fromSerialized(value: unknown): HarnessError {
    if (value && typeof value === 'object' && (value as SerializedHarnessError).name === 'HarnessError') {
      const v = value as SerializedHarnessError;
      return new HarnessError(v.code, v.message, v.details);
    }
    return new HarnessError('internal', value instanceof Error ? value.message : String(value));
  }
}

export function serializeError(error: unknown): SerializedHarnessError {
  if (error instanceof HarnessError) return error.toJSON();
  return { name: 'HarnessError', code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
