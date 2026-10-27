// Entités partagées entre le moteur et les interfaces.
// Les dates sont des chaînes ISO 8601 UTC ; les identifiants sont des entiers SQLite
// sauf mention contraire.

export type Id = number;

export interface Project {
  id: Id;
  name: string;
  icon: string;
  color: string;
  instructions: string;
  sortOrder: number;
  folders: ProjectFolder[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFolder {
  id: Id;
  projectId: Id;
  path: string;
  label: string;
  sortOrder: number;
  /** Calculé à la lecture : le dossier existe et est lisible. */
  available: boolean;
}

export type ConversationMode = 'chat' | 'agent';
export type AgentMode = 'plan' | 'propose' | 'execute';
export type ResponseStyle = 'default' | 'short' | 'pragmatic' | 'detailed' | 'playful';

export interface Conversation {
  id: Id;
  /** null : espace personnel (conversation sans projet). */
  projectId: Id | null;
  title: string;
  titleSource: 'default' | 'user' | 'auto';
  favorite: boolean;
  pinned: boolean;
  archived: boolean;
  sortOrder: number;
  goal: string;
  mode: ConversationMode;
  agentMode: AgentMode;
  providerId: Id | null;
  model: string | null;
  reasoningLevel: ReasoningLevel;
  draft: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  /** Calculé : une génération est en cours dans le moteur. */
  generating: boolean;
}

export type ReasoningLevel = 'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'on';

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'error' | 'cancelled' | 'interrupted';

/**
 * Le contenu d'un message est une suite ordonnée de parties : la chronologie
 * (réflexion, texte, appels d'outils, résultats) est celle de leur arrivée.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; durationMs?: number }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; code: string; text: string };

export interface MessageUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  /** true lorsque les compteurs sont estimés localement et non fournis par l'API. */
  estimated: boolean;
}

export interface GenerationSnapshot {
  providerId: Id;
  providerName: string;
  providerKind: ProviderKind;
  model: string;
  reasoningLevel: ReasoningLevel;
  mode: ConversationMode;
  agentMode: AgentMode;
  responseStyle: ResponseStyle;
  temperature: number | null;
  maxOutputTokens: number | null;
  startedAt: string;
}

export interface MessageError {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  attempts?: number;
}

export interface Message {
  id: Id;
  conversationId: Id;
  seq: number;
  role: MessageRole;
  status: MessageStatus;
  parts: MessagePart[];
  snapshot: GenerationSnapshot | null;
  usage: MessageUsage | null;
  error: MessageError | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  firstTokenMs: number | null;
}

export type ProviderKind =
  | 'openai-compatible'
  | 'deepseek'
  | 'gemini'
  | 'vertex'
  | 'opencode'
  | 'acp'
  | 'local'
  | 'composite';

export interface ProviderModel {
  id: string;
  label: string;
  /** Présent dans le sélecteur du chat. */
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  source: 'catalog' | 'manual';
  capabilities: ModelCapabilities;
}

export interface ModelCapabilities {
  /** Niveaux de réflexion documentés pour ce modèle et ce transport ; vide = inconnu (Auto seul). */
  reasoningLevels: ReasoningLevel[];
  vision: boolean | null;
  tools: boolean | null;
}

export interface Provider {
  id: Id;
  name: string;
  kind: ProviderKind;
  preset: string;
  baseUrl: string;
  enabled: boolean;
  sortOrder: number;
  /** Une clé est enregistrée (jamais transmise à l'interface). */
  hasKey: boolean;
  /** Quatre derniers caractères de la clé, pour l'identifier. */
  keyHint: string | null;
  /** La clé enregistrée ne peut pas être déchiffrée sur ce poste. */
  keyUnreadable: boolean;
  options: ProviderOptions;
  models: ProviderModel[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderOptions {
  /** En-têtes HTTP supplémentaires (non secrets). */
  headers: Record<string, string>;
  /** Délai max avant le premier octet, en secondes. */
  connectTimeoutSec: number;
  /** Délai max entre deux fragments de flux, en secondes. */
  idleTimeoutSec: number;
  /** Envoyer `stream_options.include_usage` (désactivé automatiquement si refusé). */
  streamUsage: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
}

export interface ProviderPreset {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  keyRequired: boolean;
  keyUrl: string | null;
  docsUrl: string | null;
  /** Disponible dans cette version ; sinon `unavailableReason` explique pourquoi. */
  available: boolean;
  unavailableReason?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  modelCount: number | null;
  message: string;
  code: string;
  /** Le test a consommé une requête de génération (coût possible). */
  usedCompletion: boolean;
}

export interface CatalogModel {
  id: string;
  label: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: ModelCapabilities;
  owner: string | null;
}

export interface UsageRecord {
  id: Id;
  kind: 'chat' | 'naming' | 'memory' | 'vision' | 'subagent' | 'benchmark' | 'tool' | 'test' | 'other';
  conversationId: Id | null;
  projectId: Id | null;
  providerId: Id | null;
  providerName: string;
  model: string;
  startedAt: string;
  finishedAt: string | null;
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  estimated: boolean;
  status: 'ok' | 'error' | 'cancelled' | 'incomplete';
}

export interface SearchHit {
  conversationId: Id;
  projectId: Id | null;
  title: string;
  snippet: string;
  messageId: Id | null;
}
