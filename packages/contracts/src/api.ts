import type {
  CatalogModel,
  ConnectionTestResult,
  Conversation,
  Id,
  Message,
  MessagePart,
  MessageStatus,
  MessageUsage,
  MessageError,
  Project,
  Provider,
  ProviderKind,
  ProviderModel,
  ProviderOptions,
  ProviderPreset,
  ReasoningLevel,
  SearchHit,
  AgentMode,
  ConversationMode,
} from './model.ts';
import type { Settings, SettingsPatch } from './settings.ts';
import type { PlatformCapabilities } from './platform.ts';

export interface AppInfo {
  name: string;
  version: string;
  host: 'desktop' | 'cli' | 'server';
  platform: 'win32' | 'linux' | 'darwin' | string;
  arch: string;
  dataDir: string;
  /** Données à côté de l'exécutable. */
  portable: boolean;
  /** Origine de l'emplacement des données. */
  dataDirSource: 'argument' | 'environment' | 'location-file' | 'portable' | 'user';
  databasePath: string;
  schemaVersion: number;
  secretProtection: SecretProtectionInfo;
  capabilities: PlatformCapabilities;
  nodeVersion: string;
  sqliteVersion: string;
}

export interface SecretProtectionInfo {
  mechanism: 'dpapi' | 'keychain' | 'libsecret' | 'file' | 'memory' | 'none';
  /** Mécanisme réellement fourni par le système (false : repli fichier ou indisponible). */
  systemBacked: boolean;
  available: boolean;
  message: string;
}

export interface ConversationListQuery {
  /** `null` : espace personnel ; absent : toutes. */
  projectId?: Id | null;
  includeArchived?: boolean;
}

export interface ConversationPatch {
  title?: string;
  favorite?: boolean;
  pinned?: boolean;
  archived?: boolean;
  goal?: string;
  mode?: ConversationMode;
  agentMode?: AgentMode;
  providerId?: Id | null;
  model?: string | null;
  reasoningLevel?: ReasoningLevel;
  projectId?: Id | null;
}

export interface ProjectInput {
  name: string;
  icon?: string;
  color?: string;
  instructions?: string;
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  preset: string;
  baseUrl: string;
  enabled?: boolean;
  options?: Partial<ProviderOptions>;
  /** Clé fournie à la création ; jamais relue ensuite. */
  apiKey?: string;
}

export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  options?: Partial<ProviderOptions>;
}

/** Brouillon de connexion testé avant enregistrement. */
export interface ProviderTestInput {
  providerId?: Id;
  kind: ProviderKind;
  baseUrl: string;
  /** Clé saisie non encore enregistrée ; sinon la clé enregistrée de `providerId` est utilisée. */
  apiKey?: string;
  options?: Partial<ProviderOptions>;
  /** Modèle à utiliser pour un test par génération lorsque le catalogue est indisponible. */
  model?: string;
  /** Autorise un test par génération (coût possible). */
  allowCompletion?: boolean;
}

export interface SendInput {
  text: string;
}

export interface SendResult {
  userMessageId: Id;
  assistantMessageId: Id;
}

export interface GenerationState {
  conversationId: Id;
  messageId: Id;
  status: 'running' | 'retrying' | 'finished';
  attempt: number;
  /** Raison d'une nouvelle tentative. */
  retryReason?: string;
  retryInMs?: number;
}

/**
 * Contrat RPC : chaque entrée associe un nom de méthode à ses paramètres et à son résultat.
 * Le même contrat est servi en processus (CLI), par MessagePort (desktop) et par HTTP/WS (serveur).
 */
export interface HarnessApi {
  'app.info': { params: void; result: AppInfo };
  'app.changelog': { params: void; result: string };
  /** Enregistre un emplacement de données alternatif (null : retour au défaut). Effet au prochain démarrage ; rien n'est déplacé. */
  'app.setDataLocation': { params: { dir: string | null }; result: { file: string; restartRequired: true } };

  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'settings.reset': { params: { section?: keyof Settings }; result: Settings };

  'projects.list': { params: void; result: Project[] };
  'projects.create': { params: ProjectInput; result: Project };
  'projects.update': { params: { id: Id; patch: Partial<ProjectInput> }; result: Project };
  'projects.delete': { params: { id: Id; deleteConversations: boolean }; result: void };
  'projects.reorder': { params: { ids: Id[] }; result: void };
  'projects.addFolder': { params: { id: Id; path: string; label?: string }; result: Project };
  'projects.removeFolder': { params: { folderId: Id }; result: Project };

  'conversations.list': { params: ConversationListQuery; result: Conversation[] };
  'conversations.get': { params: { id: Id }; result: Conversation };
  'conversations.create': { params: { projectId: Id | null; title?: string }; result: Conversation };
  'conversations.update': { params: { id: Id; patch: ConversationPatch }; result: Conversation };
  'conversations.delete': { params: { id: Id }; result: void };
  'conversations.reorder': { params: { projectId: Id | null; ids: Id[] }; result: void };
  'conversations.saveDraft': { params: { id: Id; draft: string }; result: void };
  'conversations.search': { params: { query: string; limit?: number }; result: SearchHit[] };

  'messages.list': { params: { conversationId: Id }; result: Message[] };

  'chat.send': { params: { conversationId: Id; input: SendInput }; result: SendResult };
  'chat.cancel': { params: { conversationId: Id }; result: { cancelled: boolean } };
  'chat.active': { params: void; result: GenerationState[] };

  'providers.presets': { params: void; result: ProviderPreset[] };
  'providers.list': { params: void; result: Provider[] };
  'providers.create': { params: ProviderInput; result: Provider };
  'providers.update': { params: { id: Id; patch: ProviderPatch }; result: Provider };
  'providers.duplicate': { params: { id: Id }; result: Provider };
  'providers.delete': { params: { id: Id }; result: void };
  'providers.reorder': { params: { ids: Id[] }; result: void };
  'providers.setKey': { params: { id: Id; apiKey: string }; result: Provider };
  'providers.clearKey': { params: { id: Id }; result: Provider };
  'providers.test': { params: ProviderTestInput; result: ConnectionTestResult };
  'providers.fetchCatalog': { params: { id: Id }; result: CatalogModel[] };
  'providers.setModels': { params: { id: Id; models: ProviderModel[] }; result: Provider };
}

export type HarnessMethod = keyof HarnessApi;
export type ParamsOf<M extends HarnessMethod> = HarnessApi[M]['params'];
export type ResultOf<M extends HarnessMethod> = HarnessApi[M]['result'];

/** Événements poussés par le moteur. */
export interface HarnessEvents {
  'settings.changed': Settings;
  'projects.changed': { projects: Project[] };
  'providers.changed': { providers: Provider[] };
  'conversation.changed': { conversation: Conversation };
  'conversation.deleted': { id: Id; projectId: Id | null };
  'conversations.reordered': { projectId: Id | null; ids: Id[] };
  'message.added': { message: Message };
  'message.updated': { message: Message };
  /** Deltas regroupés pendant le streaming ; `message.updated` reste la source de vérité finale. */
  'message.delta': { conversationId: Id; messageId: Id; deltas: MessageDelta[] };
  'generation.state': GenerationState;
  'log.error': { message: string; code: string };
}

export type MessageDelta =
  | { kind: 'text' | 'reasoning'; partIndex: number; text: string }
  | { kind: 'part'; partIndex: number; part: MessagePart }
  | { kind: 'status'; status: MessageStatus; usage?: MessageUsage | null; error?: MessageError | null };

export type HarnessEvent = keyof HarnessEvents;

export interface HarnessClient {
  call<M extends HarnessMethod>(method: M, ...params: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): Promise<ResultOf<M>>;
  on<E extends HarnessEvent>(event: E, listener: (payload: HarnessEvents[E]) => void): () => void;
}
