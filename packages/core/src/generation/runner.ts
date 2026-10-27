import {
  HarnessError,
  type Conversation,
  type GenerationSnapshot,
  type GenerationState,
  type Id,
  type Message,
  type MessageDelta,
  type MessageError,
  type MessagePart,
  type MessageStatus,
  type MessageUsage,
  type SendInput,
  type SendResult,
} from '@monolith/contracts';
import type { EventBus } from '../events.ts';
import type { Logger } from '../log/logger.ts';
import type { ConversationService } from '../services/conversations.ts';
import type { MessageService } from '../services/messages.ts';
import type { ProjectService } from '../services/projects.ts';
import type { ProviderService } from '../services/providers.ts';
import type { SettingsService } from '../services/settings.ts';
import type { UsageService } from '../services/usage.ts';
import type { ChatRequest, StreamEvent } from '../providers/adapter.ts';
import { ProviderError } from '../providers/http.ts';
import { decideRetry } from './retry.ts';
import { buildHistory, buildSystemPrompt } from './prompt.ts';
import { estimateTokens, sleep } from '../util.ts';

const MAX_INPUT = 1_000_000;
const DELTA_FLUSH_MS = 32;
const PERSIST_EVERY_MS = 1000;

interface ActiveGeneration {
  conversationId: Id;
  messageId: Id;
  controller: AbortController;
  state: GenerationState;
  done: Promise<void>;
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
}

/**
 * Exécute les générations. Chaque génération fige un instantané de sa configuration au
 * démarrage : modifier ensuite le modèle, le fournisseur ou les réglages n'affecte que
 * les générations suivantes. Plusieurs conversations peuvent générer en parallèle.
 */
export class GenerationRunner {
  private readonly active = new Map<Id, ActiveGeneration>();

  constructor(private readonly deps: GenerationDeps) {
    deps.conversations.isGenerating = (id) => this.active.has(id);
  }

  list(): GenerationState[] {
    return [...this.active.values()].map((g) => ({ ...g.state }));
  }

  isActive(conversationId: Id): boolean {
    return this.active.has(conversationId);
  }

  /** Attend la fin de toutes les générations (tests, arrêt propre). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((g) => g.done));
  }

  async send(conversationId: Id, input: SendInput): Promise<SendResult> {
    const { conversations, messages, settings, providers, projects, events } = this.deps;
    const text = typeof input?.text === 'string' ? input.text : '';
    if (!text.trim()) throw new HarnessError('invalid_argument', 'Message vide');
    if (text.length > MAX_INPUT) throw new HarnessError('invalid_argument', `Message trop long (${MAX_INPUT} caractères maximum)`);
    if (this.active.has(conversationId)) throw new HarnessError('busy', 'Une génération est déjà en cours dans cette conversation');

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
    const project = conversation.projectId !== null ? projects.get(conversation.projectId) : null;

    const snapshot: GenerationSnapshot = {
      providerId: provider.id,
      providerName: provider.name,
      providerKind: provider.kind,
      model,
      reasoningLevel: conversation.reasoningLevel,
      mode: conversation.mode,
      agentMode: conversation.agentMode,
      responseStyle: s.chat.responseStyle,
      temperature: conn.options.temperature,
      maxOutputTokens: conn.options.maxOutputTokens,
      startedAt: new Date().toISOString(),
    };
    const system = buildSystemPrompt({ responseStyle: s.chat.responseStyle, customInstructions: s.chat.customInstructions, project, goal: conversation.goal });
    const policy = { maxAttempts: s.network.retryMaxAttempts, baseDelayMs: s.network.retryBaseDelayMs, retryTruncatedJson400: s.network.retryTruncatedJson400 };

    const userMessage = messages.create({ conversationId, role: 'user', status: 'complete', parts: [{ type: 'text', text }] });
    const assistant = messages.create({ conversationId, role: 'assistant', status: 'streaming', parts: [], snapshot });
    conversations.saveDraft(conversationId, '');
    events.emit('message.added', { message: userMessage });
    events.emit('message.added', { message: assistant });
    if (conversation.titleSource === 'default') conversations.setAutoTitle(conversationId, provisionalTitle(text));

    const history = buildHistory(messages.list(conversationId).filter((m) => m.id !== assistant.id));
    const request: ChatRequest = {
      model,
      messages: [{ role: 'system', content: system }, ...history],
      reasoningLevel: snapshot.reasoningLevel,
      temperature: snapshot.temperature,
      maxOutputTokens: snapshot.maxOutputTokens,
    };

    const controller = new AbortController();
    const state: GenerationState = { conversationId, messageId: assistant.id, status: 'running', attempt: 1 };
    const gen: ActiveGeneration = { conversationId, messageId: assistant.id, controller, state, done: Promise.resolve() };
    this.active.set(conversationId, gen);
    conversations.touch(conversationId);
    events.emit('generation.state', { ...state });

    gen.done = this.run(gen, conversation, snapshot, request, policy, (signal) => adapter.stream(conn, request, signal))
      .catch((error: unknown) => this.deps.logger.error('generation', 'Erreur inattendue', error))
      .finally(() => this.release(gen));
    return { userMessageId: userMessage.id, assistantMessageId: assistant.id };
  }

  /** Libère la conversation avant l'annonce du message final : un client qui relit voit `generating: false`. */
  private release(gen: ActiveGeneration): void {
    if (this.active.get(gen.conversationId) !== gen) return;
    this.active.delete(gen.conversationId);
    this.deps.events.emit('generation.state', { ...gen.state, status: 'finished' });
    try {
      this.deps.conversations.touch(gen.conversationId);
    } catch {
      /* conversation supprimée pendant la génération */
    }
  }

  cancel(conversationId: Id): boolean {
    const gen = this.active.get(conversationId);
    if (!gen) return false;
    gen.controller.abort(new HarnessError('cancelled', 'Génération annulée'));
    return true;
  }

  cancelAll(): void {
    for (const g of this.active.values()) g.controller.abort(new HarnessError('cancelled', 'Arrêt du moteur'));
  }

  private async run(
    gen: ActiveGeneration,
    conversation: Conversation,
    snapshot: GenerationSnapshot,
    request: ChatRequest,
    policy: { maxAttempts: number; baseDelayMs: number; retryTruncatedJson400: boolean },
    open: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
  ): Promise<void> {
    const { events, messages, usage, logger } = this.deps;
    const signal = gen.controller.signal;
    const started = performance.now();
    const parts: MessagePart[] = [];
    let firstTokenMs: number | null = null;
    let apiUsage: Extract<StreamEvent, { type: 'usage' }> | null = null;
    let finish: Extract<StreamEvent, { type: 'finish' }> | null = null;
    let status: MessageStatus = 'complete';
    let error: MessageError | null = null;
    let lastPersist = performance.now();

    // Regroupement des deltas pour limiter les réveils d'IPC et de rendu.
    let pending: MessageDelta[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const deltas = pending;
      pending = [];
      events.emit('message.delta', { conversationId: gen.conversationId, messageId: gen.messageId, deltas });
    };
    const queue = (d: MessageDelta) => {
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
        queue({ kind: 'part', partIndex: parts.length - 1, part: { ...part } });
        (part as { text: string }).text = text;
      }
      queue({ kind: type, partIndex: parts.length - 1, text });
      if (performance.now() - lastPersist > PERSIST_EVERY_MS) {
        lastPersist = performance.now();
        messages.saveParts(gen.messageId, parts);
      }
    };
    const notice = (level: 'info' | 'warning' | 'error', code: string, text: string) => {
      const part: MessagePart = { type: 'notice', level, code, text };
      parts.push(part);
      queue({ kind: 'part', partIndex: parts.length - 1, part });
    };

    const usageId = usage.start({
      kind: 'chat',
      conversationId: gen.conversationId,
      projectId: conversation.projectId,
      providerId: snapshot.providerId,
      providerName: snapshot.providerName,
      model: snapshot.model,
    });

    for (let attempt = 1; ; attempt++) {
      gen.state.attempt = attempt;
      try {
        for await (const ev of open(signal)) {
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
        const outputStarted = parts.some((p) => p.type !== 'notice');
        if (signal.aborted || (e instanceof HarnessError && e.code === 'cancelled')) {
          status = 'cancelled';
          break;
        }
        const decision = decideRetry(e, attempt, policy, outputStarted);
        if (decision.retry) {
          logger.warn('generation', 'Nouvelle tentative', { conversationId: gen.conversationId, attempt, reason: decision.reason, delayMs: decision.delayMs });
          Object.assign(gen.state, { status: 'retrying', retryReason: decision.reason, retryInMs: decision.delayMs });
          events.emit('generation.state', { ...gen.state });
          try {
            await sleep(decision.delayMs, signal);
          } catch {
            status = 'cancelled';
            break;
          }
          Object.assign(gen.state, { status: 'running', attempt: attempt + 1, retryReason: undefined, retryInMs: undefined });
          events.emit('generation.state', { ...gen.state });
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
        logger.warn('generation', 'Génération en erreur', { conversationId: gen.conversationId, code: he.code, attempt });
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
        error = { code: finish?.reason === 'content_filter' ? 'provider_refusal' : 'provider_stream', message: 'Le fournisseur n’a renvoyé aucun contenu.', attempts: gen.state.attempt };
      }
    }

    const durationMs = performance.now() - started;
    const outputText = parts.filter((p) => p.type !== 'notice').map((p) => (p as { text: string }).text).join('');
    const finalUsage: MessageUsage = apiUsage
      ? { inputTokens: apiUsage.inputTokens, outputTokens: apiUsage.outputTokens, cachedInputTokens: apiUsage.cachedInputTokens, reasoningTokens: apiUsage.reasoningTokens, estimated: false }
      : {
          inputTokens: estimateTokens(request.messages.map((m) => m.content).join('\n')),
          outputTokens: estimateTokens(outputText),
          cachedInputTokens: null,
          reasoningTokens: null,
          estimated: true,
        };

    if (flushTimer) clearTimeout(flushTimer);
    flush();
    let final: Message | null = null;
    try {
      final = messages.finish(gen.messageId, { status, parts, usage: finalUsage, error, durationMs, firstTokenMs });
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
    this.release(gen);
    if (final) events.emit('message.updated', { message: final });
  }
}

function provisionalTitle(text: string): string {
  const firstLine = text.replace(/\s+/g, ' ').trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}
