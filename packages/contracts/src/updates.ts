/** Dépôt GitHub des versions publiées (vérification et téléchargement des mises à jour). */
export const UPDATE_REPOSITORY = 'loicdelaunay/Monolith';

export type UpdateMode = 'off' | 'notify' | 'auto';

export interface UpdateRelease {
  version: string;
  tag: string;
  /** Page de la version sur GitHub. */
  url: string;
  prerelease: boolean;
  publishedAt: string | null;
  /** Notes de version (tronquées). */
  notes: string;
  asset: string;
  downloadUrl: string;
  /** Empreinte publiée par GitHub (`digest` de l'asset). */
  sha256: string;
  size: number;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  current: string;
  release: UpdateRelease | null;
  /** Progression du téléchargement (0–1). */
  progress: number | null;
  error: string | null;
  checkedAt: string | null;
  /** Installation possible sur ce poste (Windows, version portable) ; sinon `installReason`. */
  installable: boolean;
  installReason: string | null;
  /** Résultat de la dernière installation (lu au démarrage suivant). */
  lastResult: { ok: boolean; message: string; at: string } | null;
}
