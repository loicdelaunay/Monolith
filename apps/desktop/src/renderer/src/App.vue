<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Toast from 'primevue/toast';
import ConfirmDialog from 'primevue/confirmdialog';
import ProgressSpinner from 'primevue/progressspinner';
import { useToast } from 'primevue/usetoast';
import { comboFromEvent, nextMode, nextReasoning, resolveLocale, shortcutPatch, type Settings } from '@monolith/contracts';
import { api, host, errorMessage } from './api.ts';
import { activeConversation, initStore, store } from './stores/app.ts';
import { applyAppearance } from './theme/themes.ts';
import { setCodeTheme, setRenderOptions } from './lib/markdown.ts';
import WorkPanel from './components/panel/WorkPanel.vue';
import StudioDialog from './components/studio/StudioDialog.vue';
import { uiState, type SettingsSectionId } from './ui-state.ts';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';
import ChatView from './components/ChatView.vue';
import SettingsDialog from './components/settings/SettingsDialog.vue';
import ChangelogDialog from './components/ChangelogDialog.vue';
import ProjectDialog from './components/ProjectDialog.vue';
import PermissionDialog from './components/tools/PermissionDialog.vue';
import LoopDialog from './components/tools/LoopDialog.vue';

const { locale, t } = useI18n();
const prefersDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches);
const media = window.matchMedia('(prefers-color-scheme: dark)');
const onMedia = (e: MediaQueryListEvent) => (prefersDark.value = e.matches);

/** Apparence affichée : brouillon des réglages pendant l'aperçu, sinon réglages enregistrés. */
const appearance = computed<Settings['appearance'] | null>(() => uiState.appearancePreview ?? store.settings?.appearance ?? null);

watch(
  [appearance, prefersDark],
  ([a, dark]) => {
    if (!a) return;
    const applied = applyAppearance(a, dark);
    setCodeTheme(applied.dark);
    host.setZoom(a.zoom);
    void host.setTitleBarColors({ background: applied.tokens.sidebar, symbols: applied.tokens.text });
  },
  { deep: true },
);

watch(
  () => store.settings?.general.language,
  (lang) => {
    if (!lang) return;
    locale.value = resolveLocale(lang, store.renderer?.locale ?? navigator.language);
    document.documentElement.lang = locale.value;
  },
);

const customTitleBar = computed(() => store.renderer?.customTitleBar ?? false);
const layout = computed(() => store.settings?.layout);
watch(() => store.settings?.render, (r) => r && setRenderOptions({ ...r }), { deep: true, immediate: true });

// Raccourcis : Ctrl+J (panneau), intégrés (mode, réflexion) et personnalisés (fournisseur, modèle, mode, réflexion).
function onKey(e: KeyboardEvent) {
  const s = store.settings;
  if (!s || uiState.settingsOpen) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (combo === 'Ctrl+J') {
    e.preventDefault();
    void api.call('settings.update', { layout: { panelOpen: !s.layout.panelOpen } });
    return;
  }
  const c = activeConversation.value;
  if (!c) return;
  const apply = (patch: Record<string, unknown>, label: string) => {
    e.preventDefault();
    api
      .call('conversations.update', { id: c.id, patch })
      .then(() => toast.add({ severity: 'info', summary: t('settings.shortcutsSettings.applied', { label }), life: 1800 }))
      .catch((err) => toast.add({ severity: 'error', summary: errorMessage(err), life: 5000 }));
  };
  if (s.shortcuts.builtin && combo === 'Ctrl+Shift+M') {
    const next = nextMode(c.mode, c.agentMode);
    apply(next, next.mode === 'chat' ? t('modes.chat') : t(`modes.${next.agentMode}`));
    return;
  }
  if (s.shortcuts.builtin && combo === 'Ctrl+Shift+R') {
    const p = store.providers.find((x) => x.id === (c.providerId ?? s.chat.defaultProviderId));
    const m = p?.models.find((x) => x.id === (c.providerId !== null ? c.model : s.chat.defaultModel));
    const levels = m ? m.capabilities.reasoningLevels.filter((l) => !m.capabilities.rejectedLevels.includes(l)) : [];
    const level = nextReasoning(c.reasoningLevel, levels);
    apply({ reasoningLevel: level }, t(`reasoningLevels.${level}`));
    return;
  }
  const item = s.shortcuts.items.find((i) => i.keys === combo);
  if (item) apply(shortcutPatch(item), item.label || item.keys);
}

// Erreurs signalées par le moteur hors d'un appel (ex. élément de file non envoyé).
const toast = useToast();
watch(
  () => store.engineErrors.length,
  () => {
    for (const e of store.engineErrors.splice(0)) toast.add({ severity: 'error', summary: t(`errors.${e.code}`), detail: e.message, life: 8000 });
  },
);

function openSettings(section?: SettingsSectionId) {
  uiState.settingsSection = section ?? uiState.settingsSection;
  uiState.settingsOpen = true;
}
provide('openSettings', openSettings);

onMounted(async () => {
  media.addEventListener('change', onMedia);
  window.addEventListener('keydown', onKey);
  try {
    await initStore();
  } catch (error) {
    store.fatal = errorMessage(error);
  }
});
onBeforeUnmount(() => {
  media.removeEventListener('change', onMedia);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="mh-app" :class="{ 'custom-titlebar': customTitleBar }">
    <TitleBar v-if="customTitleBar" @open-settings="openSettings()" />
    <div v-if="!store.ready" class="mh-boot" role="status" aria-live="polite">
      <template v-if="store.fatal">
        <i class="pi pi-exclamation-triangle" />
        <strong>{{ t('app.fatalTitle') }}</strong>
        <span class="mh-muted">{{ store.fatal }}</span>
      </template>
      <template v-else>
        <ProgressSpinner style="width: 28px; height: 28px" stroke-width="5" />
        <span class="mh-muted">{{ t('app.loading') }}</span>
      </template>
    </div>
    <div v-else class="mh-main">
      <Sidebar @open-settings="openSettings" />
      <ChatView v-show="!(layout?.panelOpen && layout.panelMaximized)" @open-settings="openSettings" />
      <WorkPanel v-if="layout?.panelOpen" />
    </div>
    <SettingsDialog v-if="store.ready" />
    <ChangelogDialog v-if="store.ready" />
    <ProjectDialog v-if="store.ready" />
    <PermissionDialog v-if="store.ready" />
    <LoopDialog v-if="store.ready" />
    <StudioDialog v-if="store.ready && uiState.studio.open" />
    <Toast position="bottom-right" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.mh-app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--mh-bg);
}
.mh-main {
  flex: 1;
  min-height: 0;
  display: flex;
}
.mh-boot {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.mh-boot .pi {
  font-size: 28px;
  color: var(--mh-danger);
}
</style>
