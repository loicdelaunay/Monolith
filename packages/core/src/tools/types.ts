import type { AgentMode, ConversationMode, Id, Settings, ToolDisplay, ToolEffect } from '@monolith/contracts';
import type { ResourceScope } from './scope.ts';
import type { TerminalManager } from './terminals.ts';
import type { EventBus } from '../events.ts';

/** Contexte d'exécution d'un appel d'outil (figé pour la génération). */
export interface ToolContext {
  conversationId: Id;
  projectId: Id | null;
  messageId: Id;
  callId: string;
  scope: ResourceScope;
  mode: ConversationMode;
  agentMode: AgentMode;
  settings: Settings;
  signal: AbortSignal;
  terminals: TerminalManager;
  events: EventBus;
  host: 'desktop' | 'cli' | 'server';
  /** Mode Proposition : enregistre un changement de fichier sans l'appliquer. */
  propose(changes: (import('@monolith/contracts').FileChange & { full: string })[]): Id[];
  /** Questions interactives : attend la réponse (null = annulé). */
  ask(questions: import('@monolith/contracts').Question[]): Promise<import('@monolith/contracts').QuestionAnswer[] | null>;
  info: { conversationTitle: string; projectName: string | null; model: string; provider: string };
  /** Profondeur de délégation de la conversation (0 : conversation de l'utilisateur). */
  depth: number;
  /** Mise à jour de l'affichage de l'appel pendant son exécution (sous-agents…). */
  progress(display: ToolDisplay): void;
  /** Autorisation distincte en cours d'exécution (repli Legacy…) : règles, puis demande à l'utilisateur. */
  authorize(resources: string[], label: string, reason: string): Promise<boolean>;
}

export interface ToolResult {
  /** Texte renvoyé au modèle : toujours fidèle au résultat réel. */
  result: string;
  display?: ToolDisplay;
  /** Statut final particulier (mode Proposition). */
  status?: 'done' | 'proposed' | 'error';
}

export interface ToolDefinition {
  name: string;
  /** Famille (Sources, Édition, Terminal…), base des règles d'autorisation. */
  family: string;
  /** Skill qui active cet outil. */
  skill: string;
  /** Autres skills qui l'activent aussi (inspection partagée clavier/souris). */
  alsoSkills?: string[];
  description: string;
  /** Schéma JSON des arguments. */
  parameters: Record<string, unknown>;
  effects: ToolEffect[];
  /** Hôtes où l'outil fonctionne réellement. */
  hosts?: ('desktop' | 'cli' | 'server')[];
  /** Systèmes pris en charge (process.platform) ; absent : tous. */
  platforms?: NodeJS.Platform[];
  /**
   * Cible lisible et ressources pour la correspondance des règles ; `grant` : ressource enregistrée
   * avec un accord permanent (sinon l'accord couvre tout l'outil).
   */
  target(args: Record<string, unknown>, ctx: ToolContext): { label: string | null; resources: string[]; grant?: string };
  /** Aperçu des changements attendus, montré dans la demande d'autorisation. */
  preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolDisplay | null> | ToolDisplay | null;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) {
    if (required) throw new Error(`Argument « ${key} » manquant`);
    return '';
  }
  return String(v);
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback;
}

/** Tronque un résultat en le signalant explicitement au modèle. */
/** Paramètres de lecture : sans plage, contenu entier ; avec plage, lignes start_line à end_line (incluses). */
export const LINE_RANGE = {
  start_line: { type: 'number', description: 'Première ligne lue (à partir de 1). Sans start_line ni end_line : contenu entier.' },
  end_line: { type: 'number', description: 'Dernière ligne lue (incluse). Sans end_line : jusqu’à la fin.' },
};

/**
 * Lecture « contenu entier » ou « lignes X à Y ». Si le résultat dépasse la taille maximale, il est
 * coupé en fin de ligne et la note indique exactement la plage à relire (jamais de coupe silencieuse).
 */
export function readLines(text: string, args: Record<string, unknown>, max: number, opts: { numbered?: boolean } = {}): { body: string; start: number; end: number; total: number; whole: boolean; next: { start: number; end: number } | null } {
  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const hasStart = typeof args.start_line === 'number' && Number.isFinite(args.start_line);
  const hasEnd = typeof args.end_line === 'number' && Number.isFinite(args.end_line);
  const start = Math.min(Math.max(1, hasStart ? Math.floor(args.start_line as number) : 1), Math.max(1, total));
  const end = Math.max(start, Math.min(total, hasEnd ? Math.floor(args.end_line as number) : total));
  const out: string[] = [];
  let size = 0;
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    const line = opts.numbered ? `${String(n).padStart(5)}| ${lines[n - 1]}` : lines[n - 1]!;
    if (size + line.length + 1 > max && out.length) break;
    out.push(line);
    size += line.length + 1;
    last = n;
  }
  const next = last < end ? { start: last + 1, end } : null;
  const body = next ? `${out.join('\n')}\n\n[… lignes ${next.start} à ${next.end} non transmises (taille maximale d’un résultat) : relisez avec start_line=${next.start} end_line=${next.end}]` : out.join('\n');
  return { body, start, end: last, total, whole: !hasStart && !hasEnd && !next, next };
}

export function limit(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… résultat tronqué : ${text.length - max} caractères supplémentaires non transmis]`;
}
