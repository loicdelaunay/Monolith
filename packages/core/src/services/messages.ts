import {
  HarnessError,
  type GenerationSnapshot,
  type Id,
  type Message,
  type MessageError,
  type MessagePart,
  type MessageRole,
  type MessageStatus,
  type MessageUsage,
} from '@monolith/contracts';
import { json, type Database } from '../storage/database.ts';
import { now } from '../util.ts';

interface MessageRow {
  id: number;
  conversation_id: number;
  seq: number;
  role: string;
  status: string;
  parts_json: string;
  snapshot_json: string | null;
  usage_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  first_token_ms: number | null;
}

/** Texte indexé pour la recherche : réponses et texte utilisateur, sans la réflexion. */
export function searchableText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export class MessageService {
  constructor(private readonly db: Database) {}

  list(conversationId: Id): Message[] {
    return this.db.all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId).map(map);
  }

  get(id: Id): Message {
    const row = this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw new HarnessError('not_found', `Message ${id} introuvable`);
    return map(row);
  }

  create(input: {
    conversationId: Id;
    role: MessageRole;
    status: MessageStatus;
    parts: MessagePart[];
    snapshot?: GenerationSnapshot | null;
  }): Message {
    const seq = (this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM messages WHERE conversation_id = ?', input.conversationId)?.m ?? 0) + 1;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO messages (conversation_id, seq, role, status, parts_json, text, snapshot_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      input.conversationId,
      seq,
      input.role,
      input.status,
      JSON.stringify(input.parts),
      searchableText(input.parts),
      input.snapshot ? JSON.stringify(input.snapshot) : null,
      now(),
      input.status === 'streaming' ? null : now(),
    );
    return this.get(lastInsertRowid);
  }

  /** Persistance intermédiaire pendant le streaming (sans mise à jour de l'index plein texte). */
  saveParts(id: Id, parts: MessagePart[]): void {
    this.db.run('UPDATE messages SET parts_json = ? WHERE id = ?', JSON.stringify(parts), id);
  }

  finish(
    id: Id,
    result: { status: MessageStatus; parts: MessagePart[]; usage: MessageUsage | null; error: MessageError | null; durationMs: number; firstTokenMs: number | null },
  ): Message {
    this.db.run(
      'UPDATE messages SET status = ?, parts_json = ?, text = ?, usage_json = ?, error_json = ?, completed_at = ?, duration_ms = ?, first_token_ms = ? WHERE id = ?',
      result.status,
      JSON.stringify(result.parts),
      searchableText(result.parts),
      result.usage ? JSON.stringify(result.usage) : null,
      result.error ? JSON.stringify(result.error) : null,
      now(),
      Math.round(result.durationMs),
      result.firstTokenMs === null ? null : Math.round(result.firstTokenMs),
      id,
    );
    return this.get(id);
  }

  /**
   * Au démarrage : un message resté en `streaming` appartient à une génération interrompue
   * (fermeture, plantage). Il est marqué `interrupted`, son contenu partiel est conservé.
   */
  recoverInterrupted(): number {
    return this.db.run(
      "UPDATE messages SET status = 'interrupted', completed_at = ?, error_json = ? WHERE status = 'streaming'",
      now(),
      JSON.stringify({ code: 'interrupted', message: 'Génération interrompue par la fermeture de l’application.' } satisfies MessageError),
    ).changes;
  }
}

function map(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: r.seq,
    role: r.role as MessageRole,
    status: r.status as MessageStatus,
    parts: json<MessagePart[]>(r.parts_json, []),
    snapshot: json<GenerationSnapshot | null>(r.snapshot_json, null),
    usage: json<MessageUsage | null>(r.usage_json, null),
    error: json<MessageError | null>(r.error_json, null),
    createdAt: r.created_at,
    completedAt: r.completed_at,
    durationMs: r.duration_ms,
    firstTokenMs: r.first_token_ms,
  };
}
