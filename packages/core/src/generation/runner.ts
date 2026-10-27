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
  type UsageRecord,
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
import type { ChatMessage, ChatRequest, ProviderAdapter, ProviderConnection, StreamEvent } from '../providers/adapter.ts';
import { ProviderError } from '../providers/http.ts';
import { decideRetry } from './retry.ts';
import { buildHistory, buildSystemPrompt, compactionCut, estimateRequestTokens, plainText } from './prompt.ts';
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

  /** Requête complète pour la conversation : instructions, résumé de compactage, historique reconstruit pour le modèle cible. */
  private buildRequest(ctx: JobContext, excludeMessageId: Id | null): { request: ChatRequest; droppedImages: number } {
    const { messages, compactions, attachments } = this.deps;
    const conversation = this.deps.conversations.get(ctx.conversation.id);
    const latest = compactions.latest(conversation.id);
    const system = buildSystemPrompt({
      responseStyle: ctx.snapshot.responseStyle,
      customInstructions: ctx.settings.chat.customInstructions,
      project: ctx.project,
      goal: conversation.goal,
      compactionSummary: latest?.summary ?? null,
    });
    const history = buildHistory(
      messages.list(conversation.id).filter((m) => m.id !== excludeMessageId && m.status !== 'streaming'),
      {
        attachments: { text: (r) => attachments.text(r.id), dataUrl: (r) => attachments.dataUrl(r.id) },
        vision: ctx.caps?.vision ?? null,
        compactedUpToSeq: latest?.upToSeq ?? null,
      },
    );
    return {
      droppedImages: history.droppedImages,
      request: {
        model: ctx.snapshot.model,
        messages: [{ role: 'system', content: system }, ...history.messages],
        reasoningLevel: ctx.snapshot.reasoningLevel,
        temperature: ctx.snapshot.temperature,
        maxOutputTokens: ctx.snapshot.maxOutputTokens,
        extraBody: ctx.reasoningBody,
      },
    };
  }

  private async runTurn(job: Job, ctx: JobContext, messageId: Id): Promise<MessageStatus> {
    const { events, messages, usage, logger, providers } = this.deps;
    const signal = job.controller.signal;
    const started = performance.now();
    const parts: MessagePart[] = [];
    let firstTokenMs: number | null = null;
    let apiUsage: Extract<StreamEvent, { type: 'usage' }> | null = null;
    let finish: Extract<StreamEvent, { type: 'finish' }> | null = null;
    let status: MessageStatus = 'complete';
    let error: MessageError | null = null;
    let lastPersist = performance.now();
    let snapshot = ctx.snapshot;

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
      if (performance.now() - lastPersist > PERSIST_EVERY_MS) {
        lastPersist = performance.now();
        messages.saveParts(messageId, parts);
      }
    };
    const notice = (level: 'info' | 'warning' | 'error', code: string, text: string) => {
      const part: MessagePart = { type: 'notice', level, code, text };
      parts.push(part);
      queueDelta({ kind: 'part', partIndex: parts.length - 1, part });
    };

    const built = this.buildRequest(ctx, messageId);
    let request = built.request;
    if (built.droppedImages) notice('warning', 'images_dropped', `${built.droppedImages} image(s) non transmise(s) : le modèle « ${ctx.snapshot.model} » est déclaré sans vision.`);
    if (ctx.snapshot.reasoning?.fallback) notice('info', 'reasoning_fallback', `Réflexion : ${ctx.snapshot.reasoning.fallback} ; requête envoyée en Auto.`);

    const usageId = usage.start({ kind: 'chat', conversationId: job.conversationId, projectId: ctx.conversation.projectId, providerId: ctx.provider.id, providerName: ctx.provider.name, model: ctx.snapshot.model });
    let reasoningRetried = false;

    for (let attempt = 1; ; attempt++) {
      job.state.attempt = attempt;
      try {
        for await (const ev of ctx.adapter.stream(ctx.conn, request, signal)) {
          switch (ev.type) {
            case 'text':
            case 'reasoning':
              append(ev.type, ev.text);
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
        const outputStarted = parts.some((p) => p.type === 'text' || p.type === 'reasoning');
        if (signal.aborted || (e instanceof HarnessError && e.code === 'cancelled')) {
          status = 'cancelled';
          break;
        }
        // Niveau de réflexion refusé explicitement : mémorisé, puis une seule nouvelle requête en Auto.
        // « Sans réflexion » n'est jamais remplacé : l'incompatibilité est signalée.
        const sent = snapshot.reasoning?.sent ?? null;
        if (!outputStarted && !reasoningRetried && sent && e instanceof ProviderError && isReasoningRejection(e.status, e.body)) {
          providers.rejectLevel(ctx.provider.id, ctx.snapshot.model, sent);
          if (sent === 'none') {
            status = 'error';
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
        const decision = decideRetry(e, attempt, ctx.policy, outputStarted);
        if (decision.retry) {
          logger.warn('generation', 'Nouvelle tentative', { conversationId: job.conversationId, attempt, reason: decision.reason, delayMs: decision.delayMs });
          Object.assign(job.state, { status: 'retrying', retryReason: decision.reason, retryInMs: decision.delayMs });
          events.emit('generation.state', { ...job.state });
          try {
            await sleep(decision.delayMs, signal);
          } catch {
            status = 'cancelled';
            break;
          }
          Object.assign(job.state, { status: 'running', attempt: attempt + 1, retryReason: undefined, retryInMs: undefined });
          events.emit('generation.state', { ...job.state });
          continue;
        }
        const he = e instanceof HarnessError ? e : new HarnessError('internal', e instanceof Error ? e.message : String(e));
        status = outputStarted ? 'interrupted' : 'error';
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

    if (status === 'complete') {
      const hasText = parts.some((p) => p.type === 'text' && p.text.trim());
      if (finish?.reason === 'length') notice('warning', 'max_tokens', 'Réponse tronquée : la limite de sortie du modèle a été atteinte.');
      else if (finish?.reason === 'content_filter') notice('warning', 'content_filter', 'Le fournisseur a interrompu ou refusé la réponse (filtre de contenu).');
      else if (!finish && hasText) notice('warning', 'no_finish', 'Le flux s’est terminé sans indication de fin : la réponse peut être incomplète.');
      if (!hasText && !parts.some((p) => p.type === 'reasoning')) {
        status = 'error';
        error = { code: finish?.reason === 'content_filter' ? 'provider_refusal' : 'provider_stream', message: 'Le fournisseur n’a renvoyé aucun contenu.', attempts: job.state.attempt };
      }
    }

    const durationMs = performance.now() - started;
    const outputText = parts.filter((p) => p.type === 'text' || p.type === 'reasoning').map((p) => (p as { text: string }).text).join('');
    const finalUsage: MessageUsage = apiUsage
      ? { inputTokens: apiUsage.inputTokens, outputTokens: apiUsage.outputTokens, cachedInputTokens: apiUsage.cachedInputTokens, reasoningTokens: apiUsage.reasoningTokens, estimated: false }
      : { inputTokens: estimateRequestTokens(request.messages), outputTokens: estimateTokens(outputText), cachedInputTokens: null, reasoningTokens: null, estimated: true };

    if (flushTimer) clearTimeout(flushTimer);
    flush();
    let final: Message | null = null;
    try {
      final = messages.finish(messageId, { status, parts, usage: finalUsage, error, durationMs, firstTokenMs });
    } catch (e) {
      // Conversation supprimée pendant la génération : rien à enregistrer.
      logger.info('generation', 'Message introuvable en fin de génération', { error: (e as Error).message });
    }
    usage.finish(usageId, {
      firstTokenMs,
      inputTokens: finalUsage.inputTokens,
      outputTokens: finalUsage.outputTokens,
      cachedInputTokens: finalUsage.cachedInputTokens,
      reasoningTokens: finalUsage.reasoningTokens,
      estimated: finalUsage.estimated,
      status: status === 'complete' ? 'ok' : status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'incomplete' : 'error',
    });
    // Dernier tour : la conversation est libérée avant l'annonce du message final.
    const lastTurn = status !== 'complete' || this.deps.queue.list(job.conversationId).every((i) => i.kind !== 'steer');
    if (lastTurn) {
      job.final = status;
      this.release(job);
    }
    if (final) events.emit('message.updated', { message: final });
    return status;
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
    const excerpt = (t: string) => (t.length > 1500 ? `${t.slice(0, 1500)}…` : t);
    const request: ChatRequest = {
      model,
      messages: [
        { role: 'system', content: 'Tu donnes un titre court à une conversation. Réponds uniquement par le titre : 6 mots au plus, dans la langue de la conversation, sans guillemets ni ponctuation finale.' },
        { role: 'user', content: `Utilisateur :\n${excerpt(plainText(user) || '(pièces jointes)')}\n\nAssistant :\n${excerpt(plainText(reply))}` },
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
    if (!s.autoCompact || !ctx.contextWindow) return;
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
        return `### ${m.role === 'user' ? 'Utilisateur' : 'Assistant'}\n${plainText(m)}${files.length ? `\n(Pièces jointes : ${files.join(', ')})` : ''}`;
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
