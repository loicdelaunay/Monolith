import { HarnessError, type CatalogModel, type ConnectionTestResult, type ReasoningLevel } from '@monolith/contracts';
import type { ChatMessage, ChatRequest, ProviderAdapter, ProviderConnection, StreamEvent, ToolCallRequest } from './adapter.ts';
import { HttpClient, ProviderError, readBody } from './http.ts';
import { SseParser } from './sse.ts';
import { failure, joinUrl } from './openai-compatible.ts';
import type { GoogleAuth } from './google-auth.ts';

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string; parts?: { inlineData: { mimeType: string; data: string } }[] };
}

interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

interface GResponse {
  candidates?: { content?: { parts?: GPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

interface GModel {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

/** Signature factice documentée par Google pour un historique sans signature (autre fournisseur, ancienne version). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/** Gemini 3 et versions suivantes (gemini-3-…, gemini-3.6-…, gemini-4-…) : signatures et niveaux de réflexion. */
const isGemini3 = (model: string) => {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(model);
  return !!m && Number.parseFloat(m[1]!) >= 3;
};
const thinks = (model: string) => /gemini-2\.5/.test(model) || isGemini3(model);

/** Traduction du niveau de réflexion en `thinkingConfig` selon la génération du modèle. */
export function thinkingConfig(model: string, level: ReasoningLevel | null): Record<string, unknown> | null {
  if (level === null) return thinks(model) ? { includeThoughts: true } : null;
  if (level === 'none') return { thinkingBudget: 0 };
  if (isGemini3(model)) return { thinkingLevel: level === 'medium' || level === 'minimal' || level === 'low' ? level : 'high', includeThoughts: true };
  const budgets: Partial<Record<ReasoningLevel, number>> = { minimal: 512, low: 1024, medium: 8192, high: /pro/.test(model) ? 32768 : 24576, max: /pro/.test(model) ? 32768 : 24576 };
  return { thinkingBudget: budgets[level] ?? -1, includeThoughts: true };
}

/** Messages normalisés → `contents` + `systemInstruction` (outils, images, signatures de réflexion). */
export function toGemini(messages: ChatMessage[], model: string): { contents: GContent[]; system: string } {
  const system: string[] = [];
  const contents: GContent[] = [];
  const names = new Map<string, string>();
  /** Parties `functionResponse` par appel : les images d'outils y sont rattachées (Gemini 3+). */
  const responses = new Map<string, GPart>();
  const push = (role: GContent['role'], parts: GPart[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    // Rôles consécutifs identiques regroupés : l'API attend une alternance utilisateur / modèle.
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''));
      continue;
    }
    if (m.role === 'tool') {
      const name = names.get(m.toolCallId ?? '') ?? 'outil';
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const part: GPart = { functionResponse: { name, response: { result: text } } };
      if (m.toolCallId) responses.set(m.toolCallId, part);
      push('user', [part]);
      continue;
    }
    // Images produites par des outils : Gemini 3+ les attend dans la réponse de fonction elle-même ;
    // les mêler à du texte utilisateur dans le tour des réponses fait refuser la requête.
    if (m.role === 'user' && m.toolImagesFor && isGemini3(model) && Array.isArray(m.content)) {
      const images = m.content.filter((p) => p.type === 'image_url');
      const attached = images.every((p, i) => {
        const target = responses.get(m.toolImagesFor![i] ?? '');
        const match = p.type === 'image_url' ? /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url) : null;
        if (!target?.functionResponse || !match) return false;
        target.functionResponse.parts = [...(target.functionResponse.parts ?? []), { inlineData: { mimeType: match[1]!, data: match[2]! } }];
        return true;
      });
      if (attached) continue;
    }
    const parts: GPart[] = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const p of m.content) {
        if (p.type === 'text') {
          if (p.text) parts.push({ text: p.text });
        } else {
          const match = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
          if (match) parts.push({ inlineData: { mimeType: match[1]!, data: match[2]! } });
        }
      }
    }
    if (m.role === 'assistant') {
      // Appels parallèles : seule la première partie porte une signature (règle de Google).
      const anySignature = (m.toolCalls ?? []).some((c) => c.meta?.thoughtSignature);
      for (const [i, c] of (m.toolCalls ?? []).entries()) {
        names.set(c.id, c.name);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(c.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          /* arguments invalides : objet vide */
        }
        const part: GPart = { functionCall: { name: c.name, args } };
        const signature = c.meta?.thoughtSignature ?? (isGemini3(model) && i === 0 && !anySignature ? SKIP_SIGNATURE : undefined);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      push('model', parts);
    } else push('user', parts);
  }
  return { contents, system: system.join('\n\n') };
}

function finish(raw: string | undefined, hasCalls: boolean): Extract<StreamEvent, { type: 'finish' }>['reason'] {
  switch (raw) {
    case 'STOP':
      return hasCalls ? 'tool_calls' : 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'other';
  }
}

/**
 * Adaptateur natif Gemini : Google AI Studio (`gemini`) et Vertex AI (`vertex`, clé Express,
 * ADC ou compte de service). Même format de requête ; seuls l'URL et l'authentification changent.
 */
export class GeminiAdapter implements ProviderAdapter {
  constructor(
    readonly kind: 'gemini' | 'vertex',
    private readonly http: HttpClient,
    private readonly auth: GoogleAuth,
  ) {}

  /** URL et en-têtes d'une méthode de modèle. */
  private async endpoint(conn: ProviderConnection, model: string, method: string, signal: AbortSignal): Promise<{ url: string; headers: Record<string, string> }> {
    const headers: Record<string, string> = { ...conn.options.headers };
    // API native : « google/gemini-… » (forme du point compatible OpenAI) devient « gemini-… ».
    const name = encodeURIComponent(this.kind === 'vertex' ? model.replace(/^google\//, '') : model).replace(/%2F/g, '/');
    if (this.kind === 'gemini') {
      if (!conn.apiKey) throw new HarnessError('provider_auth', 'Clé Google AI Studio manquante');
      headers['x-goog-api-key'] = conn.apiKey;
      return { url: joinUrl(conn.baseUrl, `models/${name}:${method}`), headers };
    }
    const g = conn.options.google;
    if (g.auth === 'express') {
      if (!conn.apiKey) throw new HarnessError('provider_auth', 'Clé API Google Cloud (mode Express) manquante');
      headers['x-goog-api-key'] = conn.apiKey;
      return { url: joinUrl(conn.baseUrl || 'https://aiplatform.googleapis.com/v1', `publishers/google/models/${name}:${method}`), headers };
    }
    const location = g.location || 'global';
    const base = conn.baseUrl || `https://${location === 'global' ? '' : `${location}-`}aiplatform.googleapis.com/v1`;
    if (g.auth === 'api_key') {
      // Clé API Google Cloud liée à un projet : API native du projet, clé dans l'en-tête (jamais dans l'URL).
      if (!conn.apiKey) throw new HarnessError('provider_auth', 'Clé API Google Cloud manquante');
      if (!g.project) throw new HarnessError('invalid_argument', 'Projet Google Cloud manquant : indiquez l’ID du projet (Réglages › Fournisseurs › Vertex AI).');
      headers['x-goog-api-key'] = conn.apiKey;
      return { url: joinUrl(base, `projects/${encodeURIComponent(g.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${name}:${method}`), headers };
    }
    const project = g.project || this.auth.defaultProject(g.auth, conn.apiKey);
    if (!project) throw new HarnessError('invalid_argument', 'Projet Google Cloud manquant (Réglages › Fournisseurs › Vertex AI).');
    headers.authorization = `Bearer ${await this.auth.token(g.auth, conn.apiKey, signal)}`;
    headers['x-goog-user-project'] = project;
    return { url: joinUrl(base, `projects/${project}/locations/${location}/publishers/google/models/${name}:${method}`), headers };
  }

  async listModels(conn: ProviderConnection, signal: AbortSignal): Promise<CatalogModel[]> {
    if (this.kind === 'vertex') return VERTEX_MODELS.map((id) => catalogEntry({ name: id, thinking: thinks(id) }));
    if (!conn.apiKey) throw new HarnessError('provider_auth', 'Clé Google AI Studio manquante');
    const out: GModel[] = [];
    let page = '';
    for (let i = 0; i < 10; i++) {
      const body = await this.http.json<{ models?: GModel[]; nextPageToken?: string }>(joinUrl(conn.baseUrl, `models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`), {
        headers: { ...conn.options.headers, 'x-goog-api-key': conn.apiKey },
        signal,
        connectTimeoutMs: conn.options.connectTimeoutSec * 1000,
      });
      out.push(...(body.models ?? []));
      if (!body.nextPageToken) break;
      page = body.nextPageToken;
    }
    return out.filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map(catalogEntry).sort((a, b) => a.id.localeCompare(b.id));
  }

  async test(conn: ProviderConnection, opts: { model?: string; allowCompletion?: boolean }, signal: AbortSignal): Promise<ConnectionTestResult> {
    const started = performance.now();
    try {
      if (this.kind === 'gemini') {
        const models = await this.listModels(conn, signal);
        return { ok: true, status: 200, latencyMs: Math.round(performance.now() - started), modelCount: models.length, code: 'ok', message: '', usedCompletion: false };
      }
      // Vertex : comptage de tokens (non facturé) — vérifie l'authentification, le projet et la région.
      const model = opts.model || 'gemini-2.5-flash';
      const { url, headers } = await this.endpoint(conn, model, 'countTokens', signal);
      await this.http.json(url, { method: 'POST', headers, body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }, signal, connectTimeoutMs: conn.options.connectTimeoutSec * 1000 });
      return { ok: true, status: 200, latencyMs: Math.round(performance.now() - started), modelCount: VERTEX_MODELS.length, code: 'ok', message: '', usedCompletion: false };
    } catch (error) {
      return failure(error, started, false);
    }
  }

  async *stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const { contents, system } = toGemini(request.messages, request.model);
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== null) generationConfig.temperature = request.temperature;
    if (request.maxOutputTokens !== null) generationConfig.maxOutputTokens = request.maxOutputTokens;
    const level = (request.extraBody?.gemini_thinking as ReasoningLevel | undefined) ?? null;
    const thinking = thinkingConfig(request.model, level);
    if (thinking) generationConfig.thinkingConfig = thinking;
    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (request.tools?.length) {
      body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
    const { url, headers } = await this.endpoint(conn, request.model, 'streamGenerateContent', signal);
    const response = await this.http.request(`${url}?alt=sse`, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body, signal, connectTimeoutMs: conn.options.connectTimeoutSec * 1000 });

    const parser = new SseParser();
    const calls: ToolCallRequest[] = [];
    let finishRaw: string | undefined;
    let usage: GResponse['usageMetadata'] | null = null;
    const handle = function* (data: string): Iterable<StreamEvent> {
      let chunk: GResponse;
      try {
        chunk = JSON.parse(data) as GResponse;
      } catch {
        yield { type: 'notice', level: 'warning', code: 'invalid_chunk', text: 'Fragment illisible ignoré.' };
        return;
      }
      if (chunk.error) throw new ProviderError('provider_stream', chunk.error.message ?? 'Erreur du fournisseur', null, true);
      if (chunk.promptFeedback?.blockReason) throw new ProviderError('provider_bad_request', `Requête bloquée par le filtre de Google (${chunk.promptFeedback.blockReason}).`, null, false);
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (part.functionCall) {
          calls.push({
            id: part.functionCall.id ?? `gcall_${calls.length}_${Date.now().toString(36)}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
            ...(part.thoughtSignature ? { meta: { thoughtSignature: part.thoughtSignature } } : {}),
          });
        } else if (part.text) yield { type: part.thought ? 'reasoning' : 'text', text: part.text };
      }
      if (cand?.finishReason) finishRaw = cand.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    };
    for await (const bytes of readBody(response, conn.options.idleTimeoutSec * 1000, signal)) {
      for (const ev of parser.push(bytes)) yield* handle(ev.data);
    }
    for (const ev of parser.end()) yield* handle(ev.data);
    for (const call of calls) yield { type: 'tool_call', call };
    if (finishRaw === 'MALFORMED_FUNCTION_CALL') yield { type: 'notice', level: 'warning', code: 'malformed_call', text: 'Le modèle a produit un appel d’outil invalide.' };
    if (finishRaw) yield { type: 'finish', reason: finish(finishRaw, calls.length > 0), raw: finishRaw };
    const u = usage as GResponse['usageMetadata'] | null;
    if (u) {
      const thoughts = u.thoughtsTokenCount ?? null;
      yield { type: 'usage', inputTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount !== undefined ? u.candidatesTokenCount + (thoughts ?? 0) : null, cachedInputTokens: u.cachedContentTokenCount ?? null, reasoningTokens: thoughts };
    }
  }
}

/** Modèles Gemini publiés sur Vertex AI (liste documentée : le catalogue Vertex n'expose pas les limites). */
export const VERTEX_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-pro-preview'];

function catalogEntry(m: GModel): CatalogModel {
  const id = m.name.replace(/^models\//, '');
  return {
    id,
    label: m.displayName ?? id,
    owner: 'google',
    contextWindow: m.inputTokenLimit ?? null,
    maxOutputTokens: m.outputTokenLimit ?? null,
    capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: /gemini/.test(id) ? true : null, tools: /gemini/.test(id) ? true : null },
  };
}
