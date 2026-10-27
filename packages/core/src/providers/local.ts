import type { CatalogModel, ConnectionTestResult } from '@monolith/contracts';
import type { ChatRequest, ProviderAdapter, ProviderConnection, StreamEvent } from './adapter.ts';
import type { OpenAICompatibleAdapter } from './openai-compatible.ts';
import type { LocalModelService } from '../local/service.ts';

/**
 * Fournisseur « Modèles locaux » : chaque modèle est un fichier GGUF ; le serveur llama.cpp est
 * démarré à la demande (127.0.0.1, port libre) et interrogé via son API compatible OpenAI.
 */
export class LocalAdapter implements ProviderAdapter {
  readonly kind = 'local' as const;

  constructor(
    private readonly local: () => LocalModelService,
    private readonly openai: OpenAICompatibleAdapter,
  ) {}

  async listModels(): Promise<CatalogModel[]> {
    return this.local()
      .models()
      .map((m) => ({
        id: m.id,
        label: `${m.meta?.name ?? m.id.replace(/\.gguf$/i, '')}${m.quant ? ` (${m.quant})` : ''}`,
        owner: m.repo,
        contextWindow: m.meta?.contextLength ?? null,
        maxOutputTokens: null,
        capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: false, tools: m.meta?.hasChatTemplate ?? null },
      }));
  }

  async test(): Promise<ConnectionTestResult> {
    const engine = this.local().engine();
    const models = this.local().models();
    const ok = engine.installed && models.length > 0;
    return { ok, status: null, latencyMs: 0, modelCount: models.length, code: ok ? 'ok' : 'unavailable', message: !engine.installed ? 'Moteur llama.cpp non installé (Réglages › Modèles locaux).' : models.length ? `llama.cpp ${engine.version ?? ''} · ${models.length} modèle(s)` : 'Aucun modèle GGUF installé.', usedCompletion: false };
  }

  async *stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const port = await this.local().ensureRunning(request.model, signal);
    try {
      yield* this.openai.stream({ ...conn, kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: null, options: { ...conn.options, streamUsage: true } }, request, signal);
    } finally {
      this.local().touch();
    }
  }
}
