import type { Compaction, Id } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface CompactionRow {
  id: number;
  conversation_id: number;
  up_to_seq: number;
  summary: string;
  model: string;
  estimated_tokens_before: number | null;
  trigger: string;
  created_at: string;
}

const map = (r: CompactionRow): Compaction => ({
  id: r.id,
  conversationId: r.conversation_id,
  upToSeq: r.up_to_seq,
  summary: r.summary,
  model: r.model,
  estimatedTokensBefore: r.estimated_tokens_before,
  trigger: r.trigger === 'auto' ? 'auto' : 'manual',
  createdAt: r.created_at,
});

/** Résumés de compactage. Les messages résumés restent intacts dans l'historique. */
export class CompactionService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  list(conversationId: Id): Compaction[] {
    return this.db.all<CompactionRow>('SELECT * FROM compactions WHERE conversation_id = ? ORDER BY up_to_seq', conversationId).map(map);
  }

  latest(conversationId: Id): Compaction | null {
    const r = this.db.get<CompactionRow>('SELECT * FROM compactions WHERE conversation_id = ? ORDER BY up_to_seq DESC, id DESC LIMIT 1', conversationId);
    return r ? map(r) : null;
  }

  add(input: Omit<Compaction, 'id' | 'createdAt'>): Compaction {
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO compactions (conversation_id, up_to_seq, summary, model, estimated_tokens_before, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.conversationId,
      input.upToSeq,
      input.summary,
      input.model,
      input.estimatedTokensBefore,
      input.trigger,
      now(),
    );
    const c = map(this.db.get<CompactionRow>('SELECT * FROM compactions WHERE id = ?', lastInsertRowid)!);
    this.events.emit('compaction.added', { compaction: c });
    return c;
  }

  copyTo(sourceId: Id, targetId: Id, upToSeq: number | null): void {
    this.db.run(
      'INSERT INTO compactions (conversation_id, up_to_seq, summary, model, estimated_tokens_before, trigger, created_at) SELECT ?, up_to_seq, summary, model, estimated_tokens_before, trigger, created_at FROM compactions WHERE conversation_id = ? AND (? IS NULL OR up_to_seq <= ?)',
      targetId,
      sourceId,
      upToSeq,
      upToSeq,
    );
  }

  /** Reprise : un résumé couvrant des messages retirés n'est plus valide. */
  deleteFrom(conversationId: Id, seq: number): void {
    this.db.run('DELETE FROM compactions WHERE conversation_id = ? AND up_to_seq >= ?', conversationId, seq);
  }
}
