import { HarnessError, type ModelCapabilities, type ReasoningLevel, type ReasoningResolution } from '@monolith/contracts';

/**
 * Transport du niveau de réflexion selon la connexion :
 *  - `reasoning_effort` : paramètre OpenAI (repris par Google AI Studio, Groq…) ;
 *  - `openrouter` : objet `reasoning` d'OpenRouter (`effort` ou `enabled`) ;
 *  - `thinking` : interrupteur `thinking.type` (Z.ai), sans intensités ;
 *  - `gemini` : `thinkingConfig` natif (budget ou niveau selon la génération du modèle).
 */
export type ReasoningTransport = 'reasoning_effort' | 'openrouter' | 'thinking' | 'gemini';

export function transportFor(preset: string): ReasoningTransport {
  if (preset === 'gemini' || preset === 'vertex') return 'gemini';
  if (preset === 'openrouter') return 'openrouter';
  if (preset === 'zai') return 'thinking';
  return 'reasoning_effort';
}

interface DocumentedRule {
  presets: string[];
  model: RegExp;
  levels: ReasoningLevel[];
}

/**
 * Niveaux documentés publiquement par les fournisseurs pour quelques familles de modèles.
 * Hors de cette table et sans déclaration du catalogue ou de l'utilisateur, seul Auto est proposé.
 */
const DOCUMENTED: DocumentedRule[] = [
  { presets: ['openai', 'custom'], model: /^o[134](-mini|-pro)?(-\d{4}-\d{2}-\d{2})?$/, levels: ['low', 'medium', 'high'] },
  { presets: ['openai', 'custom'], model: /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/, levels: ['minimal', 'low', 'medium', 'high'] },
  { presets: ['openai', 'custom'], model: /^gpt-5\.1(-mini|-codex)?(-\d{4}-\d{2}-\d{2})?$/, levels: ['none', 'low', 'medium', 'high'] },
  { presets: ['openai', 'custom'], model: /^gpt-5\.[2-9](-mini|-pro|-codex)?(-\d{4}-\d{2}-\d{2})?$/, levels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { presets: ['gemini-openai'], model: /^gemini-2\.5-flash/, levels: ['none', 'low', 'medium', 'high'] },
  { presets: ['gemini-openai'], model: /^gemini-2\.5-pro/, levels: ['low', 'medium', 'high'] },
  { presets: ['groq'], model: /gpt-oss/, levels: ['low', 'medium', 'high'] },
  { presets: ['gemini', 'vertex'], model: /^gemini-2\.5-pro/, levels: ['low', 'medium', 'high'] },
  { presets: ['gemini', 'vertex'], model: /^gemini-2\.5-flash/, levels: ['none', 'low', 'medium', 'high'] },
  { presets: ['gemini', 'vertex'], model: /^gemini-3(\.\d+)?-pro/, levels: ['low', 'high'] },
  { presets: ['gemini', 'vertex'], model: /^gemini-3(\.\d+)?-flash/, levels: ['minimal', 'low', 'medium', 'high'] },
  { presets: ['zai'], model: /^glm-(4\.[5-9]|[5-9])/, levels: ['none', 'on'] },
];

export function documentedLevels(preset: string, modelId: string): ReasoningLevel[] {
  const id = modelId.replace(/^[^/]+\//, '');
  return DOCUMENTED.find((r) => r.presets.includes(preset) && r.model.test(id))?.levels ?? [];
}

/** Niveaux proposés dans les sélecteurs : déclarés, moins ceux refusés par le fournisseur. */
export function availableLevels(caps: ModelCapabilities | null | undefined): ReasoningLevel[] {
  if (!caps) return [];
  return caps.reasoningLevels.filter((l) => !caps.rejectedLevels.includes(l));
}

export interface ReasoningPlan {
  resolution: ReasoningResolution;
  /** Champs ajoutés au corps de la requête. */
  body: Record<string, unknown>;
}

function payload(level: ReasoningLevel, transport: ReasoningTransport): { body: Record<string, unknown>; parameter: string } | null {
  switch (transport) {
    case 'reasoning_effort':
      if (level === 'on') return null;
      return { body: { reasoning_effort: level }, parameter: `reasoning_effort=${level}` };
    case 'openrouter':
      if (level === 'none') return { body: { reasoning: { enabled: false } }, parameter: 'reasoning.enabled=false' };
      if (level === 'on') return { body: { reasoning: { enabled: true } }, parameter: 'reasoning.enabled=true' };
      return { body: { reasoning: { effort: level } }, parameter: `reasoning.effort=${level}` };
    case 'thinking':
      if (level === 'none') return { body: { thinking: { type: 'disabled' } }, parameter: 'thinking.type=disabled' };
      return { body: { thinking: { type: 'enabled' } }, parameter: 'thinking.type=enabled' };
    case 'gemini':
      // Traduit par l'adaptateur Gemini en thinkingBudget (2.5) ou thinkingLevel (3).
      if (level === 'on') return null;
      return { body: { gemini_thinking: level }, parameter: level === 'none' ? 'thinkingConfig.thinkingBudget=0' : `thinkingConfig (${level})` };
  }
}

/**
 * Traduit le niveau demandé en paramètres réellement envoyés.
 * « Sans réflexion » n'est jamais remplacé silencieusement : s'il n'est pas pris en charge,
 * l'envoi est refusé avec une explication plutôt que de laisser le modèle raisonner.
 */
export function planReasoning(requested: ReasoningLevel, caps: ModelCapabilities | null | undefined, transport: ReasoningTransport): ReasoningPlan {
  const auto: ReasoningPlan = { resolution: { requested, sent: null, parameter: null, fallback: null }, body: {} };
  if (requested === 'auto') return auto;
  const levels = availableLevels(caps);
  if (!levels.includes(requested)) {
    const rejected = caps?.rejectedLevels.includes(requested);
    if (requested === 'none') {
      throw new HarnessError(
        'unavailable',
        rejected
          ? 'Le fournisseur a refusé la désactivation de la réflexion pour ce modèle : « Sans réflexion » est indisponible jusqu’à la prochaine actualisation des modèles.'
          : 'La désactivation de la réflexion n’est pas déclarée pour ce modèle : choisissez Auto ou déclarez ce niveau dans Réglages › Fournisseurs › Modèles.',
      );
    }
    return { ...auto, resolution: { ...auto.resolution, fallback: rejected ? `niveau « ${requested} » refusé précédemment par le fournisseur` : `niveau « ${requested} » non déclaré pour ce modèle` } };
  }
  const p = payload(requested, transport);
  if (!p) return { ...auto, resolution: { ...auto.resolution, fallback: `niveau « ${requested} » sans équivalent pour ce transport` } };
  return { resolution: { requested, sent: requested, parameter: p.parameter, fallback: null }, body: p.body };
}

/** Le fournisseur refuse-t-il explicitement le paramètre de réflexion envoyé ? */
export function isReasoningRejection(status: number | null, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /(reasoning_effort|reasoning|thinking|effort)/i.test(body) && /(unsupported|not support|invalid|unknown|unrecognized|not allowed|does not|cannot|n'est pas|non pris)/i.test(body);
}
