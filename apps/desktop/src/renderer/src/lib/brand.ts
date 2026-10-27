import { computed, ref } from 'vue';
import { store } from '../stores/app.ts';
import { uiState } from '../ui-state.ts';

const prefersDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (prefersDark.value = e.matches));

/** Nom et logo affichés : personnalisation de l'apparence (aperçu compris), sinon Monolith Harness. */
export const brand = computed(() => {
  const a = uiState.appearancePreview ?? store.settings?.appearance;
  const dark = a?.mode === 'dark' || (a?.mode !== 'light' && prefersDark.value);
  return { name: a?.appName?.trim() || 'Monolith Harness', logo: (dark ? a?.logoDark : a?.logoLight) ?? a?.logoLight ?? a?.logoDark ?? null };
});
