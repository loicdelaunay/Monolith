import type { ProviderOptions, ProviderPreset } from './model.ts';

export const DEFAULT_PROVIDER_OPTIONS: ProviderOptions = {
  headers: {},
  connectTimeoutSec: 60,
  idleTimeoutSec: 120,
  streamUsage: true,
  temperature: null,
  maxOutputTokens: null,
};

const T5 = 'Adaptateur natif prévu en tranche T5 ; utilisez en attendant le préréglage compatible OpenAI lorsqu’il existe.';

/**
 * Préréglages de connexion. Les URL sont celles documentées publiquement par chaque fournisseur.
 * Plusieurs connexions peuvent partager un préréglage : elles restent indépendantes.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', kind: 'openai-compatible', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyRequired: true, keyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://platform.openai.com/docs/api-reference/chat', available: true },
  { id: 'deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyRequired: true, keyUrl: 'https://platform.deepseek.com/api_keys', docsUrl: 'https://api-docs.deepseek.com/', available: true },
  { id: 'openrouter', kind: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, keyUrl: 'https://openrouter.ai/keys', docsUrl: 'https://openrouter.ai/docs', available: true },
  { id: 'gemini-openai', kind: 'openai-compatible', name: 'Google AI Studio (compatibilité OpenAI)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true, keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/openai', available: true },
  { id: 'groq', kind: 'openai-compatible', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, keyUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/openai', available: true },
  { id: 'mistral', kind: 'openai-compatible', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyRequired: true, keyUrl: 'https://console.mistral.ai/api-keys', docsUrl: 'https://docs.mistral.ai/api/', available: true },
  { id: 'nvidia', kind: 'openai-compatible', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', keyRequired: true, keyUrl: 'https://build.nvidia.com/', docsUrl: 'https://docs.api.nvidia.com/', available: true },
  { id: 'zai', kind: 'openai-compatible', name: 'Z.ai', baseUrl: 'https://api.z.ai/api/paas/v4', keyRequired: true, keyUrl: 'https://z.ai/manage-apikey/apikey-list', docsUrl: 'https://docs.z.ai/', available: true },
  { id: 'ollama', kind: 'openai-compatible', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1', keyRequired: false, keyUrl: null, docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md', available: true },
  { id: 'lmstudio', kind: 'openai-compatible', name: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:1234/v1', keyRequired: false, keyUrl: null, docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai', available: true },
  { id: 'llamacpp', kind: 'openai-compatible', name: 'llama.cpp server (local)', baseUrl: 'http://127.0.0.1:8080/v1', keyRequired: false, keyUrl: null, docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server', available: true },
  { id: 'custom', kind: 'openai-compatible', name: 'Compatible OpenAI (personnalisé)', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: null, available: true },
  { id: 'gemini', kind: 'gemini', name: 'Google AI Studio / Gemini (natif)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true, keyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs', available: false, unavailableReason: T5 },
  { id: 'vertex', kind: 'vertex', name: 'Vertex AI', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs', available: false, unavailableReason: T5 },
  { id: 'opencode', kind: 'opencode', name: 'OpenCode', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: 'https://opencode.ai/docs', available: false, unavailableReason: T5 },
  { id: 'acp', kind: 'acp', name: 'Agent externe (ACP)', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: 'https://agentclientprotocol.com/', available: false, unavailableReason: T5 },
  { id: 'composite', kind: 'composite', name: 'Modèle composé', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: null, available: false, unavailableReason: T5 },
  { id: 'local', kind: 'local', name: 'Modèle local intégré (GGUF)', baseUrl: '', keyRequired: false, keyUrl: null, docsUrl: null, available: false, unavailableReason: 'Moteur d’inférence intégré prévu en tranche T10. Les serveurs locaux compatibles OpenAI (Ollama, LM Studio, llama.cpp) fonctionnent déjà.' },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
