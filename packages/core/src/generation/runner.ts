import {
  HarnessError,
  type AttachmentRef,
  type Compaction,
  type ContextUsage,
  type Conversation,
  type GenerationSnapshot,
  type GenerationState,
  type Id,
  type Message,
  type MessageDelta,
  type MessageError,
  type MessageOrigin,
  type MessagePart,
  type MessageStatus,
  type MessageUsage,
  type ModelCapabilities,
  type Project,
  type Provider,
  type SendInput,
  type SendResult,
  type Settings,
  type ToolCallRecord,
  type UsageRecord,
  type CustomSkill,
} from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import type { Logger } from '../log/logger.ts';
import type { ConversationService } from '../services/conversations.ts';
import type { MessageService } from '../services/messages.ts';
import type { ProjectService } from '../services/projects.ts';
import type { ProviderService } from '../services/providers.ts';
import type { SettingsService } from '../services/settings.ts';
import type { UsageService } from '../services/usage.ts';
import type { QueueService } from '../services/queue.ts';
import type { AttachmentService } from '../services/attachments.ts';
import type { CompactionService } from '../services/compactions.ts';
import type { AdapterContext, ChatMessage, ChatRequest, ExternalToolEvent, ProviderAdapter, ProviderConnection, StreamEvent, ToolCallRequest } from '../providers/adapter.ts';
import type { ToolRegistry, Host } from '../tools/registry.ts';
import type { MemoryService } from '../services/memory.ts';
import { modeAllows } from '../tools/registry.ts';
import type { ToolContext, ToolDefinition } from '../tools/types.ts';
import { limit } from '../tools/types.ts';
import type { ResourceScope } from '../tools/scope.ts';
import type { PermissionEngine } from '../permissions/engine.ts';
import type { ResourceService } from '../services/resources.ts';
import type { TerminalManager } from '../tools/terminals.ts';
import { LoopDetector, type LoopGate, type ProposalService, type QuestionBroker } from '../tools/interactions.ts';
import { INSTRUCTION_SKILLS } from '../tools/builtin.ts';
import { ProviderError } from '../providers/http.ts';
import { decideRetry } from './retry.ts';
import { buildHistory, buildSystemPrompt, compactionCut, estimateRequestTokens, transcriptText } from './prompt.ts';
import { isReasoningRejection, planReasoning, transportFor } from './reasoning.ts';
import { estimateTokens, sleep } from '../util.ts';

const MAX_INPUT = 1_000_000;
const DELTA_FLUSH_MS = 32;
const PERSIST_EVERY_MS = 1000;

interface Job {
  conversationId: Id;
  controller: AbortController;
  state: GenerationState;
  done: Promise<void>;
  final: MessageStatus;
}

/** Configuration figée d'une génération (instantané) et accès au fournisseur. */
interface JobContext {
  conversation: Conversation;
  project: Project | null;
  settings: Settings;
  provider: Provider;
  adapter: ProviderAdapter;
  conn: ProviderConnection;
  caps: ModelCapabilities | null;
  contextWindow: number | null;
  snapshot: GenerationSnapshot;
  reasoningBody: Record<string, unknown>;
  policy: { maxAttempts: number; baseDelayMs: number; retryTruncatedJson400: boolean };
  /** Outils exposés pour cette génération (skills actifs, mode, hôte). */
  tools: ToolDefinition[];
  scope: ResourceScope;
  loop: LoopDetector;
  instructionFiles: { scope: string; path: string; content: string }[];
  /** Serveurs MCP qui n'ont pas pu être connectés (signalés dans la réponse). */
  mcpErrors: string[];
}

export interface GenerationDeps {
  events: EventBus;
  logger: Logger;
  settings: SettingsService;
  projects: ProjectService;
  conversations: ConversationService;
  messages: MessageService;
  providers: ProviderService;
  usage: UsageService;
  queue: QueueService;
  attachments: AttachmentService;
  compactions: CompactionService;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  resources: ResourceService;
  terminals: TerminalManager;
  questions: QuestionBroker;
  loopGate: LoopGate;
  proposals: ProposalService;
  host: Host;
  memory?: MemoryService;
  /** Serveurs MCP : connexion avant génération et filtrage des outils par conversation. */
  mcp?: { allows(tool: ToolDefinition, conversationId: Id): boolean; ensureConnected(conversationId: Id, cwd: string): Promise<string[]> };
  customSkills?: (roots: string[], settings: Settings) => CustomSkill[];
  /** Vision de secours (modèle de la conversation sans vision). */
  vision?: { cached(attachmentId: Id): string | null; ensure(attachmentId: Id, signal: AbortSignal): Promise<string> };
}

/**
 * Exécute les générations. Chaque génération fige un instantané de sa configuration au
 * démarrage ; modifier ensuite le modèle, le fournisseur ou les réglages n'affecte que les
 * générations suivantes. Plusieurs conversations peuvent générer en parallèle.
 *
 * Une génération est une suite de tours. Entre deux tours (frontière contrôlée), les
 * instructions transmises pendant la génération sont ajoutées à l'historique et un nouveau
 * tour démarre avec le même instantané. Les éléments de la file partent ensuite, un par un,
 * chacun avec un nouvel instantané.
 */
export class GenerationRunner {
  private readonly active = new Map<Id, Job>();
  /** Conversations dont la génération est en cours de préparation (entre la validation et l'écriture). */
  private readonly starting = new Set<Id>();

  constructor(private readonly deps: GenerationDeps) {
    deps.conversations.isGenerating = (id) => this.active.has(id);
  }

  list(): GenerationState[] {
    return [...this.active.values()].map((g) => ({ ...g.state }));
  }

  isActive(conversationId: Id): boolean {
    return this.active.has(conversationId);
  }

  /** Attend la fin de la génération d'une conversation ; null si aucune n'est en cours. */
  async waitFor(conversationId: Id): Promise<MessageStatus | null> {
    const job = this.active.get(conversationId);
    if (!job) return null;
    await job.done;
    return job.final;
  }

  /** Attend la fin de toutes les générations, y compris celles lancées depuis la file. */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()].map((g) => g.done));
  }

  async send(conversationId: Id, input: SendInput): Promise<SendResult> {
    const text = typeof input?.text === 'string' ? input.text : '';
    if (text.length > MAX_INPUT) throw new HarnessError('invalid_argument', `Message trop long (${MAX_INPUT} caractères maximum)`);
    const attachments = this.deps.attachments.resolve(input?.attachmentIds);
    if (!text.trim() && attachments.length === 0) throw new HarnessError('invalid_argument', 'Message vide');
    const mode = input?.mode ?? 'send';
    if (!['send', 'queue', 'steer'].includes(mode)) throw new HarnessError('invalid_argument', 'Mode d’envoi inconnu');
    this.deps.conversations.get(conversationId);

    if (this.active.has(conversationId) || this.starting.has(conversationId)) {
      if (mode === 'send') throw new HarnessError('busy', 'Une génération est déjà en cours dans cette conversation');
      const item = this.deps.queue.add(conversationId, mode === 'steer' ? 'steer' : 'queue', text, attachments);
      this.deps.conversations.saveDraft(conversationId, '', []);
      return { status: mode === 'steer' ? 'steered' : 'queued', queuedId: item.id };
    }
    return this.start(conversationId, [{ text, attachments, origin: 'direct' }], true);
  }

  /** Envoie le premier élément de la file (automatiquement après une génération terminée, ou à la demande). */
  async sendNext(conversationId: Id): Promise<SendResult> {
    if (this.active.has(conversationId)) throw new HarnessError('busy', 'Une génération est déjà en cours dans cette conversation');
    const next = this.deps.queue.peekNext(conversationId);
    if (!next) throw new HarnessError('not_found', 'La file est vide');
    const result = await this.start(conversationId, [{ text: next.text, attachments: next.attachments, origin: 'queue' }], false);
    this.deps.queue.remove(next.id);
    return result;
  }

  cancel(conversationId: Id): boolean {
    const job = this.active.get(conversationId);
    if (!job) return false;
    job.controller.abort(new HarnessError('cancelled', 'Génération annulée'));
    return true;
  }

  cancelAll(): void {
    for (const g of this.active.values()) g.controller.abort(new HarnessError('cancelled', 'Arrêt du moteur'));
  }

  // ---------------------------------------------------------------------------
  // Préparation (aucune écriture avant validation complète)
  // ---------------------------------------------------------------------------

  private async prepare(conversationId: Id): Promise<JobContext> {
    const { conversations, settings, providers, projects } = this.deps;
    const conversation = conversations.get(conversationId);
    const s = settings.get();
    const providerId = conversation.providerId ?? s.chat.defaultProviderId;
    // Sans fournisseur propre (jamais choisi ou connexion supprimée), la conversation suit le couple par défaut.
    const model = conversation.providerId !== null ? conversation.model : s.chat.defaultModel;
    if (providerId === null) throw new HarnessError('provider_no_model', 'Aucun fournisseur sélectionné. Ajoutez une connexion dans Réglages › Fournisseurs.');
    if (!model) throw new HarnessError('provider_no_model', 'Aucun modèle sélectionné pour cette conversation.');
    // Résolution complète avant toute écriture : une clé illisible échoue sans laisser de message orphelin.
    const { provider, adapter, conn } = await providers.connection(providerId);
    if (!provider.enabled) throw new HarnessError('unavailable', `La connexion « ${provider.name} » est désactivée.`);
    const caps = providers.modelCapabilities(provider.id, model);
    const limits = providers.modelLimits(provider.id, model);
    const plan = planReasoning(conversation.reasoningLevel, caps, transportFor(provider.preset));
    const project = conversation.projectId !== null ? projects.get(conversation.projectId) : null;
    const { scope } = this.deps.resources.scope(conversationId);
    // Serveurs MCP actifs pour la conversation : connectés avant de figer la liste des outils.
    const mcpErrors = this.deps.mcp && conversation.mode === 'agent' && (s.skills.enabled.mcp ?? true) ? await this.deps.mcp.ensureConnected(conversationId, scope.roots[0] ?? process.cwd()) : [];
    const tools = this.deps.tools
      .available(s, conversation.mode, conversation.agentMode, this.deps.host)
      .filter((t) => !this.deps.mcp || this.deps.mcp.allows(t, conversationId))
      // Délégation : désactivée par réglage ou au-delà de la profondeur maximale.
      .filter((t) => t.name !== 'delegate_tasks' || (s.subagents.mode !== 'off' && conversation.depth < s.subagents.maxDepth));
    const instructionFiles = conversation.mode === 'agent' && s.agent.readInstructionFiles ? this.deps.resources.instructionFiles(scope.roots) : [];
    const snapshot: GenerationSnapshot = {
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      model,
      reasoningLevel: conversation.reasoningLevel,
      reasoning: plan.resolution,
      mode: conversation.mode,
      agentMode: conversation.agentMode,
      responseStyle: s.chat.responseStyle,
      temperature: conn.options.temperature,
      maxOutputTokens: conn.options.maxOutputTokens ?? limits.maxOutputTokens,
      tools: tools.map((t) => t.name),
      startedAt: new Date().toISOString(),
    };
    return {
      conversation,
      project,
      settings: s,
      provider,
      adapter,
      conn,
      caps,
      contextWindow: limits.contextWindow,
      snapshot,
      reasoningBody: plan.body,
      policy: { maxAttempts: s.network.retryMaxAttempts, baseDelayMs: s.network.retryBaseDelayMs, retryTruncatedJson400: s.network.retryTruncatedJson400 },
      tools,
      scope,
      loop: new LoopDetector(s.loop),
      instructionFiles,
      mcpErrors,
    };
  }

  private async start(conversationId: Id, inputs: { text: string; attachments: AttachmentRef[]; origin: MessageOrigin }[], clearDraft: boolean): Promise<SendResult> {
    const { conversations, messages, events } = this.deps;
    if (this.active.has(conversationId) || this.starting.has(conversationId)) throw new HarnessError('busy', 'Une génération est déjà en cours dans cette conversation');
    this.starting.add(conversationId);
    let ctx: JobContext;
    try {
      ctx = await this.prepare(conversationId);
    } finally {
      this.starting.delete(conversationId);
    }

    let userMessageId = 0;
    for (const input of inputs) {
      const m = messages.create({ conversationId, role: 'user', status: 'complete', parts: userParts(input.text, input.attachments), origin: input.origin });
      userMessageId = m.id;
      events.emit('message.added', { message: m });
    }
    const assistant = messages.create({ conversationId, role: 'assistant', status: 'streaming', parts: [], snapshot: ctx.snapshot });
    events.emit('message.added', { message: assistant });
    if (clearDraft) conversations.saveDraft(conversationId, '', []);
    const first = inputs[0]!;
    if (ctx.conversation.titleSource === 'default') conversations.setAutoTitle(conversationId, provisionalTitle(first.text || first.attachments.map((a) => a.name).join(', ')));

    const job: Job = {
      conversationId,
      controller: new AbortController(),
      state: { conversationId, messageId: assistant.id, status: 'running', attempt: 1 },
      done: Promise.resolve(),
      final: 'complete',
    };
    this.active.set(conversationId, job);
    conversations.touch(conversationId);
    events.emit('generation.state', { ...job.state });
    job.done = this.runJob(job, ctx, assistant.id)
      .then((status) => {
        job.final = status;
      })
      .catch((error: unknown) => {
        job.final = 'error';
        this.deps.logger.error('generation', 'Erreur inattendue', error);
      })
      .finally(() => this.afterJob(job, ctx));
    return { status: 'started', userMessageId, assistantMessageId: assistant.id };
  }

  private async runJob(job: Job, ctx: JobContext, firstAssistantId: Id): Promise<MessageStatus> {
    const { queue, messages, events } = this.deps;
    let assistantId = firstAssistantId;
    for (;;) {
      await this.maybeAutoCompact(job, ctx, assistantId);
      const status = await this.runTurn(job, ctx, assistantId);
      if (status !== 'complete') {
        queue.demoteSteers(job.conversationId);
        return status;
      }
      // Frontière contrôlée : instructions transmises pendant le tour qui vient de se terminer.
      const steers = queue.takeSteers(job.conversationId);
      if (steers.length === 0) return 'complete';
      for (const s of steers) {
        const m = messages.create({ conversationId: job.conversationId, role: 'user', status: 'complete', parts: userParts(s.text, s.attachments), origin: 'steer' });
        events.emit('message.added', { message: m });
      }
      const next = messages.create({ conversationId: job.conversationId, role: 'assistant', status: 'streaming', parts: [], snapshot: ctx.snapshot });
      events.emit('message.added', { message: next });
      assistantId = next.id;
      Object.assign(job.state, { messageId: next.id, status: 'running', attempt: 1, retryReason: undefined, retryInMs: undefined });
      events.emit('generation.state', { ...job.state });
    }
  }

  /** Libère la conversation, puis enchaîne nommage et file si la génération s'est terminée normalement. */
  private afterJob(job: Job, ctx: JobContext): void {
    this.release(job);
    if (job.final !== 'complete') return;
    void this.maybeName(ctx).catch((e: unknown) => this.deps.logger.warn('naming', 'Nommage automatique impossible', { error: (e as Error).message }));
    if (this.deps.queue.peekNext(job.conversationId)) {
      void this.sendNext(job.conversationId).catch((e: unknown) => {
        this.deps.logger.warn('generation', 'Élément de file non envoyé', { error: (e as Error).message });
        this.deps.events.emit('log.error', { code: e instanceof HarnessError ? e.code : 'internal', message: (e as Error).message });
      });
    }
  }

  /** Libère la conversation avant l'annonce du message final : un client qui relit voit `generating: false`. */
  private release(job: Job): void {
    if (this.active.get(job.conversationId) !== job) return;
    this.active.delete(job.conversationId);
    this.deps.events.emit('generation.state', { ...job.state, status: 'finished' });
    try {
      this.deps.conversations.touch(job.conversationId);
    } catch {
      /* conversation supprimée pendant la génération */
    }
  }

  // ---------------------------------------------------------------------------
  // Requêtes
  // ---------------------------------------------------------------------------

  /**
   * Requête complète : instructions, résumé de compactage, historique reconstruit pour le modèle cible,
   * puis le message en cours (texte et outils des tours précédents) et les outils exposés.
   */
  private buildRequest(ctx: JobContext, excludeMessageId: Id | null, currentParts: MessagePart[] = []): { request: ChatRequest; droppedImages: number } {
    const { messages, compactions, attachments } = this.deps;
    const conversation = this.deps.conversations.get(ctx.conversation.id);
    const latest = compactions.latest(conversation.id);
    const system = buildSystemPrompt({
      responseStyle: ctx.snapshot.responseStyle,
      customInstructions: ctx.settings.chat.customInstructions,
      project: ctx.project,
      goal: conversation.goal,
      compactionSummary: latest?.summary ?? null,
      extra: this.extraSections(ctx, conversation.id),
      agent:
        ctx.snapshot.mode === 'agent'
          ? {
              agentMode: ctx.snapshot.agentMode,
              roots: ctx.scope.roots,
              files: ctx.scope.files,
              instructionFiles: ctx.instructionFiles,
              notes: Object.entries(INSTRUCTION_SKILLS)
                .filter(([id]) => ctx.settings.skills.enabled[id])
                .map(([, text]) => text),
              hasTools: ctx.tools.length > 0,
            }
          : null,
    });
    const list = messages.list(conversation.id).filter((m) => m.id !== excludeMessageId && m.status !== 'streaming');
    if (currentParts.length) {
      list.push({ id: -1, conversationId: conversation.id, seq: Number.MAX_SAFE_INTEGER, role: 'assistant', origin: 'direct', status: 'streaming', parts: currentParts, snapshot: null, usage: null, error: null, createdAt: '', completedAt: null, durationMs: null, firstTokenMs: null });
    }
    const history = buildHistory(list, {
      attachments: { text: (r) => attachments.text(r.id), dataUrl: (r) => attachments.dataUrl(r.id) },
      vision: ctx.caps?.vision ?? null,
      ...(this.deps.vision && ctx.settings.studio.visionFallback ? { describe: (id: number) => this.deps.vision!.cached(id) } : {}),
      compactedUpToSeq: latest?.upToSeq ?? null,
    });
    return {
      droppedImages: history.droppedImages,
      request: {
        model: ctx.snapshot.model,
        messages: [{ role: 'system', content: system }, ...history.messages],
        reasoningLevel: ctx.snapshot.reasoningLevel,
        temperature: ctx.snapshot.temperature,
        maxOutputTokens: ctx.snapshot.maxOutputTokens,
        extraBody: ctx.reasoningBody,
        ...(ctx.tools.length ? { tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}),
      },
    };
  }

  /** Mémoires (lecture initiale forcée) et skills personnalisés disponibles, présentés comme des données. */
  private extraSections(ctx: JobContext, conversationId: Id): string[] {
    const out: string[] = [];
    const s = ctx.settings;
    if (this.deps.memory && s.memory.forcedRead && (s.skills.enabled.memory ?? true)) {
      out.push(this.deps.memory.promptBlock(this.deps.memory.visible(conversationId, ctx.conversation.projectId, null, s.memory.forcedReadCount)));
    }
    if (s.subagents.mode === 'forced' && ctx.tools.some((t) => t.name === 'delegate_tasks')) {
      out.push('Délégation : découpe le travail en sous-tâches indépendantes et confie-les à des sous-agents avec delegate_tasks (en parallèle quand c’est possible), puis synthétise leurs rapports.');
    }
    if (ctx.conversation.parentId !== null) {
      out.push(`Tu es un sous-agent (rôle : ${ctx.conversation.role ?? 'général'}). Travaille uniquement sur la tâche confiée, sans demander de précisions sauf blocage, puis termine par un rapport final concis : résultat, fichiers concernés, points incertains.`);
    }
    if (this.deps.customSkills && ctx.snapshot.mode === 'agent' && (s.skills.enabled.custom_skills ?? true) && ctx.tools.some((t) => t.name === 'load_skill')) {
      const skills = this.deps.customSkills(ctx.scope.roots, s).filter((k) => k.enabled);
      if (skills.length) out.push(`Skills personnalisés disponibles (chargez-les avec load_skill avant de les appliquer) :\n${skills.map((k) => `- ${k.name} : ${k.description}`).join('\n')}`);
    }
    return out;
  }

  /** Écriture forcée : extraction de faits durables après une réponse (requête dédiée, comptabilisée). */
  private async forcedMemory(ctx: JobContext, messageId: Id): Promise<void> {
    const memory = this.deps.memory;
    if (!memory) return;
    const list = this.deps.messages.list(ctx.conversation.id);
    const reply = list.find((m) => m.id === messageId);
    const user = [...list].reverse().find((m) => m.role === 'user' && m.seq < (reply?.seq ?? 0));
    if (!reply || !user) return;
    const request: ChatRequest = {
      model: ctx.snapshot.model,
      messages: [
        { role: 'system', content: 'Tu extrais des faits durables (préférences, décisions, contexte stable) utiles pour de futures conversations. Réponds uniquement par un tableau JSON [{"title": "...", "content": "...", "scope": "project" | "global" | "user"}], ou [] si rien ne mérite d’être retenu. Jamais de secrets.' },
        { role: 'user', content: `Utilisateur :\n${transcriptText(user).slice(0, 4000)}\n\nAssistant :\n${transcriptText(reply).slice(0, 6000)}` },
      ],
      reasoningLevel: 'auto',
      temperature: null,
      maxOutputTokens: null,
    };
    try {
      const raw = await this.collect(ctx, request, 'memory', ctx.conversation, AbortSignal.timeout(60_000));
      const json = /\[[\s\S]*\]/.exec(raw)?.[0];
      const items = json ? (JSON.parse(json) as { title?: string; content?: string; scope?: string }[]) : [];
      for (const it of items.slice(0, 5)) {
        if (!it.title || !it.content) continue;
        const scope = it.scope === 'user' || it.scope === 'global' ? it.scope : ctx.conversation.projectId !== null ? 'project' : 'global';
        memory.save({ scope, projectId: ctx.conversation.projectId, title: it.title, content: it.content }, { source: 'forced', conversationId: ctx.conversation.id, messageId });
      }
    } catch (e) {
      this.deps.logger.info('memory', 'Écriture forcée ignorée', { error: (e as Error).message });
    }
  }

  /**
   * Services offerts aux agents externes (ACP) : fichiers dans la portée, autorisations soumises
   * aux règles et à l'utilisateur, mode de la conversation respecté.
   */
  private adapterContext(job: Job, ctx: JobContext, messageId: Id): AdapterContext {
    const { permissions, providers } = this.deps;
    const allowed: Record<string, string[]> = { chat: ['read'], plan: ['read'], propose: ['read'], execute: ['read', 'write', 'exec', 'network'] };
    const effects = ctx.snapshot.mode === 'chat' ? allowed.chat! : allowed[ctx.snapshot.agentMode]!;
    const history = this.deps.messages
      .list(job.conversationId)
      .filter((m) => m.id !== messageId && m.status !== 'streaming')
      .slice(0, -1)
      .map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${transcriptText(m).trim()}`)
      .filter((l) => !l.endsWith(': '));
    const transcript = history.join('\n\n');
    return {
      conversationId: job.conversationId,
      cwd: ctx.scope.roots[0] ?? process.cwd(),
      roots: ctx.scope.roots,
      transcript: transcript.length > 60_000 ? `…${transcript.slice(-60_000)}` : transcript,
      resolvePath: (path, write) => {
        if (write && !effects.includes('write')) throw new HarnessError('permission_denied', `Écriture refusée : mode ${ctx.snapshot.mode === 'chat' ? 'Chat' : ctx.snapshot.agentMode} (passez en mode Agent · Exécution).`);
        return ctx.scope.resolve(path, { write });
      },
      requestPermission: async (req, signal) => {
        const nowIso = new Date().toISOString();
        const query = { conversationId: job.conversationId, projectId: ctx.conversation.projectId, tool: req.toolName, family: req.family, effects: req.effects, resources: req.resources };
        const blocked = req.effects.find((e) => !effects.includes(e));
        let permission: NonNullable<ToolCallRecord['permission']>;
        if (blocked) {
          permission = { decision: 'deny', source: 'mode', ruleId: null, scope: null, reason: `Effet « ${blocked} » non autorisé dans ce mode.`, decidedAt: nowIso };
        } else {
          const evaluation = permissions.evaluate(query, ctx.settings.permissions.policy);
          if (evaluation.decision === 'ask') {
            const resp = await permissions.request({ conversationId: job.conversationId, messageId, tool: req.toolName, family: req.family, effects: req.effects, target: req.title, arguments: req.arguments, preview: null, reason: evaluation.reason }, query, signal);
            permission = { decision: resp.decision, source: 'user', ruleId: null, scope: resp.scope, reason: resp.reason, decidedAt: nowIso };
          } else permission = { decision: evaluation.decision, source: evaluation.source, ruleId: evaluation.ruleId, scope: evaluation.scope, reason: evaluation.reason, decidedAt: nowIso };
        }
        permissions.log(job.conversationId, req.toolName, req.title, permission);
        return { allow: permission.decision === 'allow', always: permission.scope !== null && permission.scope !== 'once' };
      },
      connection: async (id) => {
        const r = await providers.connection(id);
        return { adapter: r.adapter, conn: r.conn, providerName: r.provider.name };
      },
    };
  }

  private async runTurn(job: Job, ctx: JobContext, messageId: Id): Promise<MessageStatus> {
    const { events, messages, usage, logger, providers, queue } = this.deps;
    const signal = job.controller.signal;
    const started = performance.now();
    const parts: MessagePart[] = [];
    let firstTokenMs: number | null = null;
    let status: MessageStatus = 'complete';
    let error: MessageError | null = null;
    let lastPersist = performance.now();
    let snapshot = ctx.snapshot;
    // Compteurs cumulés sur tous les tours d'outils de la réponse.
    const totals = { input: 0, output: 0, cached: 0, reasoning: 0, estimated: false, any: false };
    let lastFinish: Extract<StreamEvent, { type: 'finish' }> | null = null;
    let lastRequest: ChatRequest | null = null;

    // Regroupement des deltas pour limiter les réveils d'IPC et de rendu.
    let pending: MessageDelta[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const deltas = pending;
      pending = [];
      events.emit('message.delta', { conversationId: job.conversationId, messageId, deltas });
    };
    const queueDelta = (d: MessageDelta) => {
      const last = pending.at(-1);
      if (last && d.kind !== 'part' && d.kind !== 'status' && last.kind === d.kind && last.partIndex === d.partIndex) last.text += d.text;
      else pending.push(d);
      flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS);
    };
    const persist = (force = false) => {
      if (force || performance.now() - lastPersist > PERSIST_EVERY_MS) {
        lastPersist = performance.now();
        messages.saveParts(messageId, parts);
      }
    };
    const append = (type: 'text' | 'reasoning', text: string) => {
      if (!text) return;
      firstTokenMs ??= performance.now() - started;
      const last = parts.at(-1);
      if (last && last.type === type) {
        last.text += text;
      } else {
        const part: MessagePart = { type, text: '' };
        parts.push(part);
        queueDelta({ kind: 'part', partIndex: parts.length - 1, part: { ...part } });
        (part as { text: string }).text = text;
      }
      queueDelta({ kind: type, partIndex: parts.length - 1, text });
      persist();
    };
    const notice = (level: 'info' | 'warning' | 'error', code: string, text: string) => {
      const part: MessagePart = { type: 'notice', level, code, text };
      parts.push(part);
      queueDelta({ kind: 'part', partIndex: parts.length - 1, part });
    };
    const setPart = (index: number, part: MessagePart) => {
      parts[index] = part;
      queueDelta({ kind: 'part', partIndex: index, part: structuredClone(part) });
      persist(true);
    };

    /** Action exécutée hors du moteur : créée puis mise à jour à chaque événement. */
    const upsertExternal = (e: ExternalToolEvent) => {
      const index = parts.findIndex((p) => p.type === 'tool' && p.call.id === e.id && p.call.external);
      const prev = index >= 0 ? (parts[index] as Extract<MessagePart, { type: 'tool' }>).call : null;
      const nowIso = new Date().toISOString();
      const call: ToolCallRecord = {
        id: e.id,
        name: e.name,
        family: e.family,
        effects: [],
        arguments: e.arguments,
        target: e.title,
        status: e.status,
        result: e.result,
        display: e.display ?? null,
        permission: prev?.permission ?? null,
        startedAt: prev?.startedAt ?? nowIso,
        finishedAt: e.status === 'running' ? null : nowIso,
        external: true,
      };
      if (index >= 0) setPart(index, { type: 'tool', call });
      else {
        parts.push({ type: 'tool', call });
        queueDelta({ kind: 'part', partIndex: parts.length - 1, part: structuredClone(parts.at(-1)!) });
        persist(true);
      }
    };

    for (const e of ctx.mcpErrors) notice('warning', 'mcp_unavailable', `Serveur MCP indisponible pour cette réponse — ${e}`);
    // Vision de secours : les images sont décrites une fois par le modèle de vision configuré.
    if (this.deps.vision && ctx.caps?.vision === false && ctx.settings.studio.visionFallback && ctx.settings.studio.visionProviderId !== null && ctx.settings.studio.visionModel) {
      const images = this.deps.messages
        .list(job.conversationId)
        .flatMap((m) => m.parts)
        .filter((p): p is Extract<MessagePart, { type: 'attachment' }> => p.type === 'attachment' && p.attachment.kind === 'image')
        .map((p) => p.attachment)
        .filter((a) => !this.deps.vision!.cached(a.id));
      for (const img of images) {
        try {
          await this.deps.vision.ensure(img.id, signal);
          notice('info', 'vision_fallback', `Image « ${img.name} » décrite par le modèle de vision de secours.`);
        } catch (e) {
          notice('warning', 'vision_fallback_failed', `Vision de secours indisponible pour « ${img.name} » : ${(e as Error).message}`);
        }
      }
    }
    if (ctx.snapshot.reasoning?.fallback) notice('info', 'reasoning_fallback', `Réflexion : ${ctx.snapshot.reasoning.fallback} ; requête envoyée en Auto.`);
    let reasoningRetried = false;
    let droppedNoticeShown = false;

    rounds: for (let round = 0; ; round++) {
      const built = this.buildRequest(ctx, messageId, parts);
      let request = ctx.provider.kind === 'acp' || ctx.provider.kind === 'composite' ? { ...built.request, context: this.adapterContext(job, ctx, messageId) } : built.request;
      lastRequest = request;
      if (built.droppedImages && !droppedNoticeShown) {
        droppedNoticeShown = true;
        notice('warning', 'images_dropped', `${built.droppedImages} image(s) non transmise(s) : le modèle « ${ctx.snapshot.model} » est déclaré sans vision.`);
      }
      const roundStart = parts.length;
      const calls: ToolCallRequest[] = [];
      let apiUsage: Extract<StreamEvent, { type: 'usage' }> | null = null;
      let finish: Extract<StreamEvent, { type: 'finish' }> | null = null;
      const usageId = usage.start({ kind: 'chat', conversationId: job.conversationId, projectId: ctx.conversation.projectId, providerId: ctx.provider.id, providerName: ctx.provider.name, model: ctx.snapshot.model });
      const roundStarted = performance.now();
      let roundFirst: number | null = null;
      let roundStatus: 'ok' | 'error' | 'cancelled' | 'incomplete' = 'ok';

      for (let attempt = 1; ; attempt++) {
        job.state.attempt = attempt;
        try {
          for await (const ev of ctx.adapter.stream(ctx.conn, request, signal)) {
            switch (ev.type) {
              case 'text':
              case 'reasoning':
                roundFirst ??= performance.now() - roundStarted;
                append(ev.type, ev.text);
                break;
              case 'tool_call':
                calls.push(ev.call);
                break;
              case 'external_tool':
                roundFirst ??= performance.now() - roundStarted;
                upsertExternal(ev.call);
                break;
              case 'usage':
                apiUsage = ev;
                break;
              case 'finish':
                finish = ev;
                break;
              case 'notice':
                if (ev.text) notice(ev.level, ev.code, ev.text);
                break;
            }
          }
          break;
        } catch (e) {
          // Une action externe (agent ACP, spécialiste) a pu avoir un effet : jamais de nouvelle tentative.
          const outputStarted = parts.slice(roundStart).some((p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'tool');
          if (signal.aborted || (e instanceof HarnessError && e.code === 'cancelled')) {
            status = 'cancelled';
            roundStatus = 'cancelled';
            break;
          }
          // Niveau de réflexion refusé explicitement : mémorisé, puis une seule nouvelle requête en Auto.
          // « Sans réflexion » n'est jamais remplacé : l'incompatibilité est signalée.
          const sent = snapshot.reasoning?.sent ?? null;
          if (!outputStarted && !reasoningRetried && sent && e instanceof ProviderError && isReasoningRejection(e.status, e.body)) {
            providers.rejectLevel(ctx.provider.id, ctx.snapshot.model, sent);
            if (sent === 'none') {
              status = 'error';
              roundStatus = 'error';
              error = { code: 'unavailable', message: `Le fournisseur refuse la désactivation de la réflexion pour « ${ctx.snapshot.model} » : ${e.message}`, status: e.status ?? undefined, retryable: false, attempts: attempt };
              break;
            }
            reasoningRetried = true;
            ctx.reasoningBody = {};
            snapshot = { ...snapshot, reasoning: { requested: snapshot.reasoning!.requested, sent: null, parameter: null, fallback: `niveau « ${sent} » refusé par le fournisseur` } };
            ctx.snapshot = snapshot;
            messages.saveSnapshot(messageId, snapshot);
            notice('warning', 'reasoning_rejected', `Le fournisseur a refusé le niveau de réflexion « ${sent} » ; requête renvoyée en Auto. Ce niveau n’est plus proposé jusqu’à la prochaine actualisation des modèles.`);
            request = { ...request, extraBody: {} };
            attempt--;
            continue;
          }
          // Les outils déjà exécutés ne sont jamais rejoués : chaque tour repart de leurs résultats enregistrés.
          const decision = decideRetry(e, attempt, ctx.policy, outputStarted || calls.length > 0);
          if (decision.retry) {
            logger.warn('generation', 'Nouvelle tentative', { conversationId: job.conversationId, attempt, reason: decision.reason, delayMs: decision.delayMs });
            Object.assign(job.state, { status: 'retrying', retryReason: decision.reason, retryInMs: decision.delayMs });
            events.emit('generation.state', { ...job.state });
            try {
              await sleep(decision.delayMs, signal);
            } catch {
              status = 'cancelled';
              roundStatus = 'cancelled';
              break;
            }
            Object.assign(job.state, { status: 'running', attempt: attempt + 1, retryReason: undefined, retryInMs: undefined });
            events.emit('generation.state', { ...job.state });
            continue;
          }
          const he = e instanceof HarnessError ? e : new HarnessError('internal', e instanceof Error ? e.message : String(e));
          const anyOutput = parts.some((p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'tool');
          status = anyOutput ? 'interrupted' : 'error';
          roundStatus = anyOutput ? 'incomplete' : 'error';
          error = {
            code: he.code,
            message: he.message,
            ...(e instanceof ProviderError && e.status !== null ? { status: e.status } : {}),
            retryable: e instanceof ProviderError ? e.retryable : false,
            attempts: attempt,
          };
          logger.warn('generation', 'Génération en erreur', { conversationId: job.conversationId, code: he.code, attempt });
          break;
        }
      }

      // Consommation du tour (une ligne par requête).
      const roundText = parts.slice(roundStart).filter((p) => p.type === 'text' || p.type === 'reasoning').map((p) => (p as { text: string }).text).join('');
      const roundUsage = apiUsage
        ? { inputTokens: apiUsage.inputTokens, outputTokens: apiUsage.outputTokens, cachedInputTokens: apiUsage.cachedInputTokens, reasoningTokens: apiUsage.reasoningTokens, estimated: false }
        : { inputTokens: estimateRequestTokens(request.messages), outputTokens: estimateTokens(roundText + calls.map((c) => c.arguments).join('')), cachedInputTokens: null, reasoningTokens: null, estimated: true };
      usage.finish(usageId, { firstTokenMs: roundFirst, ...roundUsage, status: roundStatus });
      totals.any = true;
      totals.input += roundUsage.inputTokens ?? 0;
      totals.output += roundUsage.outputTokens ?? 0;
      totals.cached += roundUsage.cachedInputTokens ?? 0;
      totals.reasoning += roundUsage.reasoningTokens ?? 0;
      totals.estimated ||= roundUsage.estimated;
      lastFinish = finish;

      if (status !== 'complete') break;
      if (calls.length === 0) break;

      // Exécution des appels, dans l'ordre, chacun soumis au mode et aux autorisations.
      for (const call of calls) {
        const index = parts.length;
        const outcome = await this.executeTool(job, ctx, messageId, call, (record) => setPart(index, { type: 'tool', call: record }));
        if (outcome === 'stop' || signal.aborted) {
          status = 'cancelled';
          if (outcome === 'stop') notice('warning', 'loop_stopped', 'Travail arrêté par l’utilisateur après une détection de boucle.');
          break rounds;
        }
      }
      const budget = ctx.conversation.budget;
      if (budget?.maxOutputTokens && totals.output >= budget.maxOutputTokens) {
        notice('warning', 'budget_tokens', `Budget du sous-agent épuisé (${budget.maxOutputTokens} tokens de sortie).`);
        status = 'interrupted';
        break;
      }
      if (budget?.maxRounds && round + 1 >= Math.min(budget.maxRounds, ctx.settings.agent.maxToolRounds)) {
        notice('warning', 'budget_rounds', `Budget du sous-agent épuisé (${Math.min(budget.maxRounds, ctx.settings.agent.maxToolRounds)} tours d’outils).`);
        status = 'interrupted';
        break;
      }
      if (round + 1 >= ctx.settings.agent.maxToolRounds) {
        notice('warning', 'max_tool_rounds', `Limite de ${ctx.settings.agent.maxToolRounds} tours d’outils atteinte : réponse arrêtée. Relancez pour poursuivre.`);
        break;
      }
      // Frontière contrôlée : une instruction transmise pendant ce tour interrompt la boucle ici.
      if (queue.list(job.conversationId).some((i) => i.kind === 'steer')) break;
      Object.assign(job.state, { status: 'running', attempt: 1 });
    }

    if (status === 'complete') {
      const hasText = parts.some((p) => p.type === 'text' && p.text.trim());
      const hasTools = parts.some((p) => p.type === 'tool');
      if (lastFinish?.reason === 'length') notice('warning', 'max_tokens', 'Réponse tronquée : la limite de sortie du modèle a été atteinte.');
      else if (lastFinish?.reason === 'content_filter') notice('warning', 'content_filter', 'Le fournisseur a interrompu ou refusé la réponse (filtre de contenu).');
      else if (!lastFinish && hasText) notice('warning', 'no_finish', 'Le flux s’est terminé sans indication de fin : la réponse peut être incomplète.');
      if (!hasText && !hasTools && !parts.some((p) => p.type === 'reasoning')) {
        status = 'error';
        error = { code: lastFinish?.reason === 'content_filter' ? 'provider_refusal' : 'provider_stream', message: 'Le fournisseur n’a renvoyé aucun contenu.', attempts: job.state.attempt };
      }
    }
    // Appels restés en cours (annulation) : jamais présentés comme réussis.
    for (const [i, p] of parts.entries()) {
      if (p.type === 'tool' && ['pending', 'awaiting_permission', 'running'].includes(p.call.status)) {
        parts[i] = { type: 'tool', call: { ...p.call, status: p.call.status === 'running' ? 'interrupted' : 'cancelled', result: p.call.status === 'running' ? null : 'Appel annulé avant exécution.', finishedAt: new Date().toISOString() } };
      }
    }

    const durationMs = performance.now() - started;
    const finalUsage: MessageUsage = totals.any
      ? { inputTokens: totals.input, outputTokens: totals.output, cachedInputTokens: totals.cached || null, reasoningTokens: totals.reasoning || null, estimated: totals.estimated }
      : { inputTokens: lastRequest ? estimateRequestTokens(lastRequest.messages) : 0, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null, estimated: true };

    if (flushTimer) clearTimeout(flushTimer);
    flush();
    let final: Message | null = null;
    try {
      final = messages.finish(messageId, { status, parts, usage: finalUsage, error, durationMs, firstTokenMs });
    } catch (e) {
      // Conversation supprimée pendant la génération : rien à enregistrer.
      logger.info('generation', 'Message introuvable en fin de génération', { error: (e as Error).message });
    }
    // Dernier tour : la conversation est libérée avant l'annonce du message final.
    const lastTurn = status !== 'complete' || queue.list(job.conversationId).every((i) => i.kind !== 'steer');
    if (lastTurn) {
      job.final = status;
      this.release(job);
    }
    if (status === 'complete' && ctx.settings.memory.forcedWrite && (ctx.settings.skills.enabled.memory ?? true) && ctx.provider.kind !== 'acp') void this.forcedMemory(ctx, messageId);
    if (final) events.emit('message.updated', { message: final });
    return status;
  }

  /**
   * Un appel d'outil : mode, skill, détection de boucle, autorisation, puis exécution. Le résultat
   * renvoyé au modèle est toujours fidèle (refus, erreur, annulation sont dits comme tels).
   */
  private async executeTool(job: Job, ctx: JobContext, messageId: Id, call: ToolCallRequest, update: (r: ToolCallRecord) => void): Promise<'ok' | 'stop'> {
    const { permissions, proposals, questions, loopGate, events, terminals } = this.deps;
    const signal = job.controller.signal;
    const nowIso = () => new Date().toISOString();
    const record: ToolCallRecord = { id: call.id, name: call.name, family: 'inconnu', effects: [], arguments: call.arguments, target: null, status: 'pending', result: null, display: null, permission: null, startedAt: nowIso(), finishedAt: null, ...(call.meta ? { meta: call.meta } : {}) };
    const end = (patch: Partial<ToolCallRecord>) => {
      Object.assign(record, patch, { finishedAt: nowIso() });
      if (record.result) record.result = limit(record.result, ctx.settings.agent.maxResultChars);
      update({ ...record });
    };
    update({ ...record });

    const def = this.deps.tools.get(call.name);
    if (!def) {
      end({ status: 'error', result: `Outil inconnu : ${call.name}. Outils disponibles : ${ctx.tools.map((t) => t.name).join(', ') || 'aucun'}.` });
      return 'ok';
    }
    record.family = def.family;
    record.effects = def.effects;
    if (!ctx.tools.includes(def)) {
      const m = modeAllows(def, ctx.snapshot.mode, ctx.snapshot.agentMode);
      const reason = m.ok ? `Le skill « ${def.skill} » est désactivé ou l’outil est indisponible sur cet hôte.` : m.reason;
      const permission = { decision: 'deny' as const, source: 'mode' as const, ruleId: null, scope: null, reason, decidedAt: nowIso() };
      permissions.log(job.conversationId, def.name, null, permission);
      end({ status: 'denied', permission, result: `Refusé : ${reason}` });
      return 'ok';
    }
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.arguments || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('un objet JSON est attendu');
      args = parsed as Record<string, unknown>;
    } catch (e) {
      end({ status: 'error', result: `Arguments JSON invalides pour ${def.name} : ${(e as Error).message}` });
      return 'ok';
    }

    const toolCtx: ToolContext = {
      conversationId: job.conversationId,
      projectId: ctx.conversation.projectId,
      messageId,
      callId: call.id,
      scope: ctx.scope,
      mode: ctx.snapshot.mode,
      agentMode: ctx.snapshot.agentMode,
      settings: ctx.settings,
      signal,
      terminals,
      events,
      host: this.deps.host,
      propose: (changes) => changes.map((c) => proposals.create(job.conversationId, messageId, call.id, c.full, { path: c.path, status: c.status, before: c.before, after: c.after })),
      ask: async (qs) => {
        record.display = { kind: 'question', questions: qs, answers: null, cancelled: false };
        update({ ...record });
        return questions.ask(job.conversationId, messageId, call.id, qs, signal);
      },
      info: { conversationTitle: ctx.conversation.title, projectName: ctx.project?.name ?? null, model: ctx.snapshot.model, provider: ctx.provider.name },
      depth: ctx.conversation.depth,
      progress: (display) => {
        record.display = display;
        update({ ...record });
      },
    };

    let target: { label: string | null; resources: string[] };
    try {
      target = def.target(args, toolCtx);
    } catch {
      target = { label: null, resources: [] };
    }
    record.target = target.label;

    // Détection de boucle : mêmes appels répétés sans progrès.
    const loop = ctx.loop.check(job.conversationId, def.name, call.arguments);
    if (loop) {
      record.status = 'awaiting_permission';
      update({ ...record });
      const decision = await loopGate.wait(loop, signal);
      if (decision === 'stop') {
        end({ status: 'cancelled', result: 'Arrêté par l’utilisateur : appels répétés sans progrès détectés.' });
        return 'stop';
      }
      ctx.loop.allowOnce(def.name, call.arguments);
    }

    // Autorisation.
    const query = { conversationId: job.conversationId, projectId: ctx.conversation.projectId, tool: def.name, family: def.family, effects: def.effects, resources: target.resources };
    const evaluation = permissions.evaluate(query, ctx.settings.permissions.policy);
    let permission: NonNullable<ToolCallRecord['permission']>;
    if (evaluation.decision === 'ask') {
      let preview = null;
      try {
        preview = def.preview ? await def.preview(args, toolCtx) : null;
      } catch (e) {
        // Le changement est impossible tel quel : inutile de demander une autorisation.
        end({ status: 'error', result: `Erreur : ${(e as Error).message}` });
        return 'ok';
      }
      record.status = 'awaiting_permission';
      update({ ...record });
      const resp = await permissions.request({ conversationId: job.conversationId, messageId, tool: def.name, family: def.family, effects: def.effects, target: target.label, arguments: call.arguments, preview, reason: evaluation.reason }, query, signal);
      permission = { decision: resp.decision, source: 'user', ruleId: null, scope: resp.scope, reason: resp.reason, decidedAt: nowIso() };
    } else {
      permission = { decision: evaluation.decision, source: evaluation.source, ruleId: evaluation.ruleId, scope: evaluation.scope, reason: evaluation.reason, decidedAt: nowIso() };
    }
    permissions.log(job.conversationId, def.name, target.label, permission);
    record.permission = permission;
    if (permission.decision === 'deny') {
      end({ status: signal.aborted ? 'cancelled' : 'denied', result: `Refusé : ${permission.reason} Ne tentez pas d’obtenir le même effet par un autre outil ; demandez à l’utilisateur si nécessaire.` });
      return 'ok';
    }

    record.status = 'running';
    update({ ...record });
    try {
      const r = await def.execute(args, toolCtx);
      end({ status: signal.aborted ? 'cancelled' : (r.status ?? 'done'), result: r.result, display: r.display ?? record.display });
    } catch (e) {
      if (signal.aborted) end({ status: 'interrupted', result: 'Annulé pendant l’exécution : l’effet est incertain.' });
      else end({ status: 'error', result: `Erreur : ${(e as Error).message}` });
    }
    return 'ok';
  }

  /** Requête auxiliaire (nommage, compactage) : texte complet, consommation enregistrée séparément. */
  private async collect(ctx: Pick<JobContext, 'adapter' | 'conn' | 'provider'>, request: ChatRequest, kind: UsageRecord['kind'], conversation: Conversation, signal: AbortSignal): Promise<string> {
    const started = performance.now();
    const usageId = this.deps.usage.start({ kind, conversationId: conversation.id, projectId: conversation.projectId, providerId: ctx.provider.id, providerName: ctx.provider.name, model: request.model });
    let text = '';
    let reasoning = '';
    let firstTokenMs: number | null = null;
    let api: Extract<StreamEvent, { type: 'usage' }> | null = null;
    try {
      for await (const ev of ctx.adapter.stream(ctx.conn, request, signal)) {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'reasoning') reasoning += ev.text;
        else if (ev.type === 'usage') api = ev;
        if ((ev.type === 'text' || ev.type === 'reasoning') && firstTokenMs === null) firstTokenMs = performance.now() - started;
      }
    } catch (e) {
      this.deps.usage.finish(usageId, { firstTokenMs, inputTokens: estimateRequestTokens(request.messages), outputTokens: estimateTokens(text + reasoning), cachedInputTokens: null, reasoningTokens: null, estimated: true, status: signal.aborted ? 'cancelled' : 'error' });
      throw e;
    }
    this.deps.usage.finish(usageId, {
      firstTokenMs,
      inputTokens: api?.inputTokens ?? estimateRequestTokens(request.messages),
      outputTokens: api?.outputTokens ?? estimateTokens(text + reasoning),
      cachedInputTokens: api?.cachedInputTokens ?? null,
      reasoningTokens: api?.reasoningTokens ?? null,
      estimated: !api,
      status: 'ok',
    });
    return text;
  }

  // ---------------------------------------------------------------------------
  // Nommage automatique
  // ---------------------------------------------------------------------------

  private async maybeName(ctx: JobContext): Promise<void> {
    const s = this.deps.settings.get();
    if (!s.chat.autoNaming) return;
    const conversation = this.deps.conversations.get(ctx.conversation.id);
    if (conversation.titleSource !== 'default' && conversation.titleSource !== 'auto') return;
    const list = this.deps.messages.list(conversation.id);
    const user = list.find((m) => m.role === 'user');
    const reply = list.find((m) => m.role === 'assistant' && m.status === 'complete');
    if (!user || !reply) return;

    let target: Pick<JobContext, 'adapter' | 'conn' | 'provider'> = ctx;
    let model = ctx.snapshot.model;
    if (s.chat.namingProviderId !== null && s.chat.namingModel) {
      target = await this.deps.providers.connection(s.chat.namingProviderId);
      model = s.chat.namingModel;
    }
    // Un agent externe ne sert pas aux requêtes auxiliaires : sans modèle de nommage dédié, pas de titre automatique.
    if (target.provider.kind === 'acp') return;
    const excerpt = (t: string) => (t.length > 1500 ? `${t.slice(0, 1500)}…` : t);
    const request: ChatRequest = {
      model,
      messages: [
        { role: 'system', content: 'Tu donnes un titre court à une conversation. Réponds uniquement par le titre : 6 mots au plus, dans la langue de la conversation, sans guillemets ni ponctuation finale.' },
        { role: 'user', content: `Utilisateur :\n${excerpt(transcriptText(user) || '(pièces jointes)')}\n\nAssistant :\n${excerpt(transcriptText(reply))}` },
      ],
      reasoningLevel: 'auto',
      temperature: null,
      maxOutputTokens: null,
    };
    const raw = await this.collect(target, request, 'naming', conversation, AbortSignal.timeout(60_000));
    const title = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.replace(/^(titre|title)\s*:\s*/i, '')
      .replace(/^["'«“\s]+|["'»”.\s]+$/g, '')
      .slice(0, 80);
    if (title) this.deps.conversations.setAutoTitle(conversation.id, title, 'ai');
  }

  // ---------------------------------------------------------------------------
  // Contexte et compactage
  // ---------------------------------------------------------------------------

  /** Tokens de la prochaine requête : dernier compteur API + estimation de la suite, ou estimation complète. */
  private measure(ctx: JobContext, excludeMessageId: Id | null): { tokens: number; source: 'api' | 'estimate' } {
    const { request } = this.buildRequest(ctx, excludeMessageId);
    const estimate = estimateRequestTokens(request.messages);
    const list = this.deps.messages.list(ctx.conversation.id).filter((m) => m.id !== excludeMessageId);
    const latest = this.deps.compactions.latest(ctx.conversation.id);
    const lastApi = [...list].reverse().find((m) => m.role === 'assistant' && m.usage && !m.usage.estimated && m.usage.inputTokens !== null && (!latest || m.seq > latest.upToSeq));
    if (!lastApi) return { tokens: estimate, source: 'estimate' };
    const after = list.filter((m) => m.seq > lastApi.seq);
    const tail = estimateRequestTokens(buildHistory(after, { attachments: { text: () => '', dataUrl: () => '' }, vision: null }).messages);
    return { tokens: Math.max(estimate, (lastApi.usage!.inputTokens ?? 0) + (lastApi.usage!.outputTokens ?? 0) + tail), source: 'api' };
  }

  async contextUsage(conversationId: Id): Promise<ContextUsage> {
    const compactions = this.deps.compactions.list(conversationId).length;
    let ctx: JobContext;
    try {
      ctx = await this.prepare(conversationId);
    } catch {
      return { conversationId, tokens: 0, source: 'estimate', contextWindow: null, maxOutputTokens: null, compactions };
    }
    const active = this.active.get(conversationId);
    const m = this.measure(ctx, active?.state.messageId ?? null);
    return { conversationId, tokens: m.tokens, source: m.source, contextWindow: ctx.contextWindow, maxOutputTokens: ctx.snapshot.maxOutputTokens, compactions };
  }

  private async maybeAutoCompact(job: Job, ctx: JobContext, assistantId: Id): Promise<void> {
    const s = ctx.settings.chat;
    if (!s.autoCompact || !ctx.contextWindow || ctx.provider.kind === 'acp') return;
    const reserve = ctx.snapshot.maxOutputTokens ?? Math.min(8192, Math.round(ctx.contextWindow * 0.2));
    const budget = Math.max(1024, ctx.contextWindow - reserve);
    const { tokens } = this.measure(ctx, assistantId);
    if (tokens <= (budget * s.compactThreshold) / 100) return;
    // Rien à résumer (seuls les derniers échanges conservés) : pas de requête, pas d'état « compactage ».
    const all = this.deps.messages.list(ctx.conversation.id).filter((m) => m.id !== assistantId);
    if (compactionCut(all, s.compactKeepTurns, this.deps.compactions.latest(ctx.conversation.id)?.upToSeq ?? null) === null) return;
    Object.assign(job.state, { status: 'compacting' });
    this.deps.events.emit('generation.state', { ...job.state });
    try {
      await this.compactWith(ctx, 'auto', job.controller.signal, assistantId, tokens);
    } catch (e) {
      if (job.controller.signal.aborted) throw e;
      this.deps.logger.warn('compaction', 'Compactage automatique impossible', { error: (e as Error).message });
    } finally {
      Object.assign(job.state, { status: 'running' });
      this.deps.events.emit('generation.state', { ...job.state });
    }
  }

  /** Compactage manuel (hors génération). */
  async compact(conversationId: Id): Promise<Compaction> {
    if (this.active.has(conversationId)) throw new HarnessError('busy', 'Compactage impossible pendant une génération');
    const ctx = await this.prepare(conversationId);
    const compaction = await this.compactWith(ctx, 'manual', AbortSignal.timeout(300_000), null, this.measure(ctx, null).tokens);
    if (!compaction) throw new HarnessError('invalid_argument', `Rien à compacter : les ${ctx.settings.chat.compactKeepTurns} derniers échanges sont toujours conservés intacts.`);
    return compaction;
  }

  private async compactWith(ctx: JobContext, trigger: 'manual' | 'auto', signal: AbortSignal, excludeMessageId: Id | null, tokensBefore: number): Promise<Compaction | null> {
    const { messages, compactions, conversations } = this.deps;
    const conversation = conversations.get(ctx.conversation.id);
    const all = messages.list(conversation.id).filter((m) => m.id !== excludeMessageId && m.status !== 'streaming');
    const previous = compactions.latest(conversation.id);
    const cut = compactionCut(all, ctx.settings.chat.compactKeepTurns, previous?.upToSeq ?? null);
    if (cut === null) return null;
    const slice = all.filter((m) => m.seq <= cut && (!previous || m.seq > previous.upToSeq));
    if (slice.length === 0) return null;
    const transcript = slice
      .map((m) => {
        const files = m.parts.filter((p) => p.type === 'attachment').map((p) => (p as { attachment: AttachmentRef }).attachment.name);
        return `### ${m.role === 'user' ? 'Utilisateur' : 'Assistant'}\n${transcriptText(m)}${files.length ? `\n(Pièces jointes : ${files.join(', ')})` : ''}`;
      })
      .join('\n\n');
    const request: ChatRequest = {
      model: ctx.snapshot.model,
      messages: [
        {
          role: 'system',
          content:
            'Tu résumes une conversation pour qu’un assistant puisse la poursuivre sans l’historique complet. Conserve : objectifs, faits établis, décisions, contraintes, noms de fichiers, extraits de code ou valeurs indispensables, questions ouvertes. Écris dans la langue de la conversation, de façon structurée et concise (500 mots maximum).',
        },
        { role: 'user', content: `${previous ? `Résumé précédent :\n${previous.summary}\n\n` : ''}Échanges à résumer :\n\n${transcript}` },
      ] satisfies ChatMessage[],
      reasoningLevel: 'auto',
      temperature: null,
      maxOutputTokens: null,
    };
    const summary = (await this.collect(ctx, request, 'compaction', conversation, signal)).trim();
    if (!summary) throw new HarnessError('provider_stream', 'Le modèle a renvoyé un résumé vide');
    return compactions.add({ conversationId: conversation.id, upToSeq: cut, summary, model: ctx.snapshot.model, estimatedTokensBefore: tokensBefore, trigger });
  }
}

function userParts(text: string, attachments: AttachmentRef[]): MessagePart[] {
  return [...(text ? [{ type: 'text' as const, text }] : []), ...attachments.map((attachment) => ({ type: 'attachment' as const, attachment }))];
}

function provisionalTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, ' ').trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}
