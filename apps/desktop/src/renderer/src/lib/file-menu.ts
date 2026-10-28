import type { Id } from '@monolith/contracts';

/** Fichier ciblé par le menu contextuel (chemin absolu vérifié par le moteur). */
export interface FileTarget {
  conversationId: Id;
  path: string;
  type: 'file' | 'directory';
  line?: number | null;
}

/** Point d'entrée du menu contextuel des fichiers, branché par FileContextMenu.vue (monté une fois). */
export const fileMenu: { show: (event: MouseEvent, target: FileTarget) => void } = {
  show: () => undefined,
};
