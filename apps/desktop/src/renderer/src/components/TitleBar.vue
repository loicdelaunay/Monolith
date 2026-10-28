<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { APP_VERSION } from '@monolith/contracts';
import { activeConversation, store } from '../stores/app.ts';
import { api } from '../api.ts';
import { uiState } from '../ui-state.ts';
import logo from '../assets/logo.png';
import { brand } from '../lib/brand.ts';

defineEmits<{ 'open-settings': [] }>();
const { t } = useI18n();

const projectName = computed(() => {
  const c = activeConversation.value;
  if (!c) return null;
  return c.projectId === null ? t('sidebar.personal') : (store.projects.find((p) => p.id === c.projectId)?.name ?? null);
});
const brandName = computed(() => brand.value.name);
const sidebarHidden = computed(() => !!store.settings?.layout.sidebarCollapsed);
function toggleSidebar() {
  void api.call('settings.update', { layout: { sidebarCollapsed: !sidebarHidden.value } });
}
const brandLogo = computed(() => brand.value.logo ?? logo);
</script>

<template>
  <!--
    Zone de déplacement : toute la barre jusqu'au bord supérieur (y compris fenêtre maximisée).
    Les contrôles réduire/agrandir/fermer sont les contrôles natifs superposés (un seul jeu).
  -->
  <header class="mh-titlebar">
    <div class="identity">
      <button type="button" class="burger" :aria-label="sidebarHidden ? t('titlebar.showSidebar') : t('titlebar.hideSidebar')" :aria-expanded="!sidebarHidden" v-tooltip.bottom="`${sidebarHidden ? t('titlebar.showSidebar') : t('titlebar.hideSidebar')} (Ctrl+B)`" @click="toggleSidebar"><i class="pi pi-bars" /></button>
      <img :src="brandLogo" alt="" height="18" class="logo" />
      <span class="name">{{ brandName }}</span>
    </div>
    <div class="context" aria-live="polite">
      <template v-if="activeConversation">
        <span v-if="projectName" class="project">{{ projectName }}</span>
        <i v-if="projectName" class="pi pi-angle-right sep" aria-hidden="true" />
        <span class="title">{{ activeConversation.title }}</span>
      </template>
    </div>
    <div class="actions">
      <button type="button" class="version" :aria-label="`v${APP_VERSION} — ${t('titlebar.version', { version: APP_VERSION })}`" v-tooltip.bottom="t('titlebar.version', { version: APP_VERSION })" @click="uiState.changelogOpen = true">
        v{{ APP_VERSION }}
      </button>
      <button type="button" class="mh-icon-btn" :aria-label="t('titlebar.settings')" v-tooltip.bottom="t('titlebar.settings')" @click="$emit('open-settings')">
        <i class="pi pi-cog" />
      </button>
    </div>
    <div class="controls-space" aria-hidden="true" />
  </header>
</template>

<style scoped>
.mh-titlebar {
  height: var(--mh-titlebar);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding-left: 12px;
  background: var(--mh-sidebar);
  border-bottom: 1px solid var(--mh-border);
  -webkit-app-region: drag;
  user-select: none;
}
.identity {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  flex: none;
}
.burger {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--mh-radius-sm);
  background: transparent;
  color: var(--mh-muted);
  cursor: pointer;
}
.burger:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
.identity img {
  border-radius: 4px;
}
.context {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--mh-muted);
  white-space: nowrap;
}
.context .title {
  color: var(--mh-text);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 48ch;
}
.context .project {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 24ch;
}
.sep {
  font-size: 10px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 2px;
  -webkit-app-region: no-drag;
}
.version {
  -webkit-app-region: no-drag;
  border: 1px solid var(--mh-border);
  background: transparent;
  color: var(--mh-muted);
  border-radius: 999px;
  font-size: 11.5px;
  padding: 2px 9px;
  cursor: pointer;
  transition: background var(--mh-transition), color var(--mh-transition);
}
.version:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
/* Réserve la largeur des contrôles natifs (API Window Controls Overlay). */
.controls-space {
  flex: none;
  width: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  min-width: 8px;
  height: 100%;
}
@media (max-width: 820px) {
  .context {
    display: none;
  }
}
</style>
