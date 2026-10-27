import type { AttachmentRef, Compaction, Message, Project, ResponseStyle } from '@monolith/contracts';
import type { ChatMessage, ContentPart } from '../providers/adapter.ts';
import { estimateTokens } from '../util.ts';

const STYLE: Record<ResponseStyle, string> = {
  default: '',
  short: 'Réponds de façon brève : quelques phrases au plus, sans préambule.',
  pragmatic: 'Va droit au but : priorise les actions concrètes, les commandes et le code utiles ; évite la théorie superflue.',
  detailed: 'Donne une réponse détaillée et structurée, avec les explications, hypothèses et cas particuliers utiles.',
  playful: 'Adopte un ton plus léger et ludique tout en restant exact et utile.',
};

export interface PromptContext {
  responseStyle: ResponseStyle;
  customInstructions: string;
  project: Project | null;
  goal: string;
  /** Résumé du compactage le plus récent, inséré à la place des messages résumés. */
  compactionSummary?: string | null;
}

/** Instructions système : base, style, instructions globales, projet, objectif, résumé — dans cet ordre. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [
    'Tu es l’assistant de Monolith Harness, un espace de travail IA local. Réponds dans la langue de l’utilisateur. Utilise le Markdown lorsque cela améliore la lisibilité (titres, listes, tableaux, blocs de code avec langage).',
  ];
  if (STYLE[ctx.responseStyle]) sections.push(STYLE[ctx.responseStyle]);
  if (ctx.customInstructions.trim()) sections.push(`Instructions de l’utilisateur :\n${ctx.customInstructions.trim()}`);
  if (ctx.project) {
    sections.push(`Projet actif : ${ctx.project.name}`);
    if (ctx.project.instructions.trim()) sections.push(`Instructions du projet « ${ctx.project.name} » :\n${ctx.project.instructions.trim()}`);
  }
  if (ctx.goal.trim()) sections.push(`Objectif persistant de cette discussion :\n${ctx.goal.trim()}`);
  if (ctx.compactionSummary?.trim()) {
    sections.push(`Résumé des échanges antérieurs de cette discussion (compactés pour tenir dans le contexte ; l’historique complet reste consultable par l’utilisateur) :\n${ctx.compactionSummary.trim()}`);
  }
  return sections.join('\n\n');
}

export interface AttachmentLoader {
  text(ref: AttachmentRef): string;
  dataUrl(ref: AttachmentRef): string;
}

export interface HistoryOptions {
  attachments: AttachmentLoader;
  /** Le modèle cible accepte-t-il les images ? `null` : inconnu (on tente l'envoi). */
  vision: boolean | null;
  /** Messages de rang ≤ à cette valeur sont remplacés par le résumé de compactage. */
  compactedUpToSeq?: number | null;
}

export interface HistoryResult {
  messages: ChatMessage[];
  /** Images retirées car le modèle n'accepte pas les images. */
  droppedImages: number;
}

/** Bloc texte d'une pièce jointe : délimité, avec son nom, pour que le modèle la distingue de la consigne. */
export function attachmentBlock(ref: AttachmentRef, content: string): string {
  return `<fichier nom="${ref.name.replace(/"/g, "'")}" type="${ref.mime}">\n${content}\n</fichier>`;
}

/**
 * Historique envoyé au modèle, reconstruit pour le modèle et le transport de la génération en cours :
 *  - la réflexion n'est jamais renvoyée (plusieurs fournisseurs l'interdisent ; elle n'est pas portable) ;
 *  - les réponses sans texte (erreurs) sont omises, une réponse interrompue garde son texte partiel ;
 *  - deux messages consécutifs du même rôle sont fusionnés (alternation exigée par plusieurs API) ;
 *  - les pièces jointes texte sont insérées, les images envoyées seulement si le modèle les accepte.
 */
export function buildHistory(messages: Message[], options?: HistoryOptions): HistoryResult {
  const out: { role: 'user' | 'assistant'; parts: ContentPart[] }[] = [];
  let droppedImages = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (options?.compactedUpToSeq != null && m.seq <= options.compactedUpToSeq) continue;
    const parts: ContentPart[] = [];
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    if (text.trim()) parts.push({ type: 'text', text });
    if (m.role === 'user' && options) {
      for (const p of m.parts) {
        if (p.type !== 'attachment') continue;
        const ref = p.attachment;
        try {
          if (ref.kind === 'text') parts.push({ type: 'text', text: attachmentBlock(ref, options.attachments.text(ref)) });
          else if (options.vision === false) {
            droppedImages++;
            parts.push({ type: 'text', text: `[Image « ${ref.name} » non transmise : le modèle utilisé n’accepte pas les images.]` });
          } else parts.push({ type: 'image_url', image_url: { url: options.attachments.dataUrl(ref) } });
        } catch {
          parts.push({ type: 'text', text: `[Pièce jointe « ${ref.name} » introuvable dans l’espace de travail.]` });
        }
      }
    }
    if (parts.length === 0) continue;
    const last = out.at(-1);
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (last && last.role === role) last.parts.push({ type: 'text', text: '\n\n' }, ...parts);
    else out.push({ role, parts });
  }
  return {
    droppedImages,
    messages: out.map(({ role, parts }) => {
      // Contenu simple (chaîne) lorsqu'il n'y a pas d'image : compatibilité maximale.
      if (parts.every((p) => p.type === 'text')) return { role, content: parts.map((p) => (p as { text: string }).text).join(parts.length > 1 ? '\n\n' : '') };
      return { role, content: parts };
    }),
  };
}

/** Estimation locale des tokens d'une requête (≈ 4 caractères par token, ≈ 1 000 par image). */
export function estimateRequestTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += estimateTokens(m.content) + 4;
    else for (const p of m.content) total += p.type === 'text' ? estimateTokens(p.text) : 1000;
  }
  return total;
}

/** Texte brut d'un message (export, compactage, nommage). */
export function plainText(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('');
}

/** Rang jusqu'auquel compacter : tout sauf les `keepTurns` derniers échanges, sans couper une paire. */
export function compactionCut(messages: Message[], keepTurns: number, after: number | null): number | null {
  const userSeqs = messages.filter((m) => m.role === 'user' && (after === null || m.seq > after)).map((m) => m.seq);
  if (userSeqs.length <= keepTurns) return null;
  const firstKept = userSeqs[userSeqs.length - keepTurns]!;
  return firstKept - 1;
}

export type { Compaction };
