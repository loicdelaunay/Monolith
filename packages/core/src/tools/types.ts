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
export function limit(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… résultat tronqué : ${text.length - max} caractères supplémentaires non transmis]`;
}
