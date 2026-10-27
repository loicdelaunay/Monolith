import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
import { HttpClient } from './providers/http.ts';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.ts';
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
  readonly usage: UsageService;
  readonly attachments: AttachmentService;
  readonly queue: QueueService;
  readonly templates: TemplateService;
  readonly compactions: CompactionService;
  readonly history: HistoryService;
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
    const adapters = new Map<ProviderKind, ProviderAdapter>([
      ['openai-compatible', new OpenAICompatibleAdapter('openai-compatible', http)],
      ['deepseek', new OpenAICompatibleAdapter('deepseek', http)],
    ]);

    this.settings = new SettingsService(this.db, this.events);
    this.projects = new ProjectService(this.db, this.events);
    this.conversations = new ConversationService(this.db, this.events);
    this.messages = new MessageService(this.db);
    this.providers = new ProviderService(this.db, this.events, this.secrets, adapters);
    this.usage = new UsageService(this.db);
    this.attachments = new AttachmentService(this.db, this.layout.attachments);
    this.queue = new QueueService(this.db, this.events);
    this.templates = new TemplateService(this.db, this.events);
    this.compactions = new CompactionService(this.db, this.events);
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
    for (const c of this.testControllers) c.abort();
    await this.generation.idle();
    this.db.close();
    this.logger.info('app', 'Moteur arrêté');
  }

  private withAbort<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    this.testControllers.add(c);
    return fn(c.signal).finally(() => this.testControllers.delete(c));
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
