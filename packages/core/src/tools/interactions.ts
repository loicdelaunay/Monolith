import { HarnessError, type FileChange, type FileProposal, type Id, type LoopReport, type Question, type QuestionAnswer, type Settings } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import { json } from '../storage/database.ts';
import { applyChanges, currentContent } from './files.ts';
import { now } from '../util.ts';

/** Questions interactives en attente de réponse (une annulation n'est jamais une réponse). */
export class QuestionBroker {
  private readonly pending = new Map<string, { conversationId: Id; resolve: (a: QuestionAnswer[] | null) => void }>();

  constructor(private readonly events: EventBus) {}

  ask(conversationId: Id, messageId: Id, callId: string, questions: Question[], signal: AbortSignal): Promise<QuestionAnswer[] | null> {
    return new Promise((resolve) => {
      const key = `${conversationId}:${callId}`;
      const onAbort = () => finish(null);
      const finish = (a: QuestionAnswer[] | null) => {
        if (!this.pending.delete(key)) return;
        signal.removeEventListener('abort', onAbort);
        this.events.emit('question.resolved', { conversationId, callId });
        resolve(a);
      };
      this.pending.set(key, { conversationId, resolve: finish });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.events.emit('question.requested', { conversationId, messageId, callId, questions });
    });
  }

  has(conversationId: Id): boolean {
    return [...this.pending.values()].some((p) => p.conversationId === conversationId);
  }

  answer(conversationId: Id, callId: string, answers: QuestionAnswer[] | null): void {
    const p = this.pending.get(`${conversationId}:${callId}`);
    if (!p) throw new HarnessError('not_found', 'Aucune question en attente pour cet appel');
    if (answers !== null && !Array.isArray(answers)) throw new HarnessError('invalid_argument', 'Réponses invalides');
    p.resolve(
      answers === null
        ? null
        : answers.map((a) => ({ questionId: String(a.questionId), optionIds: Array.isArray(a.optionIds) ? a.optionIds.map(String) : [], text: typeof a.text === 'string' && a.text.trim() ? a.text.slice(0, 20_000) : null })),
    );
  }
}

/**
 * Détection de boucle : appels répétés sans progrès (mêmes outil et arguments) dans une fenêtre
 * d'appels récents. Comparaison exacte ou normalisée.
 */
export class LoopDetector {
  private readonly recent: { key: string; name: string; args: string }[] = [];
  private readonly allowed = new Map<string, number>();

  constructor(private readonly cfg: Settings['loop']) {}

  private key(name: string, args: string): string {
    if (this.cfg.match === 'exact') return `${name}|${args}`;
    let normalized = args;
    try {
      const sort = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase() : v;
      normalized = JSON.stringify(sort(JSON.parse(args || '{}')));
    } catch {
      normalized = args.replace(/\s+/g, ' ').trim().toLowerCase();
    }
    return `${name}|${normalized}`;
  }

  /** Enregistre l'appel ; retourne un rapport si le seuil de répétition est atteint. */
  check(conversationId: Id, name: string, args: string): LoopReport | null {
    if (!this.cfg.enabled) return null;
    const key = this.key(name, args);
    this.recent.push({ key, name, args });
    if (this.recent.length > this.cfg.window) this.recent.shift();
    const count = this.recent.filter((r) => r.key === key).length - (this.allowed.get(key) ?? 0);
    if (count < this.cfg.threshold) return null;
    return { conversationId, calls: [{ name, arguments: args, count: this.recent.filter((r) => r.key === key).length }] };
  }

  /** Poursuite autorisée une fois : le compteur repart de zéro pour cet appel. */
  allowOnce(name: string, args: string): void {
    const key = this.key(name, args);
    this.allowed.set(key, this.recent.filter((r) => r.key === key).length);
  }
}

/** Attente de la décision de l'utilisateur après une détection de boucle. */
export class LoopGate {
  private readonly pending = new Map<Id, (d: 'stop' | 'continue') => void>();

  constructor(private readonly events: EventBus) {}

  wait(report: LoopReport, signal: AbortSignal): Promise<'stop' | 'continue'> {
    return new Promise((resolve) => {
      const onAbort = () => finish('stop');
      const finish = (d: 'stop' | 'continue') => {
        if (!this.pending.delete(report.conversationId)) return;
        signal.removeEventListener('abort', onAbort);
        this.events.emit('loop.resolved', { conversationId: report.conversationId });
        resolve(d);
      };
      this.pending.set(report.conversationId, finish);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.events.emit('loop.detected', report);
    });
  }

  has(conversationId: Id): boolean {
    return this.pending.has(conversationId);
  }

  resolve(conversationId: Id, decision: 'stop' | 'continue'): void {
    const p = this.pending.get(conversationId);
    if (!p) throw new HarnessError('not_found', 'Aucune boucle en attente de décision');
    p(decision === 'continue' ? 'continue' : 'stop');
  }
}

interface ProposalRow {
  id: number;
  conversation_id: number;
  message_id: number;
  call_id: string;
  path: string;
  status: string;
  change_json: string;
  created_at: string;
}

/** Mode Proposition : changements enregistrés, appliqués seulement après validation de l'utilisateur. */
export class ProposalService {
  /** Conversations ayant des propositions à traiter (une seule requête, même pour une longue liste). */
  private openConversations: Set<Id> | null = null;

  constructor(
    private readonly db: Database,
    private readonly events: EventBus,
  ) {}

  private map(r: ProposalRow): FileProposal {
    return { id: r.id, conversationId: r.conversation_id, messageId: r.message_id, callId: r.call_id, path: r.path, status: r.status as FileProposal['status'], change: json<FileChange>(r.change_json, { path: r.path, status: 'modified', before: '', after: '' }), createdAt: r.created_at };
  }

  create(conversationId: Id, messageId: Id, callId: string, fullPath: string, change: FileChange): Id {
    const { lastInsertRowid } = this.db.run(
      "INSERT INTO file_proposals (conversation_id, message_id, call_id, path, status, change_json, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      conversationId,
      messageId,
      callId,
      fullPath,
      JSON.stringify(change),
      now(),
    );
    this.changed(conversationId);
    return lastInsertRowid;
  }

  /**
   * Enregistre un changement. Une proposition en attente sur le même fichier est modifiée, pas recréée ;
   * revenue à l'état d'origine du fichier, elle est retirée.
   */
  propose(conversationId: Id, messageId: Id, callId: string, fullPath: string, change: FileChange): { id: Id; outcome: 'created' | 'revised' | 'withdrawn' } {
    const open = this.open(conversationId, fullPath);
    if (!open) return { id: this.create(conversationId, messageId, callId, fullPath, change), outcome: 'created' };
    const neutral = change.status === 'deleted' ? open.change.status === 'created' : change.status === 'modified' && change.after === change.before;
    if (neutral) {
      this.setStatus(open, 'rejected');
      return { id: open.id, outcome: 'withdrawn' };
    }
    this.db.run("UPDATE file_proposals SET status = 'pending', change_json = ? WHERE id = ?", JSON.stringify(change), open.id);
    this.changed(conversationId);
    return { id: open.id, outcome: 'revised' };
  }

  /** Changement en attente sur ce fichier, tant que le fichier n'a pas bougé : base des lectures et écritures suivantes. */
  base(conversationId: Id, fullPath: string): FileChange | null {
    const p = this.open(conversationId, fullPath);
    return p && this.fileUnchanged(p) ? p.change : null;
  }

  /** Reste-t-il des propositions à traiter dans cette conversation ? */
  hasOpen(conversationId: Id): boolean {
    this.openConversations ??= new Set(this.db.all<{ conversation_id: number }>("SELECT DISTINCT conversation_id FROM file_proposals WHERE status IN ('pending', 'conflict')").map((r) => r.conversation_id));
    return this.openConversations.has(conversationId);
  }

  private open(conversationId: Id, fullPath: string): FileProposal | null {
    const r = this.db.get<ProposalRow>("SELECT * FROM file_proposals WHERE conversation_id = ? AND path = ? AND status IN ('pending', 'conflict') ORDER BY id DESC LIMIT 1", conversationId, fullPath);
    return r ? this.map(r) : null;
  }

  private fileUnchanged(p: FileProposal): boolean {
    const cur = currentContent(p.path);
    return p.change.status === 'created' ? !cur.exists : cur.exists && cur.content === p.change.before;
  }

  list(conversationId: Id): FileProposal[] {
    return this.db.all<ProposalRow>('SELECT * FROM file_proposals WHERE conversation_id = ? ORDER BY id', conversationId).map((r) => this.map(r));
  }

  get(id: Id): FileProposal {
    const r = this.db.get<ProposalRow>('SELECT * FROM file_proposals WHERE id = ?', id);
    if (!r) throw new HarnessError('not_found', 'Proposition introuvable');
    return this.map(r);
  }

  /** Application après vérification que le fichier n'a pas changé depuis la proposition. */
  apply(id: Id): FileProposal {
    const p = this.get(id);
    if (p.status !== 'pending' && p.status !== 'conflict') throw new HarnessError('conflict', 'Proposition déjà traitée');
    if (!this.fileUnchanged(p)) {
      this.setStatus(p, 'conflict');
      throw new HarnessError('conflict', `Le fichier a changé depuis la proposition : ${p.change.path}. Aucun écrasement : relancez la demande.`);
    }
    applyChanges([{ ...p.change, full: p.path }]);
    return this.setStatus(p, 'applied');
  }

  reject(id: Id): FileProposal {
    const p = this.get(id);
    if (p.status === 'applied') throw new HarnessError('conflict', 'Proposition déjà appliquée');
    return this.setStatus(p, 'rejected');
  }

  private setStatus(p: FileProposal, status: FileProposal['status']): FileProposal {
    this.db.run('UPDATE file_proposals SET status = ? WHERE id = ?', status, p.id);
    this.changed(p.conversationId);
    return this.get(p.id);
  }

  private changed(conversationId: Id): void {
    this.openConversations = null;
    this.events.emit('proposals.changed', { conversationId, proposals: this.list(conversationId) });
  }
}
