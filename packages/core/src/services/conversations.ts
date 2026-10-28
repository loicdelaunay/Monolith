import {
  HarnessError,
  type AttachmentRef,
  type AgentMode,
  type Conversation,
  type ConversationListQuery,
  type ConversationMode,
  type ConversationPatch,
  type Id,
  type ReasoningLevel,
  type SearchHit, type ConversationBudget } from '@monolith/contracts';
import { bool, json, type Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { now } from '../util.ts';

interface ConversationRow {
  id: number;
  project_id: number | null;
  title: string;
  title_source: string;
  favorite: number;
  pinned: number;
  archived: number;
  sort_order: number;
  goal: string;
  mode: string;
  agent_mode: string;
  provider_id: number | null;
  model: string | null;
  reasoning_level: string;
  draft: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  draft_attachments_json: string;
  forked_from_conversation_id: number | null;
  forked_from_message_id: number | null;
  parent_id: number | null;
  depth: number;
  role: string | null;
  budget_json: string | null;
  orchestration: number;
}

const REASONING: ReasoningLevel[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
const MAX_TITLE = 200;
const MAX_DRAFT = 2_000_000;

export class ConversationService {
  /** Fourni par le moteur de génération pour exposer l'état `generating`. */
  isGenerating: (id: Id) => boolean = () => false;

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  list(query: ConversationListQuery = {}): Conversation[] {
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (query.projectId === null) where.push('project_id IS NULL');
    else if (typeof query.projectId === 'number') {
      where.push('project_id = ?');
      params.push(query.projectId);
    }
    if (!query.includeArchived) where.push('archived = 0');
    // Les sous-agents ne figurent dans les listes qu'à la demande (affichés sous leur conversation parente).
    if (!query.includeSubagents) where.push('parent_id IS NULL');
    const sql = `SELECT * FROM conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, sort_order, id DESC`;
    return this.db.all<ConversationRow>(sql, ...params).map((r) => this.map(r));
  }

  get(id: Id): Conversation {
    const row = this.db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    if (!row) throw new HarnessError('not_found', `Conversation ${id} introuvable`);
    return this.map(row);
  }

  create(
    projectId: Id | null,
    title?: string,
    defaults?: { providerId: Id | null; model: string | null; reasoningLevel: ReasoningLevel; mode?: 'chat' | AgentMode },
    extra?: { forkedFrom?: { conversationId: Id; messageId: Id | null }; archived?: boolean; source?: Conversation; titleSource?: Conversation['titleSource']; parent?: { id: Id; depth: number; role: string; budget: ConversationBudget } },
  ): Conversation {
    if (projectId !== null && !this.db.get('SELECT 1 AS x FROM projects WHERE id = ?', projectId)) {
      throw new HarnessError('not_found', `Projet ${projectId} introuvable`);
    }
    const t = now();
    const min = this.db.get<{ m: number | null }>(
      'SELECT MIN(sort_order) AS m FROM conversations WHERE project_id IS ?',
      projectId,
    )?.m ?? 0;
    const cleanTitle = (title ?? '').trim().slice(0, MAX_TITLE);
    const src = extra?.source;
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO conversations (project_id, title, title_source, sort_order, provider_id, model, reasoning_level, goal, mode, agent_mode, archived, ' +
        'forked_from_conversation_id, forked_from_message_id, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      projectId,
      cleanTitle || 'Nouvelle conversation',
      extra?.titleSource ?? (cleanTitle ? 'user' : 'default'),
      min - 1,
      src ? src.providerId : (defaults?.providerId ?? null),
      src ? src.model : (defaults?.model ?? null),
      src ? src.reasoningLevel : (defaults?.reasoningLevel ?? 'auto'),
      src?.goal ?? '',
      src?.mode ?? (defaults?.mode && defaults.mode !== 'chat' ? 'agent' : 'chat'),
      src?.agentMode ?? (defaults?.mode && defaults.mode !== 'chat' ? defaults.mode : 'plan'),
      extra?.archived ? 1 : 0,
      extra?.forkedFrom?.conversationId ?? null,
      extra?.forkedFrom?.messageId ?? null,
      t,
      t,
      src ? t : null,
    );
    if (extra?.parent) this.db.run('UPDATE conversations SET parent_id = ?, depth = ?, role = ?, budget_json = ? WHERE id = ?', extra.parent.id, extra.parent.depth, extra.parent.role, JSON.stringify(extra.parent.budget), lastInsertRowid);
    return this.changed(lastInsertRowid);
  }

  /** Sous-agents d'une conversation, du plus récent au plus ancien. */
  children(parentId: Id): Conversation[] {
    return this.db.all<ConversationRow>('SELECT * FROM conversations WHERE parent_id = ? ORDER BY id DESC', parentId).map((r) => this.map(r));
  }

  update(id: Id, patch: ConversationPatch): Conversation {
    const c = this.get(id);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) {
      const title = String(patch.title).trim().slice(0, MAX_TITLE);
      if (!title) throw new HarnessError('invalid_argument', 'Le titre ne peut pas être vide');
      set('title', title);
      set('title_source', 'user');
    }
    if (patch.favorite !== undefined) set('favorite', patch.favorite ? 1 : 0);
    if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0);
    if (patch.archived !== undefined) set('archived', patch.archived ? 1 : 0);
    if (patch.goal !== undefined) set('goal', String(patch.goal).slice(0, 20_000));
    if (patch.orchestration !== undefined) set('orchestration', patch.orchestration ? 1 : 0);
    if (patch.mode !== undefined) {
      if (!(['chat', 'agent'] as ConversationMode[]).includes(patch.mode)) throw new HarnessError('invalid_argument', 'Mode inconnu');
      set('mode', patch.mode);
    }
    if (patch.agentMode !== undefined) {
      if (!(['plan', 'propose', 'execute'] as AgentMode[]).includes(patch.agentMode)) throw new HarnessError('invalid_argument', 'Mode agent inconnu');
      set('agent_mode', patch.agentMode);
    }
    if (patch.providerId !== undefined) {
      if (patch.providerId !== null && !this.db.get('SELECT 1 AS x FROM providers WHERE id = ?', patch.providerId)) {
        throw new HarnessError('not_found', 'Fournisseur introuvable');
      }
      set('provider_id', patch.providerId);
    }
    if (patch.model !== undefined) set('model', patch.model === null ? null : String(patch.model).slice(0, 300));
    if (patch.reasoningLevel !== undefined) {
      if (!REASONING.includes(patch.reasoningLevel)) throw new HarnessError('invalid_argument', 'Niveau de réflexion inconnu');
      set('reasoning_level', patch.reasoningLevel);
    }
    if (patch.projectId !== undefined && patch.projectId !== c.projectId) {
      if (patch.projectId !== null && !this.db.get('SELECT 1 AS x FROM projects WHERE id = ?', patch.projectId)) {
        throw new HarnessError('not_found', 'Projet introuvable');
      }
      set('project_id', patch.projectId);
    }
    if (sets.length === 0) return c;
    set('updated_at', now());
    this.db.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (patch.providerId !== undefined || patch.model !== undefined || patch.reasoningLevel !== undefined) this.rememberModel(id);
    return this.changed(id);
  }

  /** Dernier fournisseur / modèle / niveau de réflexion choisi ou utilisé (conversations de l'utilisateur). */
  rememberModel(id: Id): void {
    const c = this.get(id);
    if (c.depth > 0 || c.providerId === null || !c.model) return;
    const value = JSON.stringify({ providerId: c.providerId, model: c.model, reasoningLevel: c.reasoningLevel });
    this.db.run('INSERT INTO app_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at', 'lastModel', value, now());
  }

  lastModel(): { providerId: Id; model: string; reasoningLevel: ReasoningLevel } | null {
    const r = this.db.get<{ value_json: string }>("SELECT value_json FROM app_state WHERE key = 'lastModel'");
    if (!r) return null;
    try {
      const v = JSON.parse(r.value_json) as { providerId?: unknown; model?: unknown; reasoningLevel?: unknown };
      if (typeof v.providerId !== 'number' || typeof v.model !== 'string' || !REASONING.includes(v.reasoningLevel as ReasoningLevel)) return null;
      return { providerId: v.providerId, model: v.model, reasoningLevel: v.reasoningLevel as ReasoningLevel };
    } catch {
      return null;
    }
  }

  /** Titre automatique : ne remplace jamais un titre choisi par l'utilisateur. */
  setAutoTitle(id: Id, title: string, source: 'auto' | 'ai' = 'auto'): Conversation | null {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!clean) return null;
    const r = this.db.run("UPDATE conversations SET title = ?, title_source = ?, updated_at = ? WHERE id = ? AND title_source != 'user'", clean, source, now(), id);
    return r.changes ? this.changed(id) : null;
  }

  delete(id: Id): void {
    const c = this.get(id);
    this.db.run('DELETE FROM conversations WHERE id = ?', id);
    this.events.emit('conversation.deleted', { id, projectId: c.projectId });
  }

  reorder(projectId: Id | null, ids: Id[]): void {
    if (!Array.isArray(ids)) throw new HarnessError('invalid_argument', 'Liste d’identifiants attendue');
    this.db.transaction(() => {
      ids.forEach((cid, index) => this.db.run('UPDATE conversations SET sort_order = ? WHERE id = ? AND project_id IS ?', index + 1, cid, projectId));
    });
    this.events.emit('conversations.reordered', { projectId, ids });
  }

  saveDraft(id: Id, draft: string, attachments?: AttachmentRef[]): void {
    if (typeof draft !== 'string') throw new HarnessError('invalid_argument', 'Brouillon invalide');
    if (draft.length > MAX_DRAFT) throw new HarnessError('invalid_argument', 'Brouillon trop volumineux');
    // Pas d'événement : le brouillon appartient à l'éditeur qui l'envoie.
    if (attachments) this.db.run('UPDATE conversations SET draft = ?, draft_attachments_json = ? WHERE id = ?', draft, JSON.stringify(attachments), id);
    else this.db.run('UPDATE conversations SET draft = ? WHERE id = ?', draft, id);
  }

  /** Brouillon remplacé par le moteur (reprise d'un message) : l'interface est prévenue. */
  setDraft(id: Id, draft: string, attachments: AttachmentRef[]): Conversation {
    this.saveDraft(id, draft, attachments);
    return this.changed(id);
  }

  touch(id: Id): Conversation {
    const t = now();
    this.db.run('UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?', t, t, id);
    return this.changed(id);
  }

  search(query: string, limit = 30): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    const hits: SearchHit[] = this.db
      .all<{ id: number; project_id: number | null; title: string }>(
        "SELECT id, project_id, title FROM conversations WHERE title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
        like,
        limit,
      )
      .map((r) => ({ conversationId: r.id, projectId: r.project_id, title: r.title, snippet: '', messageId: null }));
    const fts = toFtsQuery(q);
    if (fts) {
      const seen = new Set(hits.map((h) => h.conversationId));
      const rows = this.db.all<{ id: number; conversation_id: number; project_id: number | null; title: string; snip: string }>(
        `SELECT m.id, m.conversation_id, c.project_id, c.title, snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
         FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
        fts,
        limit * 3,
      );
      for (const r of rows) {
        if (seen.has(r.conversation_id)) continue;
        seen.add(r.conversation_id);
        hits.push({ conversationId: r.conversation_id, projectId: r.project_id, title: r.title, snippet: r.snip, messageId: r.id });
        if (hits.length >= limit) break;
      }
    }
    return hits.slice(0, limit);
  }

  private changed(id: Id): Conversation {
    const c = this.get(id);
    this.events.emit('conversation.changed', { conversation: c });
    return c;
  }

  private map(r: ConversationRow): Conversation {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      titleSource: r.title_source as Conversation['titleSource'],
      favorite: bool(r.favorite),
      pinned: bool(r.pinned),
      archived: bool(r.archived),
      sortOrder: r.sort_order,
      goal: r.goal,
      mode: r.mode as ConversationMode,
      agentMode: r.agent_mode as AgentMode,
      providerId: r.provider_id,
      model: r.model,
      reasoningLevel: r.reasoning_level as ReasoningLevel,
      draft: r.draft,
      draftAttachments: json<AttachmentRef[]>(r.draft_attachments_json, []),
      forkedFrom: r.forked_from_conversation_id !== null ? { conversationId: r.forked_from_conversation_id, messageId: r.forked_from_message_id } : null,
      parentId: r.parent_id ?? null,
      depth: r.depth ?? 0,
      role: r.role ?? null,
      budget: r.budget_json ? json<ConversationBudget | null>(r.budget_json, null) : null,
      orchestration: !!r.orchestration,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessageAt: r.last_message_at,
      generating: this.isGenerating(r.id),
    };
  }
}

/** Transforme une saisie libre en requête FTS5 sûre (chaque mot entre guillemets, préfixe). */
export function toFtsQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  return tokens.map((t) => `"${t}"*`).join(' ');
}
