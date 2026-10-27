import type { CatalogModel, ConnectionTestResult, ProviderKind, ProviderOptions, ReasoningLevel } from '@monolith/contracts';

/** Message normalisé envoyé à un adaptateur (indépendant du protocole). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  reasoningLevel: ReasoningLevel;
  temperature: number | null;
  maxOutputTokens: number | null;
}

/** Événements normalisés produits par tous les adaptateurs. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningTokens: number | null }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'; raw: string | null }
  | { type: 'notice'; level: 'info' | 'warning'; code: string; text: string };

export interface ProviderConnection {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string | null;
  options: ProviderOptions;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  listModels(conn: ProviderConnection, signal: AbortSignal): Promise<CatalogModel[]>;
  test(conn: ProviderConnection, opts: { model?: string; allowCompletion?: boolean }, signal: AbortSignal): Promise<ConnectionTestResult>;
  stream(conn: ProviderConnection, request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
