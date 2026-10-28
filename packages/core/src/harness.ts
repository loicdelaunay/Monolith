import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  APP_NAME,
  APP_VERSION,
  HarnessError,
  type AppInfo,
  type HarnessApi,
  type HarnessMethod,
  type Id,
  type ParamsOf,
  type ProviderKind,
  type ResultOf,
} from '@monolith/contracts';
import { Database } from './storage/database.ts';
import { EventBus } from './events.ts';
import { FileLogger, type Logger } from './log/logger.ts';
import { dataLayout, ensureLayout, isWritableDir, resolveDataDir, writeLocationFile, type DataLayout, type ResolvedDataDir } from './platform/paths.ts';
import { platformCapabilities, type HostKind } from './platform/capabilities.ts';
import { SecretStore, systemProtector, type KeyProtector } from './security/secrets.ts';
import { SettingsService } from './services/settings.ts';
import { ProjectService } from './services/projects.ts';
import { ConversationService } from './services/conversations.ts';
import { MessageService } from './services/messages.ts';
import { ProviderService } from './services/providers.ts';
import { UsageService } from './services/usage.ts';
import { AttachmentService } from './services/attachments.ts';
import { QueueService } from './services/queue.ts';
import { TemplateService } from './services/templates.ts';
import { CompactionService } from './services/compactions.ts';
import { HistoryService } from './services/history.ts';
import { ResourceService } from './services/resources.ts';
import { PermissionEngine } from './permissions/engine.ts';
import { ToolRegistry } from './tools/registry.ts';
import { BUILTIN_TOOLS } from './tools/builtin.ts';
import { TerminalManager } from './tools/terminals.ts';
import { LoopGate, ProposalService, QuestionBroker } from './tools/interactions.ts';
import type { ActionProposal, GitStatusInfo, Message, MessagePart } from '@monolith/contracts';
import { GIT_TOOLS, gitFileVersions, gitStatus, hasGit, repoRoot, runGit } from './tools/git.ts';
import { browserTools, type HostBridge } from './tools/browser.ts';
import { desktopTools } from './desktop/input.ts';
import { UiaDriver, type DesktopDriver } from './desktop/uia-host.ts';
import { UpdateService } from './services/updates.ts';
import { LocalAiService, type LocalAiOptions } from './local/ai-runtime.ts';
import { WorkspaceFiles } from './services/workspace.ts';
import { MemoryService } from './services/memory.ts';
import { RagService } from './services/rag.ts';
import { McpService } from './mcp/service.ts';
import { delegateTool, SubagentService } from './orchestration/subagents.ts';
import { SandboxService } from './orchestration/sandbox.ts';
import { StudioService } from './services/studio.ts';
import { AssetService } from './services/assets.ts';
import { studioTools } from './tools/studio.ts';
import { applyPendingRestore, BackupService, DashboardService, MaintenanceService, NotificationService } from './services/ops.ts';
import { SchedulerService } from './services/scheduler.ts';
import { LocalModelService } from './local/service.ts';
import { LocalAdapter } from './providers/local.ts';
import { redactValue } from './security/redact.ts';
import { readdirSync as readDir, statSync as statOf } from 'node:fs';
import { memoryTools } from './tools/memory.ts';
import { FILE_INDEX_TOOLS } from './tools/file-index.ts';
import { webSearchTool } from './tools/web.ts';
import { WebHttpClient, webHttpTools } from './tools/web-http.ts';
import { discoverSkills, PYTHON_TOOLS, ragTools, skillTools } from './tools/knowledge.ts';
import { HttpClient } from './providers/http.ts';
import { trustSystemCertificates } from './net/certificates.ts';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.ts';
import { GeminiAdapter } from './providers/gemini.ts';
import { GoogleAuth } from './providers/google-auth.ts';
import { AcpAdapter } from './providers/acp.ts';
import { CompositeAdapter } from './providers/composite.ts';
import type { ProviderAdapter } from './providers/adapter.ts';
import { GenerationRunner } from './generation/runner.ts';

export interface HarnessOptions {
  host: HostKind;
  /** Dossier de données déjà résolu, ou paramètres de résolution. */
  data: ResolvedDataDir | { explicit?: string | null; exeDir: string | null };
  /** Contenu du changelog intégré (fourni par l'hôte, embarqué dans le bundle). */
  changelog?: string | (() => string);
  logger?: Logger;
  logToConsole?: boolean;
  /** Remplace la protection système de la clé maître (tests). */
  keyProtector?: KeyProtector | null;
  allowFileKeyFallback?: boolean;
  /** Services de l'hôte graphique (navigateur intégré, captures) ; absent en CLI et sur le serveur. */
  hostBridge?: HostBridge | null;
  /** Tests : adresses de Hugging Face et de l'API GitHub. */
  localEndpoints?: { hfBase?: string; githubApi?: string };
  /** Contrôle du bureau (tests) ; par défaut UI Automation sous Windows avec l'interface de bureau. */
  desktopDriver?: DesktopDriver | null;
  /** IA locale auxiliaire (LANCET Nano, MiniLM) : adresses et Python imposé (tests). */
  localAi?: Omit<LocalAiOptions, 'dir' | 'events' | 'logger'>;
  /** Mises à jour : vérification automatique (version installée) et adresses (tests). */
  updates?: { autoCheck?: boolean; apiBase?: string; downloadBase?: string; repository?: string; installable?: boolean; platform?: NodeJS.Platform };
}

type Handler<M extends HarnessMethod> = (params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;
type Handlers = { [M in HarnessMethod]: Handler<M> };

/**
 * Point d'entrée du moteur. Les trois hôtes (desktop, CLI, serveur) instancient un Harness
 * et appellent `call()` ; aucun ne réimplémente de règle métier.
 */
export class Harness {
  readonly events = new EventBus();
  readonly logger: Logger;
  readonly layout: DataLayout;
  readonly dataDir: ResolvedDataDir;
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly settings: SettingsService;
  readonly projects: ProjectService;
  readonly conversations: ConversationService;
  readonly messages: MessageService;
  readonly providers: ProviderService;
  private readonly adapters: Map<ProviderKind, ProviderAdapter>;
  readonly usage: UsageService;
  readonly attachments: AttachmentService;
  readonly queue: QueueService;
  readonly templates: TemplateService;
  readonly compactions: CompactionService;
  readonly history: HistoryService;
  readonly resources: ResourceService;
  readonly permissions: PermissionEngine;
  readonly tools: ToolRegistry;
  readonly terminals: TerminalManager;
  readonly questions: QuestionBroker;
  readonly loopGate: LoopGate;
  readonly proposals: ProposalService;
  readonly files = new WorkspaceFiles();
  readonly memory: MemoryService;
  readonly rag: RagService;
  readonly mcp: McpService;
  readonly subagents: SubagentService;
  readonly sandbox: SandboxService;
  readonly studio: StudioService;
  readonly webHttp: WebHttpClient;
  readonly local: LocalModelService;
  readonly backups: BackupService;
  readonly updates: UpdateService;
  readonly localAi: LocalAiService;
  readonly dashboard: DashboardService;
  readonly notifications: NotificationService;
  readonly scheduler: SchedulerService;
  readonly maintenance: MaintenanceService;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private cpuSample = { at: Date.now(), usage: process.cpuUsage() };
  readonly assets: AssetService;
  hostBridge: HostBridge | null;
  private desktop: DesktopDriver | null | undefined;
  readonly generation: GenerationRunner;
  private readonly handlers: Handlers;
  private readonly testControllers = new Set<AbortController>();
  private closed = false;

  constructor(private readonly options: HarnessOptions) {
    this.dataDir = 'dir' in options.data ? options.data : resolveDataDir(options.data);
    this.layout = dataLayout(this.dataDir.dir);
    ensureLayout(this.layout);
    this.logger = options.logger ?? new FileLogger({ dir: this.layout.logs, console: options.logToConsole ?? false });
    this.logger.info('app', 'Démarrage du moteur', { host: options.host, version: APP_VERSION, dataDir: this.dataDir.dir, source: this.dataDir.source });

    // Restauration demandée lors de la session précédente : appliquée avant l'ouverture de la base.
    const restored = applyPendingRestore(this.layout.database, this.layout.backups);
    this.db = Database.open({ path: this.layout.database, backupDir: this.layout.backups, logger: this.logger });
    if (restored) this.logger.info('app', 'Sauvegarde restaurée', { name: restored });
    this.secrets = new SecretStore({
      db: this.db,
      keysDir: this.layout.keys,
      logger: this.logger,
      protector: options.keyProtector === undefined ? systemProtector() : options.keyProtector,
      allowFileFallback: options.allowFileKeyFallback ?? false,
    });

    // Autorités du système (entreprise, antivirus, certificats installés) en plus de celles de Node, comme la v1.
    const systemCertificates = trustSystemCertificates();
    if (systemCertificates) this.logger.info('network', 'Autorités de certification du système ajoutées', { count: systemCertificates });
    const http = new HttpClient(this.logger);
    const googleAuth = new GoogleAuth(http);
    const composite = new CompositeAdapter();
    const openai = new OpenAICompatibleAdapter('openai-compatible', http);
    const adapters = new Map<ProviderKind, ProviderAdapter>([
      ['openai-compatible', openai],
      ['local', new LocalAdapter(() => this.local, openai)],
      ['deepseek', new OpenAICompatibleAdapter('deepseek', http)],
      ['gemini', new GeminiAdapter('gemini', http, googleAuth)],
      ['vertex', new GeminiAdapter('vertex', http, googleAuth)],
      ['acp', new AcpAdapter()],
      ['composite', composite],
    ]);
    this.adapters = adapters;

    this.settings = new SettingsService(this.db, this.events);
    this.projects = new ProjectService(this.db, this.events);
    this.conversations = new ConversationService(this.db, this.events);
    this.messages = new MessageService(this.db);
    this.providers = new ProviderService(this.db, this.events, this.secrets, adapters);
    composite.resolver = async (id) => {
      const r = await this.providers.connection(id);
      return { adapter: r.adapter, conn: r.conn, providerName: r.provider.name };
    };
    this.usage = new UsageService(this.db);
    this.attachments = new AttachmentService(this.db, this.layout.attachments);
    this.queue = new QueueService(this.db, this.events);
    this.templates = new TemplateService(this.db, this.events);
    this.compactions = new CompactionService(this.db, this.events);
    // Base, clés et journaux de l'application : jamais accessibles aux outils, même dans une racine.
    this.resources = new ResourceService(this.db, this.projects, this.layout.conversations, [this.layout.keys, this.layout.database, `${this.layout.database}-wal`, `${this.layout.database}-shm`, this.layout.logs, this.layout.backups]);
    this.permissions = new PermissionEngine(this.db, this.events);
    this.hostBridge = options.hostBridge ?? null;
    this.tools = new ToolRegistry([
      ...BUILTIN_TOOLS,
      ...GIT_TOOLS,
      ...browserTools(
        () => this.hostBridge,
        (_ctx, name, data) => this.attachments.storeImage(name, data).id,
      ),
      ...memoryTools(() => this.memory),
      ...FILE_INDEX_TOOLS,
      webSearchTool(() => this.webHttp),
      ...webHttpTools(() => this.webHttp),
      ...ragTools(() => this.rag),
      ...skillTools(this.layout.skills),
      ...PYTHON_TOOLS,
      delegateTool(() => this.subagents, () => this.settings.get().subagents.presets),
      ...studioTools(() => this.studio, () => this.assets, () => this.attachments),
      ...desktopTools(() => this.desktopDriver()),
    ]);
    this.desktop = options.desktopDriver;
    this.webHttp = new WebHttpClient(join(this.layout.workspace, 'web'));
    this.local = new LocalModelService({ dir: join(this.layout.root, 'local'), events: this.events, settings: () => this.settings.get(), secrets: this.secrets, logger: this.logger, ...(options.localEndpoints ?? {}) });
    this.studio = new StudioService({ db: this.db, providers: this.providers, usage: this.usage, attachments: this.attachments, events: this.events, http, settings: () => this.settings.get() });
    this.assets = new AssetService(join(this.layout.workspace, 'assets'), this.events);
    this.memory = new MemoryService(this.db, this.events);
    this.localAi = new LocalAiService({ dir: join(this.layout.root, 'local', 'ai'), events: this.events, logger: this.logger, ...(options.localAi ?? {}) });
    this.rag = new RagService(this.db, this.events, this.providers, http, () => this.settings.get(), this.localAi);
    this.sandbox = new SandboxService(this.resources, join(this.layout.workspace, 'sandboxes'));
    this.mcp = new McpService(this.db, this.events, this.secrets, this.tools, this.logger, (_ctx, name, data) => this.attachments.storeImage(name, data).id);
    // Outils du navigateur et des captures : seulement si l'hôte les fournit réellement.
    this.tools.hostFilter = (t) => !(t.family === 'browser' || t.family === 'desktop') || this.hostBridge !== null;
    this.terminals = new TerminalManager(this.events);
    this.questions = new QuestionBroker(this.events);
    this.loopGate = new LoopGate(this.events);
    this.proposals = new ProposalService(this.db, this.events);
    this.generation = new GenerationRunner({
      events: this.events,
      logger: this.logger,
      settings: this.settings,
      projects: this.projects,
      conversations: this.conversations,
      messages: this.messages,
      providers: this.providers,
      usage: this.usage,
      queue: this.queue,
      attachments: this.attachments,
      compactions: this.compactions,
      tools: this.tools,
      permissions: this.permissions,
      localAi: this.localAi,
      resources: this.resources,
      terminals: this.terminals,
      questions: this.questions,
      loopGate: this.loopGate,
      proposals: this.proposals,
      host: options.host,
      memory: this.memory,
      mcp: this.mcp,
      customSkills: (roots, settings) => discoverSkills(this.layout.skills, roots, settings),
      vision: { cached: (id) => this.studio.cachedDescription(id), ensure: (id, signal) => this.studio.ensureDescription(id, signal) },
    });
    this.subagents = new SubagentService({
      conversations: this.conversations,
      messages: this.messages,
      resources: this.resources,
      settings: this.settings,
      generation: () => this.generation,
      worktreesDir: join(this.layout.workspace, 'worktrees'),
      logger: this.logger,
    });
    this.backups = new BackupService(this.db, this.layout.backups);
    this.dashboard = new DashboardService(this.db);
    this.notifications = new NotificationService(this.db, this.events);
    this.updates = new UpdateService({
      dir: join(this.layout.root, 'updates'),
      current: APP_VERSION,
      events: this.events,
      logger: this.logger,
      settings: () => this.settings.get(),
      installable: this.updateInstallable(),
      install: async (job) => {
        if (!this.hostBridge) throw new HarnessError('unavailable', 'Installation possible seulement depuis l’interface de bureau.');
        await this.hostBridge.request('app.installUpdate', { ...job });
      },
      backup: () => void this.backups.create(),
      notify: (title, body) => void this.notifications.add('info', title, body),
      ...(options.updates?.apiBase ? { apiBase: options.updates.apiBase } : {}),
      ...(options.updates?.downloadBase ? { downloadBase: options.updates.downloadBase } : {}),
      ...(options.updates?.repository ? { repository: options.updates.repository } : {}),
      ...(options.updates?.platform ? { platform: options.updates.platform } : {}),
    });
    if (options.updates?.autoCheck) this.updates.start();
    this.scheduler = new SchedulerService({ db: this.db, events: this.events, conversations: this.conversations, generation: () => this.generation, notifications: this.notifications, notify: () => this.settings.get().notifications.onScheduled, logger: this.logger });
    this.maintenance = new MaintenanceService({
      db: this.db,
      settings: () => this.settings.get(),
      attachmentsDir: this.layout.attachments,
      isGenerating: (id) => this.generation.isActive(id),
      deleteConversation: (id) => this.conversations.delete(id),
      archiveConversation: (id) => this.conversations.update(id, { archived: true }),
    });
    if (!this.db.info.readOnly) {
      this.scheduler.start();
      // Maintenance : peu après le démarrage, puis une fois par jour.
      const runMaintenance = () => {
        try {
          const r = this.maintenance.run();
          if (r.archived || r.deleted || r.attachments) this.logger.info('maintenance', 'Maintenance automatique', r);
        } catch (e) {
          this.logger.warn('maintenance', 'Maintenance en échec', { error: (e as Error).message });
        }
      };
      const first = setTimeout(runMaintenance, 60_000);
      first.unref?.();
      this.maintenanceTimer = setInterval(runMaintenance, 86_400_000);
      this.maintenanceTimer.unref?.();
    }
    this.history = new HistoryService({
      db: this.db,
      events: this.events,
      conversations: this.conversations,
      messages: this.messages,
      compactions: this.compactions,
      projects: this.projects,
      isGenerating: (id) => this.generation.isActive(id),
    });

    if (!this.db.info.readOnly) {
      const recovered = this.messages.recoverInterrupted();
      if (recovered) this.logger.info('generation', 'Générations interrompues marquées', { count: recovered });
      this.db.run("UPDATE usage SET status = 'incomplete' WHERE finished_at IS NULL AND status = 'incomplete'");
    }
    this.handlers = this.createHandlers();
  }

  async call<M extends HarnessMethod>(method: M, ...args: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): Promise<ResultOf<M>> {
    const params = args[0] as ParamsOf<M>;
    if (this.closed) throw new HarnessError('unavailable', 'Moteur arrêté');
    const handler = this.handlers[method] as Handler<M> | undefined;
    if (!handler) throw new HarnessError('invalid_argument', `Méthode inconnue : ${String(method)}`);
    try {
      return await handler(params);
    } catch (error) {
      if (!(error instanceof HarnessError)) this.logger.error('rpc', `Erreur interne dans ${method}`, error);
      throw error;
    }
  }

  isMethod(name: string): name is HarnessMethod {
    return Object.hasOwn(this.handlers, name);
  }

  async info(): Promise<AppInfo> {
    return {
      name: APP_NAME,
      version: APP_VERSION,
      host: this.options.host,
      platform: process.platform,
      arch: process.arch,
      dataDir: this.dataDir.dir,
      portable: this.dataDir.portable,
      dataDirSource: this.dataDir.source,
      databasePath: this.layout.database,
      schemaVersion: this.db.info.schemaVersion,
      secretProtection: await this.secrets.info(),
      capabilities: platformCapabilities(this.options.host),
      nodeVersion: process.versions.node,
      sqliteVersion: this.db.info.sqliteVersion,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.stop();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.generation.cancelAll();
    this.terminals.killAll();
    for (const c of this.testControllers) c.abort();
    await this.generation.idle();
    // Processus d'agents externes (ACP) et serveurs MCP arrêtés avec le moteur.
    for (const a of this.adapters.values()) await a.dispose?.();
    await this.mcp.dispose();
    await this.webHttp.dispose();
    await this.local.dispose();
    await this.desktop?.dispose();
    this.updates.dispose();
    this.localAi.dispose();
    this.db.close();
    this.logger.info('app', 'Moteur arrêté');
  }

  /** Installation des mises à jour : version portable Windows lancée par l'interface de bureau. */
  private updateInstallable(): { ok: boolean; reason: string | null } {
    if (this.options.updates?.installable !== undefined) return { ok: this.options.updates.installable, reason: this.options.updates.installable ? null : 'Installation désactivée.' };
    if (this.options.host !== 'desktop') return { ok: false, reason: 'Installation depuis l’interface de bureau uniquement.' };
    if (process.platform !== 'win32') return { ok: false, reason: 'Installation automatique : version portable Windows uniquement ; téléchargez le paquet depuis la page de la version.' };
    const exeDir = 'exeDir' in this.options.data ? this.options.data.exeDir : null;
    if (!exeDir) return { ok: false, reason: 'Version installée (programme d’installation) ou de développement : téléchargez le nouvel installateur depuis la page de la version.' };
    return { ok: true, reason: null };
  }

  /** Assistant UI Automation démarré à la première utilisation ; les fenêtres de Monolith sont exclues. */
  private desktopDriver(): DesktopDriver | null {
    if (this.desktop === undefined) {
      this.desktop = this.options.host === 'desktop' && process.platform === 'win32' ? new UiaDriver(join(this.layout.workspace, 'desktop'), [process.pid, process.ppid]) : null;
    }
    return this.desktop;
  }

  private withAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    this.testControllers.add(c);
    return fn(c.signal).finally(() => this.testControllers.delete(c));
  }

  /**
   * Proposition d'action : déclenchable une seule fois, sans permission supplémentaire.
   * La consigne part comme un message ordinaire (file d'attente si une génération est en cours).
   */
  private async triggerAction(conversationId: Id, messageId: Id, callId: string, actionId: string): Promise<{ conversationId: Id }> {
    const message: Message = this.messages.get(messageId);
    if (message.conversationId !== conversationId) throw new HarnessError('invalid_argument', 'Message d’une autre conversation');
    const index = message.parts.findIndex((p) => p.type === 'tool' && p.call.id === callId && p.call.display?.kind === 'actions');
    if (index === -1) throw new HarnessError('not_found', 'Propositions introuvables');
    const part = message.parts[index] as Extract<MessagePart, { type: 'tool' }>;
    const display = part.call.display as { kind: 'actions'; actions: ActionProposal[] };
    const action = display.actions.find((a) => a.id === actionId);
    if (!action) throw new HarnessError('not_found', 'Action introuvable');
    if (action.triggered) throw new HarnessError('conflict', 'Cette action a déjà été déclenchée');
    action.triggered = true;
    this.messages.saveParts(messageId, message.parts);
    this.events.emit('message.updated', { message: this.messages.get(messageId) });

    const source = this.conversations.get(conversationId);
    let target = conversationId;
    if (action.kind === 'agent' || action.kind === 'new_chat') {
      const s = this.settings.get();
      const created = this.conversations.create(source.projectId, action.title, { providerId: source.providerId ?? s.chat.defaultProviderId, model: source.providerId !== null ? source.model : s.chat.defaultModel, reasoningLevel: source.reasoningLevel });
      // Un agent lancé depuis une proposition n'obtient jamais plus de droits que la conversation d'origine.
      const agentMode = source.mode === 'agent' ? source.agentMode : 'plan';
      this.conversations.update(created.id, { mode: action.kind === 'agent' ? 'agent' : 'chat', agentMode });
      target = created.id;
    }
    await this.generation.send(target, { text: action.instructions, mode: 'queue' });
    return { conversationId: target };
  }

  /** Diagnostics : moteur (mémoire, CPU), stockage, protection des secrets, journaux récents (expurgés). */
  private async diagnostics() {
    const dirSize = (dir: string, depth = 0): number => {
      let total = 0;
      try {
        for (const name of readDir(dir)) {
          const st = statOf(`${dir}/${name}`, { throwIfNoEntry: false });
          if (!st) continue;
          total += st.isDirectory() ? (depth < 6 ? dirSize(`${dir}/${name}`, depth + 1) : 0) : st.size;
        }
      } catch {
        /* dossier absent */
      }
      return total;
    };
    const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
    const fileSize = (p: string) => statOf(p, { throwIfNoEntry: false })?.size ?? 0;
    const usage = process.cpuUsage(this.cpuSample.usage);
    const elapsed = Math.max(1, Date.now() - this.cpuSample.at);
    this.cpuSample = { at: Date.now(), usage: process.cpuUsage() };
    const mem = process.memoryUsage();
    const secrets = await this.secrets.info();
    return {
      app: { version: APP_VERSION, platform: process.platform, arch: process.arch, node: process.versions.node, dataDir: this.dataDir.dir, portable: this.dataDir.portable, schemaVersion: this.db.info.schemaVersion, readOnly: this.db.info.readOnly },
      engine: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), cpuPercent: Math.round(((usage.user + usage.system) / 1000 / elapsed) * 1000) / 10, uptimeSec: Math.round(process.uptime()) },
      storage: { databaseMb: mb(fileSize(this.layout.database) + fileSize(`${this.layout.database}-wal`)), attachmentsMb: mb(dirSize(this.layout.attachments)), workspaceMb: mb(dirSize(this.layout.workspace)), logsMb: mb(dirSize(this.layout.logs)), backupsMb: mb(dirSize(this.layout.backups)) },
      secrets: JSON.stringify(secrets),
      logs: this.logger instanceof FileLogger ? this.logger.recent(200).map((e) => ({ time: e.time, level: e.level, category: e.category, message: e.message })) : [],
    };
  }

  /** Premier dépôt Git parmi les racines de la conversation. */
  private async gitRoot(conversationId: Id): Promise<string | null> {
    const { scope } = this.resources.scope(conversationId);
    for (const r of scope.roots) {
      const root = await repoRoot(r);
      if (root) {
        try {
          scope.resolve(root);
          return root;
        } catch {
          // Dépôt parent hors de la portée : on s'en tient au dossier autorisé.
          return null;
        }
      }
    }
    return null;
  }

  private async requireGitRoot(conversationId: Id): Promise<string> {
    const root = await this.gitRoot(conversationId);
    if (!root) throw new HarnessError('unavailable', 'Aucun dépôt Git dans les ressources de cette conversation.');
    return root;
  }

  /** Retire les références à une connexion supprimée (réglages par défaut, conversations). */
  private forgetProvider(id: Id): void {
    const s = this.settings.get();
    if (s.chat.defaultProviderId === id) this.settings.update({ chat: { defaultProviderId: null, defaultModel: null } });
  }

  private createHandlers(): Handlers {
    const changelog = () => {
      const c = this.options.changelog;
      if (typeof c === 'function') return c();
      if (typeof c === 'string') return c;
      try {
        return readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      'app.info': () => this.info(),
      'app.changelog': () => changelog(),
      'app.setDataLocation': (p) => {
        const dir = p?.dir ?? null;
        if (dir !== null && (typeof dir !== 'string' || !isAbsolute(dir))) throw new HarnessError('invalid_argument', 'Chemin absolu attendu');
        if (dir !== null && !isWritableDir(dir)) throw new HarnessError('invalid_argument', `Dossier non inscriptible : ${dir}`);
        const exeDir = 'exeDir' in this.options.data ? this.options.data.exeDir : null;
        const file = writeLocationFile(exeDir, dir);
        this.logger.info('app', 'Emplacement des données modifié (effet au redémarrage)', { dir, file });
        return { file, restartRequired: true as const };
      },

      'settings.get': () => this.settings.get(),
      'settings.update': (p) => {
        // Un fournisseur par défaut supprimé entre-temps n'est jamais réintroduit.
        const id = p?.chat?.defaultProviderId;
        if (typeof id === 'number' && !this.db.get('SELECT 1 AS x FROM providers WHERE id = ?', id)) p = { ...p, chat: { ...p.chat, defaultProviderId: null, defaultModel: null } };
        return this.settings.update(p);
      },
      'settings.reset': (p) => this.settings.reset(p?.section),

      'projects.list': () => this.projects.list(),
      'projects.create': (p) => this.projects.create(p),
      'projects.update': (p) => this.projects.update(p.id, p.patch),
      'projects.delete': (p) => {
        const ids = this.conversations.list({ projectId: p.id, includeArchived: true }).map((c) => c.id);
        if (p.deleteConversations && ids.some((id) => this.generation.isActive(id))) {
          throw new HarnessError('busy', 'Une génération est en cours dans ce projet ; annulez-la avant de supprimer.');
        }
        this.projects.delete(p.id, p.deleteConversations);
        for (const id of ids) {
          if (p.deleteConversations) this.events.emit('conversation.deleted', { id, projectId: p.id });
          else this.events.emit('conversation.changed', { conversation: this.conversations.get(id) });
        }
      },
      'projects.reorder': (p) => this.projects.reorder(p.ids),
      'projects.addFolder': (p) => this.projects.addFolder(p.id, p.path, p.label),
      'projects.removeFolder': (p) => this.projects.removeFolder(p.folderId),

      'conversations.list': (p) => this.conversations.list(p ?? {}),
      'conversations.get': (p) => this.conversations.get(p.id),
      'conversations.create': (p) => {
        const s = this.settings.get();
        return this.conversations.create(p.projectId, p.title, {
          providerId: s.chat.defaultProviderId,
          model: s.chat.defaultModel,
          reasoningLevel: s.chat.defaultReasoningLevel,
        });
      },
      'conversations.update': (p) => this.conversations.update(p.id, p.patch),
      'conversations.delete': (p) => {
        this.generation.cancel(p.id);
        this.conversations.delete(p.id);
      },
      'conversations.reorder': (p) => this.conversations.reorder(p.projectId, p.ids),
      'conversations.saveDraft': (p) => this.conversations.saveDraft(p.id, p.draft, p.attachmentIds === undefined ? undefined : this.attachments.resolve(p.attachmentIds)),
      'conversations.fork': (p) => this.history.fork(p.id, p.messageId ?? null),
      'conversations.resumeFrom': (p) => this.history.resumeFrom(p.id, p.messageId),
      'conversations.exportMarkdown': (p) => this.history.exportMarkdown(p.id, p.includeReasoning === true),
      'conversations.compact': (p) => this.generation.compact(p.id),
      'conversations.contextUsage': (p) => this.generation.contextUsage(p.id),
      'compactions.list': (p) => this.compactions.list(p.conversationId),

      'queue.list': (p) => this.queue.list(p.conversationId),
      'queue.update': (p) => this.queue.update(p.id, p.text),
      'queue.remove': (p) => this.queue.remove(p.id),
      'queue.reorder': (p) => this.queue.reorder(p.conversationId, p.ids),
      'queue.sendNext': (p) => this.generation.sendNext(p.conversationId),

      'attachments.upload': (p) => this.attachments.upload(p.name, p.mime, p.dataBase64),
      'attachments.read': (p) => {
        const ref = this.attachments.get(p.id);
        return { name: ref.name, mime: ref.mime, dataBase64: this.attachments.bytes(p.id).toString('base64') };
      },

      'templates.list': () => this.templates.list(),
      'templates.create': (p) => this.templates.create(p.name, p.content),
      'templates.update': (p) => this.templates.update(p.id, p.patch ?? {}),
      'templates.delete': (p) => this.templates.delete(p.id),

      'usage.list': (p) => this.usage.list(Math.min(5000, Math.max(1, p?.limit ?? 500))),

      'resources.get': (p) => this.resources.get(p.conversationId, this.settings.get().agent.readInstructionFiles),
      'resources.add': (p) => {
        this.resources.add(p.conversationId, p.kind === 'file' ? 'file' : 'folder', p.path);
        return this.resources.get(p.conversationId, this.settings.get().agent.readInstructionFiles);
      },
      'resources.remove': (p) => {
        this.resources.remove(p.conversationId, p.resourceId);
        return this.resources.get(p.conversationId, this.settings.get().agent.readInstructionFiles);
      },
      'resources.reset': (p) => {
        this.resources.reset(p.conversationId);
        return this.resources.get(p.conversationId, this.settings.get().agent.readInstructionFiles);
      },

      'permissions.rules': (p) => this.permissions.rules(p?.projectId),
      'permissions.addRule': (p) => this.permissions.addRule(p),
      'permissions.removeRule': (p) => this.permissions.removeRule(p.id),
      'permissions.history': (p) => this.permissions.history(p?.conversationId, Math.min(2000, Math.max(1, p?.limit ?? 200))),
      'permissions.pending': () => this.permissions.listPending(),
      'permissions.respond': (p) => this.permissions.respond(p.requestId, p.decision, p.scope),
      'permissions.previewImport': (p) => {
        this.projects.get(p.projectId);
        return this.permissions.parseImport(p.projectId, p.json);
      },
      'permissions.import': (p) => {
        this.projects.get(p.projectId);
        const parsed = this.permissions.parseImport(p.projectId, p.json);
        if (parsed.errors.length) throw new HarnessError('invalid_argument', `Import refusé : ${parsed.errors.join(' ; ')}`);
        return this.db.transaction(() => parsed.rules.map((r) => this.permissions.addRule(r)));
      },

      'questions.answer': (p) => this.questions.answer(p.conversationId, p.callId, p.answers),
      'actions.trigger': (p) => this.triggerAction(p.conversationId, p.messageId, p.callId, p.actionId),
      'loop.resolve': (p) => this.loopGate.resolve(p.conversationId, p.decision),

      'proposals.list': (p) => this.proposals.list(p.conversationId),
      'proposals.apply': (p) => this.proposals.apply(p.id),
      'proposals.reject': (p) => this.proposals.reject(p.id),

      'skills.list': () => this.tools.skills(this.settings.get(), this.options.host),
      'terminals.list': (p) => this.terminals.list(p.conversationId),
      'terminals.output': (p) => ({ output: this.terminals.output(p.terminalId), info: { ...this.terminals.get(p.terminalId).info } }),
      'terminals.kill': (p) => this.terminals.kill(p.terminalId),
      'terminals.run': (p) => {
        const { scope } = this.resources.scope(p.conversationId);
        const cwd = scope.resolve(p.cwd ?? '.');
        if (typeof p.command !== 'string' || !p.command.trim()) throw new HarnessError('invalid_argument', 'Commande vide');
        return { ...this.terminals.start(p.conversationId, p.command, cwd).info };
      },

      'files.list': (p) => this.files.list(this.resources.scope(p.conversationId).scope, p.path),
      'files.read': (p) => this.files.read(this.resources.scope(p.conversationId).scope, p.path),
      'files.stat': (p) => this.files.stat(this.resources.scope(p.conversationId).scope, Array.isArray(p.references) ? p.references.map(String) : []),
      'files.search': (p) => this.files.search(this.resources.scope(p.conversationId).scope, String(p.query ?? ''), p.content === true),

      'git.status': async (p) => {
        const unavailable = (reason: string): GitStatusInfo => ({ available: false, reason, root: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] });
        if (!(await hasGit())) return unavailable('git n’est pas installé ou introuvable dans le PATH.');
        const root = await this.gitRoot(p.conversationId);
        if (!root) return unavailable('Aucun dépôt Git dans les ressources de cette conversation.');
        return { available: true, ...(await gitStatus(root)) };
      },
      'git.fileVersions': async (p) => {
        const root = await this.requireGitRoot(p.conversationId);
        // Chemin relatif au dépôt, vérifié contre la portée (pas de sortie par « .. »).
        const full = this.resources.scope(p.conversationId).scope.resolve(join(root, String(p.path)));
        return gitFileVersions(root, relative(root, full).split(sep).join('/'), p.staged === true);
      },
      'git.log': async (p) => {
        const root = await this.requireGitRoot(p.conversationId);
        const r = await runGit(root, ['log', `-n${Math.min(500, Math.max(1, p.limit ?? 100))}`, '--date=iso-strict', '--pretty=format:%h%x1f%ad%x1f%an%x1f%s']);
        if (r.code !== 0) return [];
        return r.stdout.split('\n').filter(Boolean).map((l) => {
          const [hash, date, author, subject] = l.split('\x1f');
          return { hash: hash ?? '', date: date ?? '', author: author ?? '', subject: subject ?? '' };
        });
      },
      'git.branches': async (p) => {
        const root = await this.requireGitRoot(p.conversationId);
        const r = await runGit(root, ['branch', '--format=%(HEAD)%(refname:short)']);
        const lines = r.stdout.split('\n').filter(Boolean);
        return { current: lines.find((l) => l.startsWith('*'))?.slice(1) ?? null, branches: lines.map((l) => l.slice(1)) };
      },
      'memory.list': (p) => this.memory.list(p ?? {}),
      'memory.get': (p) => this.memory.get(p.id),
      'memory.save': (p) => this.memory.save(p, { source: 'user' }),
      'memory.delete': (p) => this.memory.delete(p.id),

      'mcp.list': () => this.mcp.list(),
      'mcp.create': (p) => this.mcp.create(p),
      'mcp.update': (p) => this.mcp.update(p.id, p.patch),
      'mcp.delete': (p) => this.mcp.delete(p.id),
      'mcp.previewImport': (p) => this.mcp.previewImport(String(p.json ?? '')),
      'mcp.import': (p) => this.mcp.import(String(p.json ?? '')),
      'mcp.connect': (p) => this.mcp.connect(p.id),
      'mcp.disconnect': (p) => this.mcp.disconnect(p.id),
      'mcp.tools': (p) => this.mcp.get(p.id).tools,
      'mcp.conversation': (p) => this.mcp.conversation(p.conversationId),
      'mcp.setConversation': (p) => this.mcp.setConversation(p.conversationId, p.serverId, p.enabled === true),

      'rag.status': (p) => this.rag.status(p.conversationId, this.resources.scope(p.conversationId).scope.roots),
      'rag.index': (p) => this.rag.index(p.conversationId, this.resources.scope(p.conversationId).scope.roots),
      'rag.cancel': (p) => this.rag.cancel(p.conversationId),
      'rag.clear': (p) => {
        const roots = this.resources.scope(p.conversationId).scope.roots;
        this.rag.clear(roots);
        return this.rag.status(p.conversationId, roots);
      },

      'skills.custom': (p) => {
        const roots = p?.projectId ? this.projects.get(p.projectId).folders.map((f) => f.path) : [];
        return discoverSkills(this.layout.skills, roots, this.settings.get());
      },

      'subagents.list': (p) => this.conversations.children(p.conversationId),
      'subagents.removeWorktree': (p) => this.subagents.removeWorktree(p.conversationId),

      'sandbox.status': (p) => this.sandbox.status(p.conversationId),
      'sandbox.enable': (p) => {
        if (this.generation.isActive(p.conversationId)) throw new HarnessError('busy', 'Génération en cours : attendez la fin pour activer la sandbox');
        return this.sandbox.enable(p.conversationId);
      },
      'sandbox.diff': (p) => this.sandbox.diff(p.conversationId),
      'sandbox.apply': (p) => this.sandbox.apply(p.conversationId, Array.isArray(p.files) ? p.files : [], p.force === true),
      'sandbox.discard': (p) => {
        if (this.generation.isActive(p.conversationId)) throw new HarnessError('busy', 'Génération en cours : attendez la fin');
        return this.sandbox.discard(p.conversationId);
      },

      'studio.text': (p) => this.withAbort((signal) => this.studio.text(p, signal)),
      'studio.detect': (p) => this.withAbort((signal) => this.studio.detect(p, signal)),
      'benchmark.start': (p) => this.studio.startBenchmark(p),
      'benchmark.cancel': () => this.studio.cancelBenchmark(),
      'benchmark.state': () => this.studio.benchmarkState(),
      'images.generate': (p) => this.withAbort((signal) => this.studio.generateImage(p, signal)),
      'vision.describe': async (p) => ({ text: (await this.withAbort((signal) => this.studio.describe(p.attachmentId, p.prompt ?? null, signal))).text }),
      'assets.list': () => this.assets.list(),
      'assets.read': (p) => this.assets.read(String(p.name)),
      'assets.save': (p) => this.assets.save(String(p.name), p.kind, String(p.content ?? '')),
      'assets.delete': (p) => this.assets.delete(String(p.name)),
      'assets.png': (p) => {
        const r = this.assets.png(String(p.name), p.scale ?? 8, p.frame ?? 0);
        return { dataBase64: r.png.toString('base64'), width: r.width, height: r.height };
      },

      'backup.list': () => this.backups.list(),
      'backup.create': () => this.backups.create(),
      'backup.restore': (p) => this.backups.restore(String(p.name)),
      'backup.delete': (p) => this.backups.delete(String(p.name)),
      'backup.path': (p) => this.backups.path(String(p.name)),

      'dashboard.data': (p) => this.dashboard.data(p ?? {}),
      'dashboard.csv': (p) => this.dashboard.csv(p ?? {}),

      'diagnostics.info': () => this.diagnostics(),
      'diagnostics.export': async (p) => {
        const info = await this.diagnostics();
        return JSON.stringify(redactValue({ generatedAt: new Date().toISOString(), ...info, host: p?.extra ?? null }), null, 2);
      },

      'scheduler.list': () => this.scheduler.list(),
      'scheduler.save': (p) => this.scheduler.save(p),
      'scheduler.delete': (p) => this.scheduler.delete(p.id),
      'scheduler.runNow': (p) => this.scheduler.run(p.id),
      'scheduler.history': (p) => this.scheduler.history(p?.taskId, p?.limit),
      'scheduler.preview': (p) => this.scheduler.preview(String(p.cron ?? ''), String(p.timezone ?? 'UTC'), p.count),

      'notifications.list': (p) => this.notifications.list(p?.limit),
      'notifications.markRead': (p) => this.notifications.markRead(p?.ids),
      'notifications.clear': () => this.notifications.clear(),
      'notifications.add': (p) => this.notifications.add(['info', 'success', 'warning', 'error'].includes(p.level) ? p.level : 'info', String(p.title ?? ''), String(p.body ?? ''), p.conversationId ?? null),

      'maintenance.run': () => this.maintenance.run(),

      'local.hardware': () => this.local.hardware(),
      'local.models': () => this.local.models(),
      'local.deleteModel': (p) => this.local.deleteModel(String(p.id)),
      'local.importFile': (p) => this.local.importFile(String(p.path)),
      'local.estimate': (p) => this.local.estimate(String(p.id), p.contextSize),
      'local.hfSearch': (p) => this.local.hfSearch(String(p.query ?? '')),
      'local.hfFiles': (p) => this.local.hfFiles(String(p.repo), p.contextSize),
      'local.download': (p) => this.local.download(String(p.repo), String(p.file)),
      'local.downloads': () => this.local.listDownloads(),
      'local.cancelDownload': (p) => this.local.cancelDownload(String(p.id)),
      'local.setHfToken': (p) => this.local.setHfToken(p.token ?? null),
      'localai.status': () => this.localAi.status(),
      'localai.install': (p) => this.localAi.install(p.component),
      'localai.cancel': () => this.localAi.cancel(),
      'updates.status': () => this.updates.state(),
      'updates.check': () => this.updates.check(),
      'updates.download': () => this.updates.download(),
      'updates.install': () => this.updates.install('now'),
      'local.engine': () => this.local.engine(),
      'local.installEngine': (p) => this.local.installEngine(p.backend === 'cuda' || p.backend === 'vulkan' ? p.backend : 'cpu'),
      'local.setEnginePath': (p) => this.local.setEnginePath(p.path ?? null),
      'local.stop': () => this.local.stop(),

      'git.run': async (p) => {
        const root = await this.requireGitRoot(p.conversationId);
        const { scope } = this.resources.scope(p.conversationId);
        const rel = (paths: unknown) => {
          if (!Array.isArray(paths) || paths.length === 0) throw new HarnessError('invalid_argument', 'Fichiers manquants');
          return paths.map((x) => relative(root, scope.resolve(isAbsolute(String(x)) ? String(x) : join(root, String(x)), { write: true })).split(sep).join('/'));
        };
        const args: Record<string, () => string[]> = {
          stage: () => ['add', '--', ...rel(p.paths)],
          unstage: () => ['restore', '--staged', '--', ...rel(p.paths)],
          discard: () => ['restore', '--worktree', '--', ...rel(p.paths)],
          commit: () => ['commit', '-F', '-'],
          switch: () => {
            const b = String(p.branch ?? '');
            if (!/^[\w./-]+$/.test(b) || b.startsWith('-')) throw new HarnessError('invalid_argument', 'Nom de branche invalide');
            return ['switch', b];
          },
          fetch: () => ['fetch', '--prune'],
          pull: () => ['pull', '--ff-only'],
          push: () => ['push'],
        };
        const build = args[p.action];
        if (!build) throw new HarnessError('invalid_argument', 'Action Git inconnue');
        if (p.action === 'commit' && !String(p.message ?? '').trim()) throw new HarnessError('invalid_argument', 'Message de commit vide');
        const r = await runGit(root, build(), { timeoutMs: 180_000, ...(p.action === 'commit' ? { input: String(p.message) } : {}) });
        const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
        if (r.code !== 0) throw new HarnessError('invalid_argument', `git ${p.action} a échoué : ${output}`);
        return { output };
      },
      'conversations.search': (p) => this.conversations.search(String(p.query ?? ''), Math.min(100, Math.max(1, p.limit ?? 30))),

      'messages.list': (p) => this.messages.list(p.conversationId),

      'chat.send': (p) => this.generation.send(p.conversationId, p.input),
      'chat.cancel': (p) => ({ cancelled: this.generation.cancel(p.conversationId) }),
      'chat.active': () => this.generation.list(),

      'providers.presets': () => this.providers.presets(),
      'providers.list': () => this.providers.list(),
      'providers.create': (p) => this.providers.create(p),
      'providers.update': (p) => this.providers.update(p.id, p.patch),
      'providers.duplicate': (p) => this.providers.duplicate(p.id),
      'providers.delete': (p) => {
        this.providers.delete(p.id);
        this.forgetProvider(p.id);
      },
      'providers.reorder': (p) => this.providers.reorder(p.ids),
      'providers.setKey': (p) => this.providers.setKey(p.id, p.apiKey),
      'providers.clearKey': (p) => this.providers.clearKey(p.id),
      'providers.test': (p) => this.withAbort((signal) => this.providers.test(p, signal)),
      'providers.authenticate': (p) =>
        this.withAbort(async (signal) => {
          const { adapter, conn } = await this.providers.connection(p.id);
          if (!(adapter instanceof AcpAdapter)) return { ok: false, message: 'Cette connexion n’a pas de compte à connecter.' };
          return adapter.authenticate(conn, signal);
        }),
      'providers.fetchCatalog': (p) => this.withAbort((signal) => this.providers.fetchCatalog(p.id, signal)),
      'providers.refreshModels': (p) => this.withAbort((signal) => this.providers.refreshModels(p.id, signal)),
      'providers.setModels': (p) => this.providers.setModels(p.id, p.models),
    } satisfies { [M in keyof HarnessApi]: Handler<M> };
  }
}
