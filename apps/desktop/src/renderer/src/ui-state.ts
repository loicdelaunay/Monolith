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
});
