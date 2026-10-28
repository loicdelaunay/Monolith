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
  AttachmentRef,
  Compaction,
  ContextUsage,
  ContextDetail,
  MessageTemplate,
  QueuedInput,
  UsageRecord,
} from './model.ts';
import type { Settings, SettingsPatch } from './settings.ts';
import type {
  FileProposal,
  LoopReport,
  PermissionDecisionLog,
  PermissionRequest,
  PermissionRule,
  PermissionScope,
  QuestionAnswer,
  ResourceScopeInfo,
  SkillInfo,
  TerminalInfo,
  Question,
  FileContent,
  FileEntry,
  FileReference,
  GitAction,
  GitCommit,
  GitStatusInfo,
  SandboxChange,
  SandboxStatus,
} from './tools.ts';
import type { PlatformCapabilities } from './platform.ts';
import type { AiDetectionResult, AssetInfo, AssetKind, BenchmarkInput, BenchmarkState, ImageGenInput, ImageGenResult, TextTaskInput, TextTaskResult } from './studio.ts';
import type { DownloadState, HardwareInfo, HfFile, HfModel, LocalEngineInfo, LocalModel, ModelEstimate } from './local.ts';
import type { UpdateState } from './updates.ts';
import type { LocalAiComponent, LocalAiProgress, LocalAiStatus } from './local-ai.ts';
import type { BackupInfo, DashboardData, DashboardQuery, DiagnosticsInfo, MaintenanceReport, NotificationItem, ScheduledRun, ScheduledTask, ScheduledTaskInput } from './ops.ts';
import type { CustomSkill, McpImportPreview, McpServer, McpServerInput, McpToolInfo, Memory, MemoryInput, MemoryQuery, MemoryVersion, RagStatus } from './knowledge.ts';

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
  orchestration?: boolean;
}

export interface ProjectInput {
  name: string;
  icon?: string;
  color?: string;
  instructions?: string;
  /** Création : pièces jointes déjà envoyées (attachments.upload) à rattacher au projet. */
  attachmentIds?: Id[];
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
  attachmentIds?: Id[];
  /**
   * `send` (défaut) : refusé si une génération est en cours ;
   * `queue` : envoyé maintenant si la conversation est libre, sinon mis en file ;
   * `steer` : transmis à la prochaine frontière contrôlée de la génération en cours (sinon envoyé maintenant).
   */
  mode?: 'send' | 'queue' | 'steer';
}

export interface SendResult {
  status: 'started' | 'queued' | 'steered';
  userMessageId?: Id;
  assistantMessageId?: Id;
  queuedId?: Id;
}

export interface ResumeResult {
  text: string;
  attachments: AttachmentRef[];
  /** Conversation archivée qui conserve l'historique complet avant la reprise. */
  backupConversationId: Id;
}

export interface GenerationState {
  conversationId: Id;
  messageId: Id;
  status: 'running' | 'retrying' | 'compacting' | 'finished';
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
  'projects.addAttachments': { params: { id: Id; attachmentIds: Id[] }; result: Project };
  'projects.removeAttachment': { params: { id: Id; attachmentId: Id }; result: Project };

  'conversations.list': { params: ConversationListQuery; result: Conversation[] };
  'conversations.get': { params: { id: Id }; result: Conversation };
  'conversations.create': { params: { projectId: Id | null; title?: string }; result: Conversation };
  'conversations.update': { params: { id: Id; patch: ConversationPatch }; result: Conversation };
  'conversations.delete': { params: { id: Id }; result: void };
  'conversations.reorder': { params: { projectId: Id | null; ids: Id[] }; result: void };
  'conversations.saveDraft': { params: { id: Id; draft: string; attachmentIds?: Id[] }; result: void };
  /** Copie la conversation jusqu'au message indiqué inclus (toute la conversation si absent). */
  'conversations.fork': { params: { id: Id; messageId?: Id | null }; result: Conversation };
  /** « Reprendre ici » : sauvegarde l'historique complet, retire ce message et la suite, rend son texte et ses pièces jointes. */
  'conversations.resumeFrom': { params: { id: Id; messageId: Id }; result: ResumeResult };
  'conversations.exportMarkdown': { params: { id: Id; includeReasoning?: boolean }; result: { fileName: string; markdown: string } };
  'conversations.compact': { params: { id: Id }; result: Compaction };
  'conversations.contextUsage': { params: { id: Id }; result: ContextUsage };
  'conversations.contextDetail': { params: { id: Id }; result: ContextDetail };
  'compactions.list': { params: { conversationId: Id }; result: Compaction[] };

  'queue.list': { params: { conversationId: Id }; result: QueuedInput[] };
  'queue.update': { params: { id: Id; text: string }; result: QueuedInput };
  'queue.remove': { params: { id: Id }; result: void };
  'queue.reorder': { params: { conversationId: Id; ids: Id[] }; result: void };
  /** Envoie le premier élément de la file (reprise après une annulation ou une erreur). */
  'queue.sendNext': { params: { conversationId: Id }; result: SendResult };

  'attachments.upload': { params: { name: string; mime: string; dataBase64: string }; result: AttachmentRef };
  /** Fichier ou dossier de ce poste choisi par l'utilisateur : copié dans les données de Monolith. */
  'attachments.fromPath': { params: { path: string }; result: AttachmentRef };
  'attachments.read': { params: { id: Id }; result: { name: string; mime: string; dataBase64: string } };

  'templates.list': { params: void; result: MessageTemplate[] };
  'templates.create': { params: { name: string; content: string }; result: MessageTemplate };
  'templates.update': { params: { id: Id; patch: { name?: string; content?: string } }; result: MessageTemplate };
  'templates.delete': { params: { id: Id }; result: void };

  'usage.list': { params: { limit?: number }; result: UsageRecord[] };

  'resources.get': { params: { conversationId: Id }; result: ResourceScopeInfo };
  'resources.add': { params: { conversationId: Id; kind: 'folder' | 'file'; path: string }; result: ResourceScopeInfo };
  'resources.remove': { params: { conversationId: Id; resourceId: Id }; result: ResourceScopeInfo };
  /** Retour aux ressources par défaut du projet. */
  'resources.reset': { params: { conversationId: Id }; result: ResourceScopeInfo };

  'permissions.rules': { params: { projectId?: Id | null }; result: PermissionRule[] };
  'permissions.addRule': { params: Omit<PermissionRule, 'id' | 'createdAt' | 'origin'> & { origin?: PermissionRule['origin'] }; result: PermissionRule };
  'permissions.removeRule': { params: { id: Id }; result: void };
  'permissions.history': { params: { conversationId?: Id; limit?: number }; result: PermissionDecisionLog[] };
  'permissions.pending': { params: void; result: PermissionRequest[] };
  /** Réponse à une demande d'autorisation ; un refus ou une annulation ne vaut jamais approbation. */
  'permissions.respond': { params: { requestId: string; decision: 'allow' | 'deny'; scope: PermissionScope }; result: void };
  /** Aperçu puis import d'un fichier `permission.json` dans un projet. */
  'permissions.previewImport': { params: { projectId: Id; json: string }; result: { rules: Omit<PermissionRule, 'id' | 'createdAt'>[]; errors: string[] } };
  'permissions.import': { params: { projectId: Id; json: string }; result: PermissionRule[] };

  'questions.answer': { params: { conversationId: Id; callId: string; answers: QuestionAnswer[] | null }; result: void };
  'actions.trigger': { params: { conversationId: Id; messageId: Id; callId: string; actionId: string }; result: { conversationId: Id } };
  'loop.resolve': { params: { conversationId: Id; decision: 'stop' | 'continue' }; result: void };

  'proposals.list': { params: { conversationId: Id }; result: FileProposal[] };
  'proposals.apply': { params: { id: Id }; result: FileProposal };
  'proposals.reject': { params: { id: Id }; result: FileProposal };

  'skills.list': { params: void; result: SkillInfo[] };
  'terminals.list': { params: { conversationId: Id }; result: TerminalInfo[] };
  'terminals.output': { params: { terminalId: string }; result: { output: string; info: TerminalInfo } };
  'terminals.kill': { params: { terminalId: string }; result: void };
  /** Commande lancée par l'utilisateur depuis le panneau (son propre geste : pas de demande d'autorisation). */
  'terminals.run': { params: { conversationId: Id; command: string; cwd?: string }; result: TerminalInfo };

  'files.list': { params: { conversationId: Id; path?: string }; result: { root: string; entries: FileEntry[] } };
  'files.read': { params: { conversationId: Id; path: string }; result: FileContent };
  /** Vérifie des références de fichiers citées dans une réponse (badges cliquables). */
  'files.stat': { params: { conversationId: Id; references: string[] }; result: FileReference[] };
  'files.search': { params: { conversationId: Id; query: string; content?: boolean }; result: { display: string; path: string; line: number | null; text: string | null }[] };

  'git.status': { params: { conversationId: Id }; result: GitStatusInfo };
  'git.fileVersions': { params: { conversationId: Id; path: string; staged: boolean }; result: { before: string; after: string } };
  'git.log': { params: { conversationId: Id; limit?: number }; result: GitCommit[] };
  'git.branches': { params: { conversationId: Id }; result: { current: string | null; branches: string[] } };
  'git.run': { params: { conversationId: Id; action: GitAction; paths?: string[]; message?: string; branch?: string }; result: { output: string } };

  'memory.list': { params: MemoryQuery; result: { items: Memory[]; total: number } };
  'memory.get': { params: { id: Id }; result: Memory & { versions: MemoryVersion[] } };
  'memory.save': { params: MemoryInput; result: Memory };
  'memory.delete': { params: { id: Id }; result: void };

  'mcp.list': { params: void; result: McpServer[] };
  'mcp.create': { params: McpServerInput; result: McpServer };
  'mcp.update': { params: { id: Id; patch: Partial<McpServerInput> }; result: McpServer };
  'mcp.delete': { params: { id: Id }; result: void };
  'mcp.previewImport': { params: { json: string }; result: McpImportPreview };
  'mcp.import': { params: { json: string }; result: McpServer[] };
  'mcp.connect': { params: { id: Id }; result: McpServer };
  'mcp.disconnect': { params: { id: Id }; result: McpServer };
  'mcp.tools': { params: { id: Id }; result: McpToolInfo[] };
  'mcp.conversation': { params: { conversationId: Id }; result: { serverId: Id; enabled: boolean }[] };
  'mcp.setConversation': { params: { conversationId: Id; serverId: Id; enabled: boolean }; result: void };

  'rag.status': { params: { conversationId: Id }; result: RagStatus };
  'rag.index': { params: { conversationId: Id }; result: RagStatus };
  'rag.cancel': { params: { conversationId: Id }; result: void };
  'rag.clear': { params: { conversationId: Id }; result: RagStatus };

  'skills.custom': { params: { projectId?: Id | null }; result: CustomSkill[] };

  'subagents.list': { params: { conversationId: Id }; result: Conversation[] };
  'subagents.removeWorktree': { params: { conversationId: Id }; result: void };

  'sandbox.status': { params: { conversationId: Id }; result: SandboxStatus };
  'sandbox.enable': { params: { conversationId: Id }; result: SandboxStatus };
  'sandbox.diff': { params: { conversationId: Id }; result: SandboxChange[] };
  'sandbox.apply': { params: { conversationId: Id; files: { root: number; path: string }[]; force?: boolean }; result: { applied: number; conflicts: string[] } };
  'sandbox.discard': { params: { conversationId: Id }; result: SandboxStatus };

  'studio.text': { params: TextTaskInput; result: TextTaskResult };
  'studio.detect': { params: { text: string; useModel?: boolean; providerId?: Id | null; model?: string | null }; result: AiDetectionResult };
  'benchmark.start': { params: BenchmarkInput; result: BenchmarkState };
  'benchmark.cancel': { params: void; result: void };
  'benchmark.state': { params: void; result: BenchmarkState | null };
  'images.generate': { params: ImageGenInput; result: ImageGenResult };
  'vision.describe': { params: { attachmentId: Id; prompt?: string }; result: { text: string } };
  'assets.list': { params: void; result: AssetInfo[] };
  'assets.read': { params: { name: string }; result: { kind: AssetKind; content: string } };
  'assets.save': { params: { name: string; kind: AssetKind; content: string }; result: AssetInfo };
  'assets.delete': { params: { name: string }; result: void };
  'assets.png': { params: { name: string; scale?: number; frame?: number }; result: { dataBase64: string; width: number; height: number } };

  'backup.list': { params: void; result: BackupInfo[] };
  'backup.create': { params: void; result: BackupInfo };
  'backup.restore': { params: { name: string }; result: { restartRequired: true } };
  'backup.delete': { params: { name: string }; result: void };
  'backup.path': { params: { name: string }; result: string };

  'dashboard.data': { params: DashboardQuery; result: DashboardData };
  'dashboard.csv': { params: DashboardQuery; result: string };

  'diagnostics.info': { params: void; result: DiagnosticsInfo };
  'diagnostics.export': { params: { extra?: Record<string, unknown> }; result: string };

  'scheduler.list': { params: void; result: ScheduledTask[] };
  'scheduler.save': { params: ScheduledTaskInput; result: ScheduledTask };
  'scheduler.delete': { params: { id: Id }; result: void };
  'scheduler.runNow': { params: { id: Id }; result: ScheduledRun };
  'scheduler.history': { params: { taskId?: Id; limit?: number }; result: ScheduledRun[] };
  'scheduler.preview': { params: { cron: string; timezone: string; count?: number }; result: { next: string[] } };

  'notifications.list': { params: { limit?: number }; result: NotificationItem[] };
  'notifications.markRead': { params: { ids?: Id[] }; result: void };
  'notifications.clear': { params: void; result: void };
  'notifications.add': { params: { level: NotificationItem['level']; title: string; body: string; conversationId?: Id | null }; result: NotificationItem };

  'maintenance.run': { params: void; result: MaintenanceReport };

  'localai.status': { params: void; result: LocalAiStatus };
  /** Télécharge et prépare un composant (après accord de l'utilisateur) ; progression par `localai.progress`. */
  'localai.install': { params: { component: LocalAiComponent }; result: LocalAiStatus };
  'localai.cancel': { params: void; result: void };
  'updates.status': { params: void; result: UpdateState };
  'updates.check': { params: void; result: UpdateState };
  'updates.download': { params: void; result: UpdateState };
  /** Sauvegarde des données, puis installation par l'hôte (redémarrage). */
  'updates.install': { params: void; result: UpdateState };
  'local.hardware': { params: void; result: HardwareInfo };
  'local.models': { params: void; result: LocalModel[] };
  'local.deleteModel': { params: { id: string }; result: void };
  'local.importFile': { params: { path: string }; result: LocalModel };
  'local.estimate': { params: { id: string; contextSize?: number }; result: ModelEstimate };
  'local.hfSearch': { params: { query: string }; result: HfModel[] };
  'local.hfFiles': { params: { repo: string; contextSize?: number }; result: HfFile[] };
  'local.download': { params: { repo: string; file: string }; result: DownloadState };
  'local.downloads': { params: void; result: DownloadState[] };
  'local.cancelDownload': { params: { id: string }; result: void };
  'local.setHfToken': { params: { token: string | null }; result: { hasToken: boolean } };
  'local.engine': { params: void; result: LocalEngineInfo };
  'local.installEngine': { params: { backend: 'cpu' | 'cuda' | 'vulkan' }; result: LocalEngineInfo };
  'local.setEnginePath': { params: { path: string | null }; result: LocalEngineInfo };
  'local.stop': { params: void; result: LocalEngineInfo };
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
  /** Connexion du compte de l'agent (navigateur) : ChatGPT pour OpenAI Subscription. */
  'providers.authenticate': { params: { id: Id }; result: { ok: boolean; message: string } };
  'providers.fetchCatalog': { params: { id: Id }; result: CatalogModel[] };
  /** Réévalue les capacités des modèles enregistrés (catalogue + table documentée) et oublie les niveaux refusés. */
  'providers.refreshModels': { params: { id: Id }; result: Provider };
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
  /** Historique réécrit (reprise, compactage) : l'interface recharge les messages. */
  'conversation.messagesReset': { conversationId: Id };
  'queue.changed': { conversationId: Id; items: QueuedInput[] };
  'templates.changed': { templates: MessageTemplate[] };
  'compaction.added': { compaction: Compaction };
  'permission.requested': PermissionRequest;
  'permission.resolved': { requestId: string; decision: 'allow' | 'deny' };
  'question.requested': { conversationId: Id; messageId: Id; callId: string; questions: Question[] };
  'loop.detected': LoopReport;
  'loop.resolved': { conversationId: Id };
  'proposals.changed': { conversationId: Id; proposals: FileProposal[] };
  'terminal.output': { terminalId: string; conversationId: Id; chunk: string };
  'terminal.changed': { terminal: TerminalInfo };
  'rules.changed': { rules: PermissionRule[] };
  'memory.changed': { id: Id | null };
  'mcp.changed': { servers: McpServer[] };
  'rag.progress': { conversationId: Id; status: RagStatus };
  'benchmark.progress': BenchmarkState;
  'assets.changed': { assets: AssetInfo[] };
  'notification.added': NotificationItem;
  'scheduler.changed': { tasks: ScheduledTask[] };
  'local.download': DownloadState;
  'local.changed': { models: LocalModel[]; engine: LocalEngineInfo };
  'updates.changed': UpdateState;
  'localai.progress': LocalAiProgress;
  'localai.changed': LocalAiStatus;
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
