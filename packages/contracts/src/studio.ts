import type { AttachmentRef, Id } from './model.ts';

// ---------- Traducteur, correcteur, réécriture ----------

export type TextTask = 'translate' | 'proofread' | 'rewrite';

export interface TextTaskInput {
  task: TextTask;
  text: string;
  /** Langue cible (traduction) ; langue du texte conservée sinon. */
  targetLanguage?: string;
  tone?: string;
  instructions?: string;
  providerId?: Id | null;
  model?: string | null;
}

export interface TextTaskResult {
  text: string;
  providerName: string;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

// ---------- Détection de contenu IA (indicative) ----------

export interface AiDetectionResult {
  metrics: {
    words: number;
    sentences: number;
    avgSentenceLength: number;
    /** Variabilité de la longueur des phrases (écart-type / moyenne). */
    burstiness: number;
    typeTokenRatio: number;
    repeatedTrigrams: number;
  };
  /** 0 : traits plutôt humains, 1 : traits plutôt générés. Indicatif. */
  heuristicScore: number;
  heuristicLabel: 'probably_human' | 'uncertain' | 'probably_ai' | 'too_short';
  model: { verdict: 'human' | 'ai' | 'mixed' | 'uncertain'; confidence: number; reasons: string[]; providerName: string; model: string } | null;
}

// ---------- Benchmark ----------

export interface BenchmarkTarget {
  providerId: Id;
  model: string;
}

export interface BenchmarkCase {
  prompt: string;
  /** Texte attendu dans la réponse (contrôle simple, insensible à la casse). */
  expected?: string;
}

export interface BenchmarkInput {
  targets: BenchmarkTarget[];
  cases: BenchmarkCase[];
  repeat: number;
  maxOutputTokens?: number | null;
}

export interface BenchmarkResult {
  providerId: Id;
  providerName: string;
  model: string;
  caseIndex: number;
  run: number;
  ok: boolean;
  error: string | null;
  firstTokenMs: number | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  passed: boolean | null;
  output: string;
}

export interface BenchmarkState {
  id: string;
  running: boolean;
  total: number;
  done: number;
  results: BenchmarkResult[];
  startedAt: string;
}

// ---------- Images ----------

export interface ImageGenInput {
  prompt: string;
  size?: string;
  providerId?: Id | null;
  model?: string | null;
  conversationId?: Id | null;
}

export interface ImageGenResult {
  attachments: AttachmentRef[];
  revisedPrompt: string | null;
  providerName: string;
  model: string;
}

// ---------- Assets ----------

export type AssetKind = 'svg' | 'pixel';

export interface AssetInfo {
  name: string;
  kind: AssetKind;
  size: number;
  updatedAt: string;
}

/** Pixel art : chaque image est une liste de lignes ; chaque caractère est un indice de palette (0-9, a-z). */
export interface PixelAsset {
  width: number;
  height: number;
  /** Couleurs #rrggbb ou #rrggbbaa ; l'indice 0 est souvent transparent (#00000000). */
  palette: string[];
  frames: string[][];
  fps: number;
}
