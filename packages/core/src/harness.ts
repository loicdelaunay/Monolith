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
import { WorkspaceFiles } from './services/workspace.ts';
import { HttpClient } from './providers/http.ts';
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
  hostBridge: HostBridge | null;
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

    this.db = Database.open({ path: this.layout.database, backupDir: this.layout.backups, logger: this.logger });
    this.secrets = new SecretStore({
      db: this.db,
      keysDir: this.layout.keys,
      logger: this.logger,
      protector: options.keyProtector === undefined ? systemProtector() : options.keyProtector,
      allowFileFallback: options.allowFileKeyFallback ?? false,
    });

    const http = new HttpClient(this.logger);
    const googleAuth = new GoogleAuth(http);
    const composite = new CompositeAdapter();
    const adapters = new Map<ProviderKind, ProviderAdapter>([
      ['openai-compatible', new OpenAICompatibleAdapter('openai-compatible', http)],
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
    ]);
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
      resources: this.resources,
      terminals: this.terminals,
      questions: this.questions,
      loopGate: this.loopGate,
      proposals: this.proposals,
      host: options.host,
    });
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
    this.generation.cancelAll();
    this.terminals.killAll();
    for (const c of this.testControllers) c.abort();
    await this.generation.idle();
    // Processus d'agents externes (ACP) arrêtés avec le moteur.
    for (const a of this.adapters.values()) await a.dispose?.();
    this.db.close();
    this.logger.info('app', 'Moteur arrêté');
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
      'providers.fetchCatalog': (p) => this.withAbort((signal) => this.providers.fetchCatalog(p.id, signal)),
      'providers.refreshModels': (p) => this.withAbort((signal) => this.providers.refreshModels(p.id, signal)),
      'providers.setModels': (p) => this.providers.setModels(p.id, p.models),
    } satisfies { [M in keyof HarnessApi]: Handler<M> };
  }
}
