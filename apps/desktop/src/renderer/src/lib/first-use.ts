import { reactive } from 'vue';
import type { Settings } from '@monolith/contracts';

/** Choix fait dans la demande de première utilisation (validateur du mode Automatique ou embeddings du RAG). */
export interface FirstUseResult {
  permissions?: Partial<Pick<Settings['permissions'], 'validator' | 'validatorProviderId' | 'validatorModel'>>;
  rag?: Partial<Pick<Settings['rag'], 'embeddingSource' | 'embeddingProviderId' | 'embeddingModel'>>;
}

export const firstUse = reactive<{ kind: 'validator' | 'rag' | null; resolve: ((r: FirstUseResult | null) => void) | null }>({ kind: null, resolve: null });

/**
 * Comme la v1 : à la première utilisation, propose de télécharger le modèle local, d'utiliser un
 * modèle d'une connexion, ou d'annuler (null). L'appelant applique le choix (réglages ou brouillon).
 */
export function askFirstUse(kind: 'validator' | 'rag'): Promise<FirstUseResult | null> {
  firstUse.resolve?.(null);
  return new Promise((resolve) => {
    firstUse.kind = kind;
    firstUse.resolve = resolve;
  });
}

export function finishFirstUse(result: FirstUseResult | null): void {
  const resolve = firstUse.resolve;
  firstUse.kind = null;
  firstUse.resolve = null;
  resolve?.(result);
}
