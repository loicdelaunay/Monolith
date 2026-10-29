import { reactive } from 'vue';
import type { Id, Settings } from '@monolith/contracts';

export type SettingsSectionId =
  | 'general'
  | 'chat'
  | 'appearance'
  | 'providers'
  | 'skills'
  | 'agents'
  | 'mcp'
  | 'memory'
  | 'permissions'
  | 'loop'
  | 'shortcuts'
  | 'scheduler'
  | 'local'
  | 'notifications'
  | 'server'
  | 'advanced'
  | 'reset'
  | 'about';

/** État d'interface non persistant (dialogues ouverts, aperçu d'apparence). */
export const uiState = reactive({
  settingsOpen: false,
  settingsSection: 'general' as SettingsSectionId,
  /** Fournisseur à sélectionner à l'ouverture de la section Fournisseurs. */
  settingsProviderId: null as Id | null,
  /** Aperçu en direct de l'apparence pendant l'édition des réglages (null hors édition). */
  appearancePreview: null as Settings['appearance'] | null,
  changelogOpen: false,
  projectDialog: { open: false, projectId: null as Id | null, focus: 'general' as 'general' | 'instructions' },
  /** Atelier des outils dédiés. */
  studio: { open: false, tab: 'text' as 'text' | 'images' | 'assets' | 'benchmark' | 'detect' | 'dashboard' },
  /** Fichier affiché dans l'onglet Aperçu du panneau de travail. */
  /** Aperçu d'un fichier ; line / endLine : ligne ou plage citée, surlignée dans le code. */
  preview: null as { conversationId: Id; path: string; line: number | null; endLine?: number | null } | null,
  /** Diagramme Mermaid agrandi (SVG rendu) ; null : visionneuse fermée. */
  diagram: null as string | null,
});
