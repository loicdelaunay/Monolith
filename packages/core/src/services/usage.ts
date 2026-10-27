import type { Id, UsageRecord } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import { now } from '../util.ts';

export type UsageStart = Pick<UsageRecord, 'kind' | 'conversationId' | 'projectId' | 'providerId' | 'providerName' | 'model'>;
export type UsageEnd = Pick<UsageRecord, 'firstTokenMs' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens' | 'estimated' | 'status'>;

/**
 * Registre de consommation : une ligne par appel IA, quel qu'en soit le motif (chat, nommage,
 * mémoire, vision, sous-agent, benchmark, test). Une ligne sans fin reste `incomplete`.
 */
export class UsageService {
  constructor(private readonly db: Database) {}

  start(input: UsageStart): Id {
    return this.db.run(
      `INSERT INTO usage (kind, conversation_id, project_id, provider_id, provider_name, model, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete')`,
      input.kind,
      input.conversationId,
      input.projectId,
      input.providerId,
      input.providerName,
      input.model,
      now(),
    ).lastInsertRowid;
  }

  finish(id: Id, end: UsageEnd): void {
    this.db.run(
      'UPDATE usage SET finished_at = ?, first_token_ms = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, reasoning_tokens = ?, estimated = ?, status = ? WHERE id = ?',
      now(),
      end.firstTokenMs === null ? null : Math.round(end.firstTokenMs),
      end.inputTokens,
      end.outputTokens,
      end.cachedInputTokens,
      end.reasoningTokens,
      end.estimated ? 1 : 0,
      end.status,
      id,
    );
  }
}
