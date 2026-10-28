import type { CatalogModel, ConnectionTestResult, Id, ProviderKind, ProviderOptions, ReasoningLevel, ToolDisplay } from '@monolith/contracts';

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON brut tel que produit par le modèle. */
  arguments: string;
  /** Données propres au fournisseur, renvoyées telles quelles au tour suivant. */
  meta?: Record<string, string>;
}

/** Action exécutée hors du moteur (agent ACP, spécialiste) : affichée, jamais exécutée par le moteur. */
export interface ExternalToolEvent {
  id: string;
  name: string;
  family: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'denied';
  arguments: string;
  result: string | null;
  display?: ToolDisplay | null;
}

/** Demande d'autorisation émise par un agent externe. */
export interface ExternalPermissionRequest {
  toolName: string;
  family: string;
  title: string;
  arguments: string;
  /** Ressources concernées (chemins, commandes) pour les règles. */
  resources: string[];
  effects: ('read' | 'write' | 'exec' | 'network')[];
}

/**
 * Services du moteur offerts aux adaptateurs d'agents (ACP, modèles composés) :
 * portée des fichiers, autorisations, connexions des autres fournisseurs.
 */
export interface AdapterContext {
  conversationId: Id;
  /** Dossier de travail (première racine de la conversation ou espace privé). */
  cwd: string;
  roots: string[];
  /** Transcription des échanges précédents (reprise d'une session externe). */
  transcript: string;
  resolvePath(path: string, write: boolean): string;
  requestPermission(req: ExternalPermissionRequest, signal: AbortSignal): Promise<{ allow: boolean; always: boolean }>;
  /** Connexion d'un autre fournisseur (modèles composés). */
  connection(providerId: Id): Promise<{ adapter: ProviderAdapter; conn: ProviderConnection; providerName: string }>;
}

/** Message normalisé envoyé à un adaptateur (indépendant du protocole). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** Appels d'outils émis par l'assistant dans ce message. */
  toolCalls?: ToolCallRequest[];
  /** Réponse d'outil : identifiant de l'appel. */
  toolCallId?: string;
  /**
   * Message utilisateur portant les images produites par des outils : identifiant de l'appel de
   * chaque image, dans l'ordre (Gemini 3+ les place dans la réponse de fonction correspondante).
   */
  toolImagesFor?: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  reasoningLevel: ReasoningLevel;
  temperature: number | null;
  maxOutputTokens: number | null;
  /** Champs propres au transport (paramètres de réflexion…), fusionnés au corps de la requête. */
  extraBody?: Record<string, unknown>;
  /** Outils exposés au modèle (absents : aucun outil). */
  tools?: ToolSpec[];
  /** Fourni par le moteur aux adaptateurs qui en ont besoin (agents externes, modèles composés). */
  context?: AdapterContext;
}

/** Événements normalisés produits par tous les adaptateurs. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'external_tool'; call: ExternalToolEvent }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'; raw: string | null }
  | { type: 'notice'; level: 'info' | 'warning'; code: string; text: string };

export interface ProviderConnection {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string | null;
  options: ProviderOptions;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  listModels(conn: ProviderConnection, signal: AbortSignal): Promise<CatalogModel[]>;
  test(conn: ProviderConnection, opts: { model?: string; allowCompletion?: boolean }, signal: AbortSignal): Promise<ConnectionTestResult>;
  stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /** Libère les ressources (processus d'agents) à l'arrêt du moteur. */
  dispose?(): Promise<void>;
}
