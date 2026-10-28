import type { ToolCallRecord } from './tools.ts';

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
  /** Pièces jointes du projet : transmises au début de chaque conversation du projet. */
  attachments: AttachmentRef[];
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
  /** `auto` : titre provisoire tiré du premier message ; `ai` : nommage automatique par un modèle. */
  titleSource: 'default' | 'user' | 'auto' | 'ai';
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
  /** Pièces jointes du brouillon (conservées avec le texte). */
  draftAttachments: AttachmentRef[];
  /** Provenance d'une bifurcation ou d'une sauvegarde avant reprise. */
  forkedFrom: { conversationId: Id; messageId: Id | null } | null;
  /** Sous-agent : conversation parente (null pour une conversation normale). */
  parentId: Id | null;
  /** Profondeur de délégation (0 : conversation de l'utilisateur). */
  depth: number;
  /** Rôle (préréglage) du sous-agent. */
  role: string | null;
  /** Budget d'un sous-agent (null : réglages généraux). */
  budget: ConversationBudget | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  /** Calculé : une génération est en cours dans le moteur. */
  generating: boolean;
}

export interface ConversationBudget {
  maxRounds: number | null;
  maxOutputTokens: number | null;
  timeoutSec: number | null;
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
  | { type: 'attachment'; attachment: AttachmentRef }
  | { type: 'reasoning'; text: string; durationMs?: number }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; code: string; text: string }
  | { type: 'tool'; call: ToolCallRecord };

export interface MessageUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  /** true lorsque les compteurs sont estimés localement et non fournis par l'API. */
  estimated: boolean;
}

/** Niveau de réflexion : demandé, réellement envoyé, paramètre utilisé et éventuel repli. */
export interface ReasoningResolution {
  requested: ReasoningLevel;
  /** null : aucun paramètre envoyé (Auto). */
  sent: ReasoningLevel | null;
  /** Paramètre de transport, ex. `reasoning_effort=high`, `reasoning.enabled=false`, `thinking.type=disabled`. */
  parameter: string | null;
  /** Raison d'un repli (niveau non déclaré, refusé par le fournisseur…). */
  fallback: string | null;
}

export interface GenerationSnapshot {
  providerId: Id;
  providerName: string;
  providerKind: ProviderKind;
  model: string;
  reasoningLevel: ReasoningLevel;
  reasoning?: ReasoningResolution;
  mode: ConversationMode;
  agentMode: AgentMode;
  responseStyle: ResponseStyle;
  temperature: number | null;
  maxOutputTokens: number | null;
  /** Outils exposés au modèle pour cette génération. */
  tools?: string[];
  startedAt: string;
}

export interface MessageError {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  attempts?: number;
}

/** Origine d'un message utilisateur. */
export type MessageOrigin = 'direct' | 'queue' | 'steer';

export interface Message {
  id: Id;
  conversationId: Id;
  seq: number;
  role: MessageRole;
  origin: MessageOrigin;
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
  /** Origine des niveaux : table documentée, catalogue du fournisseur ou saisie de l'utilisateur. */
  reasoningSource: 'unknown' | 'documented' | 'catalog' | 'user';
  /** Niveaux explicitement refusés par le fournisseur ; retirés jusqu'à la prochaine actualisation. */
  rejectedLevels: ReasoningLevel[];
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
  /** Google : Gemini natif et Vertex AI. */
  google: GoogleOptions;
  /** Agent externe ACP (OpenCode, Gemini CLI, Claude Code…). */
  acp: AcpOptions;
  /** Modèle composé : un orchestrateur consulte des spécialistes. */
  composite: CompositeOptions;
}

/**
 * Authentification Google :
 *  - `api_key` : clé Google AI Studio (Gemini natif) ;
 *  - `express` : clé Vertex AI en mode Express ;
 *  - `adc` : identifiants par défaut de l'application (gcloud auth application-default login, GOOGLE_APPLICATION_CREDENTIALS) ;
 *  - `service_account` : fichier JSON de compte de service, enregistré chiffré dans le champ Clé.
 */
export type GoogleAuthMode = 'api_key' | 'express' | 'adc' | 'service_account';

export interface GoogleOptions {
  project: string;
  location: string;
  auth: GoogleAuthMode;
}

export interface AcpOptions {
  /** Exécutable de l'agent (dans le PATH ou chemin absolu). */
  command: string;
  args: string[];
  /** Variables d'environnement non secrètes ajoutées au processus. */
  env: Record<string, string>;
  /**
   * Compte de l'agent connecté par navigateur : `chatgpt` (abonnement ChatGPT via Codex). Les clés
   * d'API OpenAI de l'environnement ne sont alors jamais transmises à l'agent.
   */
  account?: 'chatgpt' | null;
}

export interface ModelRef {
  providerId: Id;
  model: string;
}

export interface CompositeSpecialist extends ModelRef {
  /** Nom court utilisé par l'orchestrateur (lettres, chiffres, tirets). */
  name: string;
  /** Domaine de compétence décrit à l'orchestrateur. */
  description: string;
}

export interface CompositeOptions {
  orchestrator: ModelRef | null;
  specialists: CompositeSpecialist[];
  /** Consultations maximum par réponse. */
  maxConsultations: number;
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
  /** Options pré-remplies (commande d'un agent ACP, mode d'authentification…). */
  defaults?: Partial<ProviderOptions>;
  /** Champ Clé : libellé spécifique (ex. JSON de compte de service). */
  keyKind?: 'api_key' | 'json' | 'none';
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
  kind: 'chat' | 'naming' | 'compaction' | 'memory' | 'vision' | 'subagent' | 'benchmark' | 'tool' | 'validation' | 'test' | 'other';
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

/** image : envoyée aux modèles avec vision ; text : texte UTF-8 ; file : autre fichier (lu par les outils) ; folder : dossier copié. */
export type AttachmentKind = 'image' | 'text' | 'file' | 'folder';

export interface AttachmentRef {
  id: Id;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

/** Limites explicites des pièces jointes (affichées dans l'interface). */
export const ATTACHMENT_LIMITS = {
  /** Image transmise telle quelle aux modèles avec vision (au-delà : fichier lu par les outils). */
  imageBytes: 10 * 1024 * 1024,
  /** Fichier ou dossier joint (copie dans les données de Monolith). */
  fileBytes: 100 * 1024 * 1024,
  /** Fichiers d'un dossier joint (dépendances, .git et caches exclus). */
  folderFiles: 10_000,
  perMessage: 10,
  perProject: 20,
  imageMimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
} as const;

export interface QueuedInput {
  id: Id;
  conversationId: Id;
  /** `queue` : envoyé après la génération en cours ; `steer` : transmis à la prochaine frontière contrôlée. */
  kind: 'queue' | 'steer';
  text: string;
  attachments: AttachmentRef[];
  sortOrder: number;
  createdAt: string;
}

export interface MessageTemplate {
  id: Id;
  name: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Compaction {
  id: Id;
  conversationId: Id;
  /** Messages de rang ≤ upToSeq remplacés par le résumé dans les requêtes (conservés dans l'historique). */
  upToSeq: number;
  summary: string;
  model: string;
  estimatedTokensBefore: number | null;
  trigger: 'manual' | 'auto';
  createdAt: string;
}

/** Poste du contexte de la prochaine requête (estimation : ~4 caractères par token, 1000 par image). */
export interface ContextPart {
  key: 'system' | 'instructions' | 'project' | 'goal' | 'summary' | 'agent' | 'tools' | 'user' | 'assistant' | 'toolResults' | 'attachments' | 'images';
  tokens: number;
  /** Nombre d'éléments (outils, messages, pièces jointes, images). */
  count: number | null;
}

/** AI Info : contexte de la prochaine requête détaillé par poste, modèle et niveau de réflexion. */
export interface ContextDetail {
  usage: ContextUsage;
  parts: ContextPart[];
  /** Total estimé de la requête (somme des postes). */
  estimated: number;
  provider: string | null;
  model: string | null;
  reasoningLevel: string | null;
}

export interface ContextUsage {
  conversationId: Id;
  /** Tokens d'entrée de la prochaine requête (dernier compteur API + estimation du reste, ou estimation complète). */
  tokens: number;
  source: 'api' | 'estimate';
  contextWindow: number | null;
  maxOutputTokens: number | null;
  compactions: number;
}
