import type { CatalogModel, ConnectionTestResult, ProviderKind } from '@monolith/contracts';
import type { ChatRequest, ProviderAdapter, ProviderConnection, StreamEvent } from './adapter.ts';
import { HttpClient, ProviderError, readBody } from './http.ts';
import { SseParser } from './sse.ts';
import { HarnessError } from '@monolith/contracts';

interface ChunkChoice {
  delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
  message?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

interface Chunk {
  choices?: ChunkChoice[];
  usage?: Usage | null;
  error?: { message?: string; code?: string | number } | string;
}

interface ModelEntry {
  id: string;
  name?: string;
  owned_by?: string;
  context_length?: number;
  context_window?: number;
  max_model_len?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function headers(conn: ProviderConnection): Record<string, string> {
  const h: Record<string, string> = { ...conn.options.headers };
  if (conn.apiKey) h.authorization = `Bearer ${conn.apiKey}`;
  return h;
}

function finishReason(raw: string | null | undefined): Extract<StreamEvent, { type: 'finish' }>['reason'] {
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
    case 'safety':
      return 'content_filter';
    default:
      return 'other';
  }
}

/**
 * Sépare un bloc `<think>…</think>` placé en tête de réponse (modèles servis par Ollama, llama.cpp…)
 * pour l'afficher comme réflexion. Tout autre usage de la balise reste du texte.
 */
export class ThinkTagSplitter {
  private state: 'start' | 'inside' | 'text' = 'start';
  private pending = '';

  push(content: string): StreamEvent[] {
    if (this.state === 'text') return content ? [{ type: 'text', text: content }] : [];
    this.pending += content;
    const out: StreamEvent[] = [];
    if (this.state === 'start') {
      const trimmed = this.pending.trimStart();
      if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return out; // attendre la suite
      if (trimmed.startsWith('<think>')) {
        this.state = 'inside';
        this.pending = trimmed.slice(7);
      } else {
        this.state = 'text';
        const text = this.pending;
        this.pending = '';
        return text ? [{ type: 'text', text }] : [];
      }
    }
    if (this.state === 'inside') {
      const end = this.pending.indexOf('</think>');
      if (end === -1) {
        // Conserver un éventuel début de balise fermante coupé entre deux fragments.
        const keep = partialSuffix(this.pending, '</think>');
        const emit = this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        if (emit) out.push({ type: 'reasoning', text: emit });
      } else {
        const reasoning = this.pending.slice(0, end);
        const rest = this.pending.slice(end + 8).replace(/^\s+/, '');
        this.pending = '';
        this.state = 'text';
        if (reasoning) out.push({ type: 'reasoning', text: reasoning });
        if (rest) out.push({ type: 'text', text: rest });
      }
    }
    return out;
  }

  flush(): StreamEvent[] {
    const text = this.pending;
    this.pending = '';
    if (!text) return [];
    return [{ type: this.state === 'inside' ? 'reasoning' : 'text', text }];
  }
}

function partialSuffix(text: string, token: string): number {
  for (let n = Math.min(token.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(token.slice(0, n))) return n;
  }
  return 0;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(
    readonly kind: ProviderKind,
    private readonly http: HttpClient,
  ) {}

  async listModels(conn: ProviderConnection, signal: AbortSignal): Promise<CatalogModel[]> {
    const body = await this.http.json<{ data?: ModelEntry[]; models?: ModelEntry[] }>(joinUrl(conn.baseUrl, 'models'), {
      headers: headers(conn),
      signal,
      connectTimeoutMs: conn.options.connectTimeoutSec * 1000,
    });
    const list = body.data ?? body.models ?? [];
    if (!Array.isArray(list)) throw new ProviderError('provider_stream', 'Catalogue de modèles illisible', null, false);
    return list
      .filter((m) => m && typeof m.id === 'string')
      .map((m): CatalogModel => {
        const id = m.id.replace(/^models\//, '');
        const params = m.supported_parameters ?? [];
        return {
          id,
          label: m.name && m.name !== m.id ? m.name : id,
          owner: m.owned_by ?? null,
          contextWindow: m.context_length ?? m.context_window ?? m.top_provider?.context_length ?? m.max_model_len ?? null,
          maxOutputTokens: m.top_provider?.max_completion_tokens ?? null,
          capabilities: {
            // Catalogue OpenRouter : le paramètre unifié `reasoning` accepte les intensités low/medium/high.
            reasoningLevels: params.includes('reasoning') ? ['low', 'medium', 'high'] : [],
            reasoningSource: params.includes('reasoning') ? 'catalog' : 'unknown',
            rejectedLevels: [],
            vision: m.architecture?.input_modalities ? m.architecture.input_modalities.includes('image') : null,
            tools: params.length ? params.includes('tools') : null,
          },
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async test(conn: ProviderConnection, opts: { model?: string; allowCompletion?: boolean }, signal: AbortSignal): Promise<ConnectionTestResult> {
    const started = performance.now();
    try {
      const models = await this.listModels(conn, signal);
      return { ok: true, status: 200, latencyMs: Math.round(performance.now() - started), modelCount: models.length, code: 'ok', message: '', usedCompletion: false };
    } catch (error) {
      const pe = error instanceof ProviderError ? error : null;
      const catalogMissing = pe && (pe.status === 404 || pe.status === 405);
      if (catalogMissing && opts.allowCompletion && opts.model) {
        try {
          await this.http.json(joinUrl(conn.baseUrl, 'chat/completions'), {
            method: 'POST',
            headers: headers(conn),
            body: { model: opts.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
            signal,
            connectTimeoutMs: conn.options.connectTimeoutSec * 1000,
          });
          return { ok: true, status: 200, latencyMs: Math.round(performance.now() - started), modelCount: null, code: 'ok_completion', message: '', usedCompletion: true };
        } catch (inner) {
          return failure(inner, started, true);
        }
      }
      const result = failure(error, started, false);
      if (catalogMissing) result.code = 'catalog_unavailable';
      return result;
    }
  }

  async *stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: true,
    };
    if (conn.options.streamUsage) body.stream_options = { include_usage: true };
    if (request.temperature !== null) body.temperature = request.temperature;
    if (request.maxOutputTokens !== null) body.max_tokens = request.maxOutputTokens;
    if (request.extraBody) Object.assign(body, request.extraBody);

    let response: Response;
    try {
      response = await this.http.request(joinUrl(conn.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { ...headers(conn), accept: 'text/event-stream' },
        body,
        signal,
        connectTimeoutMs: conn.options.connectTimeoutSec * 1000,
      });
    } catch (error) {
      // Certains serveurs refusent `stream_options` : nouvelle tentative immédiate sans, signalée.
      if (error instanceof ProviderError && error.status === 400 && conn.options.streamUsage && /stream_options|include_usage/i.test(error.body)) {
        yield { type: 'notice', level: 'info', code: 'stream_usage_unsupported', text: 'Le fournisseur refuse stream_options : compteurs de tokens estimés.' };
        yield* this.stream({ ...conn, options: { ...conn.options, streamUsage: false } }, request, signal);
        return;
      }
      throw error;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      // Serveur ignorant `stream: true` : réponse complète d'un bloc.
      const chunk = (await response.json()) as Chunk;
      yield* this.fromChunk(chunk, new ThinkTagSplitter(), true);
      return;
    }

    const parser = new SseParser();
    const splitter = new ThinkTagSplitter();
    for await (const bytes of readBody(response, conn.options.idleTimeoutSec * 1000, signal)) {
      for (const ev of parser.push(bytes)) {
        if (ev.data !== '[DONE]') yield* this.parseEvent(ev.data, splitter);
      }
    }
    for (const ev of parser.end()) {
      if (ev.data !== '[DONE]') yield* this.parseEvent(ev.data, splitter);
    }
    yield* splitter.flush();
  }

  private *parseEvent(data: string, splitter: ThinkTagSplitter): Iterable<StreamEvent> {
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      // Un événement illisible isolé est ignoré plutôt que d'interrompre la réponse.
      yield { type: 'notice', level: 'warning', code: 'invalid_chunk', text: 'Fragment illisible ignoré.' };
      return;
    }
    yield* this.fromChunk(chunk, splitter, false);
  }

  private *fromChunk(chunk: Chunk, splitter: ThinkTagSplitter, whole: boolean): Iterable<StreamEvent> {
    if (chunk.error) {
      const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'Erreur du fournisseur');
      throw new ProviderError('provider_stream', message, null, true);
    }
    for (const choice of chunk.choices ?? []) {
      const d = whole ? choice.message : choice.delta;
      const reasoning = d?.reasoning_content ?? (d as { reasoning?: string | null } | undefined)?.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (d?.content) yield* splitter.push(d.content);
      if (whole) yield* splitter.flush();
      if (choice.finish_reason) yield { type: 'finish', reason: finishReason(choice.finish_reason), raw: choice.finish_reason };
    }
    if (chunk.usage) {
      const u = chunk.usage;
      yield {
        type: 'usage',
        inputTokens: u.prompt_tokens ?? null,
        outputTokens: u.completion_tokens ?? null,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? null,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      };
    }
  }
}

function failure(error: unknown, started: number, usedCompletion: boolean): ConnectionTestResult {
  const pe = error instanceof ProviderError ? error : null;
  const he = error instanceof HarnessError ? error : null;
  return {
    ok: false,
    status: pe?.status ?? null,
    latencyMs: Math.round(performance.now() - started),
    modelCount: null,
    code: he?.code ?? 'internal',
    message: error instanceof Error ? error.message : String(error),
    usedCompletion,
  };
}
