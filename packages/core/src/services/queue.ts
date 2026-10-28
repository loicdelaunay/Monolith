import { HarnessError, type AttachmentRef, type Id, type QueuedInput } from '@monolith/contracts';
import { json, type Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface QueueRow {
  id: number;
  conversation_id: number;
  kind: string;
  text: string;
  attachments_json: string;
  sort_order: number;
  created_at: string;
}

const map = (r: QueueRow): QueuedInput => ({
  id: r.id,
  conversationId: r.conversation_id,
  kind: r.kind === 'steer' ? 'steer' : 'queue',
  text: r.text,
  attachments: json<AttachmentRef[]>(r.attachments_json, []),
  sortOrder: r.sort_order,
  createdAt: r.created_at,
});

/**
 * File d'attente persistante par conversation. Les instructions `steer` sont consommées à la
 * prochaine frontière contrôlée de la génération en cours ; les éléments `queue` après elle.
 */
export class QueueService {
  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  list(conversationId: Id): QueuedInput[] {
    return this.db.all<QueueRow>("SELECT * FROM queued_inputs WHERE conversation_id = ? ORDER BY CASE kind WHEN 'steer' THEN 0 ELSE 1 END, sort_order, id", conversationId).map(map);
  }

  get(id: Id): QueuedInput {
    const r = this.db.get<QueueRow>('SELECT * FROM queued_inputs WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', 'Élément de file introuvable');
    return map(r);
  }

  add(conversationId: Id, kind: 'queue' | 'steer', text: string, attachments: AttachmentRef[]): QueuedInput {
    const max = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM queued_inputs WHERE conversation_id = ?', conversationId)?.m ?? 0;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO queued_inputs (conversation_id, kind, text, attachments_json, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      conversationId,
      kind,
      text,
      JSON.stringify(attachments),
      max + 1,
      now(),
    );
    this.changed(conversationId);
    return this.get(lastInsertRowid);
  }

  update(id: Id, text: string): QueuedInput {
    const item = this.get(id);
    if (typeof text !== 'string' || (!text.trim() && item.attachments.length === 0)) throw new HarnessError('invalid_argument', 'Texte vide');
    this.db.run('UPDATE queued_inputs SET text = ? WHERE id = ?', text, id);
    this.changed(item.conversationId);
    return this.get(id);
  }

  /** Type d'un élément : `steer` (orientation de la génération en cours) ou `queue` (envoi après elle). */
  setKind(id: Id, kind: 'queue' | 'steer'): QueuedInput {
    const item = this.get(id);
    if (item.kind === kind) return item;
    this.db.run('UPDATE queued_inputs SET kind = ? WHERE id = ?', kind, id);
    this.changed(item.conversationId);
    return this.get(id);
  }

  remove(id: Id): void {
    const item = this.get(id);
    this.db.run('DELETE FROM queued_inputs WHERE id = ?', id);
    this.changed(item.conversationId);
  }

  reorder(conversationId: Id, ids: Id[]): void {
    if (!Array.isArray(ids)) throw new HarnessError('invalid_argument', 'Liste attendue');
    this.db.transaction(() => ids.forEach((id, i) => this.db.run('UPDATE queued_inputs SET sort_order = ? WHERE id = ? AND conversation_id = ?', i + 1, id, conversationId)));
    this.changed(conversationId);
  }

  /** Frontière contrôlée : retire et retourne les instructions en attente, dans l'ordre. */
  takeSteers(conversationId: Id): QueuedInput[] {
    const items = this.list(conversationId).filter((i) => i.kind === 'steer');
    if (items.length === 0) return [];
    this.db.run("DELETE FROM queued_inputs WHERE conversation_id = ? AND kind = 'steer'", conversationId);
    this.changed(conversationId);
    return items;
  }

  /**
   * Fin de génération : les orientations non consommées deviennent des envois en file, à leur place
   * (génération interrompue) ou en tête de file (`front` : orientation arrivée après la dernière étape).
   */
  demoteSteers(conversationId: Id, front = false): void {
    const r = this.db.run(`UPDATE queued_inputs SET kind = 'queue'${front ? ', sort_order = sort_order - 1000000' : ''} WHERE conversation_id = ? AND kind = 'steer'`, conversationId);
    if (r.changes) this.changed(conversationId);
  }

  peekNext(conversationId: Id): QueuedInput | null {
    return this.list(conversationId).find((i) => i.kind === 'queue') ?? null;
  }

  private changed(conversationId: Id): void {
    this.events.emit('queue.changed', { conversationId, items: this.list(conversationId) });
  }
}
