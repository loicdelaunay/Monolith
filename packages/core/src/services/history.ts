import { HarnessError, type AttachmentRef, type Conversation, type Id, type Message, type ResumeResult } from '@monolith/contracts';
import type { Database } from '../storage/database.ts';
import type { EventBus } from '../events.ts';
import type { ConversationService } from './conversations.ts';
import type { MessageService } from './messages.ts';
import type { CompactionService } from './compactions.ts';
import type { ProjectService } from './projects.ts';
import { plainText } from '../generation/prompt.ts';

export interface HistoryDeps {
  db: Database;
  events: EventBus;
  conversations: ConversationService;
  messages: MessageService;
  compactions: CompactionService;
  projects: ProjectService;
  isGenerating: (id: Id) => boolean;
}

/** Bifurcation, reprise et export : opérations sur l'historique qui ne perdent jamais de données. */
export class HistoryService {
  constructor(private readonly deps: HistoryDeps) {}

  /** Copie la conversation jusqu'au message indiqué inclus (entière si absent). */
  fork(id: Id, messageId: Id | null, opts: { archived?: boolean; title?: string } = {}): Conversation {
    const { conversations, messages, compactions, db } = this.deps;
    const source = conversations.get(id);
    let upToSeq: number | null = null;
    if (messageId !== null) {
      const m = messages.get(messageId);
      if (m.conversationId !== id) throw new HarnessError('invalid_argument', 'Ce message n’appartient pas à la conversation');
      upToSeq = m.seq;
    }
    return db.transaction(() => {
      const copy = conversations.create(source.projectId, opts.title ?? `${source.title} (bifurcation)`, undefined, {
        source,
        archived: opts.archived ?? false,
        forkedFrom: { conversationId: id, messageId },
        titleSource: 'user',
      });
      messages.copyTo(id, copy.id, upToSeq);
      compactions.copyTo(id, copy.id, upToSeq);
      return conversations.touch(copy.id);
    });
  }

  /**
   * « Reprendre ici » : l'historique complet est d'abord sauvegardé dans une conversation archivée,
   * puis ce message et la suite sont retirés ; son texte et ses pièces jointes reviennent dans l'éditeur.
   */
  resumeFrom(id: Id, messageId: Id): ResumeResult {
    const { conversations, messages, compactions, db, events } = this.deps;
    if (this.deps.isGenerating(id)) throw new HarnessError('busy', 'Arrêtez la génération en cours avant de reprendre depuis un message');
    const message = messages.get(messageId);
    if (message.conversationId !== id) throw new HarnessError('invalid_argument', 'Ce message n’appartient pas à la conversation');
    if (message.role !== 'user') throw new HarnessError('invalid_argument', 'La reprise se fait depuis un message utilisateur');
    const conversation = conversations.get(id);
    const text = plainText(message);
    const attachments = message.parts.filter((p) => p.type === 'attachment').map((p) => (p as { attachment: AttachmentRef }).attachment);
    const stamp = new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const result = db.transaction(() => {
      const backup = this.fork(id, null, { archived: true, title: `${conversation.title} — avant reprise du ${stamp}` });
      messages.deleteFrom(id, message.seq);
      compactions.deleteFrom(id, message.seq);
      conversations.setDraft(id, text, attachments);
      return { text, attachments, backupConversationId: backup.id };
    });
    events.emit('conversation.messagesReset', { conversationId: id });
    return result;
  }

  exportMarkdown(id: Id, includeReasoning: boolean): { fileName: string; markdown: string } {
    const { conversations, messages, projects } = this.deps;
    const c = conversations.get(id);
    const project = c.projectId !== null ? projects.get(c.projectId).name : 'Espace personnel';
    const lines: string[] = [`# ${c.title}`, '', `_Exporté le ${new Date().toLocaleString('fr-FR')} — ${project}_`, ''];
    if (c.goal.trim()) lines.push(`> **Objectif :** ${c.goal.trim().replace(/\n/g, '\n> ')}`, '');
    for (const m of messages.list(id)) lines.push(...renderMessage(m, includeReasoning));
    const fileName = `${c.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80).trim() || 'conversation'}.md`;
    return { fileName, markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n' };
  }
}

function renderMessage(m: Message, includeReasoning: boolean): string[] {
  const when = new Date(m.createdAt).toLocaleString('fr-FR');
  const out: string[] = [];
  if (m.role === 'user') {
    out.push(`## ${m.origin === 'steer' ? 'Vous (instruction pendant la génération)' : 'Vous'} — ${when}`, '');
  } else {
    out.push(`## Assistant${m.snapshot ? ` (${m.snapshot.model})` : ''} — ${when}`, '');
  }
  for (const p of m.parts) {
    if (p.type === 'text') out.push(p.text, '');
    else if (p.type === 'reasoning' && includeReasoning) out.push('<details><summary>Réflexion</summary>', '', p.text, '', '</details>', '');
    else if (p.type === 'attachment') out.push(`📎 ${p.attachment.name} (${p.attachment.mime})`, '');
    else if (p.type === 'notice') out.push(`> ⚠ ${p.text}`, '');
  }
  if (m.error) out.push(`> ✖ ${m.error.message}`, '');
  if (m.status === 'cancelled' || m.status === 'interrupted') out.push(`_(${m.status === 'cancelled' ? 'réponse annulée' : 'réponse interrompue'})_`, '');
  return out;
}
