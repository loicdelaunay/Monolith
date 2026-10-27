import type { Message, Project, ResponseStyle } from '@monolith/contracts';
import type { ChatMessage } from '../providers/adapter.ts';

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
}

/** Instructions système : base, style, instructions globales, projet, objectif — dans cet ordre. */
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
  return sections.join('\n\n');
}

/**
 * Historique envoyé au modèle. La réflexion n'est jamais renvoyée (plusieurs fournisseurs
 * l'interdisent et elle n'est pas portable d'un modèle à l'autre). Les réponses sans texte
 * (erreurs) sont omises ; une réponse interrompue conserve son texte partiel.
 */
export function buildHistory(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    if (!text.trim()) continue;
    const last = out.at(-1);
    // Deux messages consécutifs du même rôle (ex. réponse en erreur omise) sont fusionnés :
    // plusieurs API exigent l'alternance utilisateur/assistant.
    if (last && last.role === m.role) last.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  return out;
}
