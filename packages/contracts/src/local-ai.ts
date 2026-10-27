/**
 * IA locale auxiliaire (comme la v1) : LANCET Nano pour valider les commandes du mode Automatique,
 * MiniLM multilingue pour les embeddings du RAG. Téléchargées seulement après accord de l'utilisateur,
 * exécutées sur le CPU par un environnement Python dédié.
 */
export type LocalAiComponent = 'lancet' | 'minilm';

export interface LocalAiComponentStatus {
  id: LocalAiComponent;
  installed: boolean;
  version: string;
  /** Taille des fichiers du modèle (octets). */
  bytes: number;
}

export interface LocalAiProgress {
  component: LocalAiComponent;
  stage: 'runtime' | 'download' | 'verify' | 'dependencies' | 'prepare' | 'ready' | 'error';
  received: number;
  total: number;
  message: string | null;
}

export interface LocalAiStatus {
  components: LocalAiComponentStatus[];
  /** Environnement Python dédié (python-build-standalone) et dépendances CPU. */
  runtime: { installed: boolean; version: string };
  busy: LocalAiProgress | null;
  supported: boolean;
  unsupportedReason: string | null;
}

/** Résultat de LANCET Nano pour une commande. */
export interface CommandClassification {
  classification: 'not_flagged' | 'review' | 'risky';
  score: number | null;
  reason: string | null;
}
