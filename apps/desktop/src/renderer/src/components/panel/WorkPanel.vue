<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../api.ts';
import { activeConversation, store } from '../../stores/app.ts';
import FilesTab from './FilesTab.vue';
import TerminalTab from './TerminalTab.vue';
import GitTab from './GitTab.vue';
import BrowserTab from './BrowserTab.vue';
import PreviewTab from './PreviewTab.vue';
import AssetsView from '../studio/AssetsView.vue';
import AiInfoTab from './AiInfoTab.vue';

export type PanelTab = 'files' | 'terminal' | 'git' | 'browser' | 'preview' | 'assets' | 'ai';
const TABS: { id: PanelTab; icon: string }[] = [
  { id: 'files', icon: 'pi-folder' },
  { id: 'terminal', icon: 'pi-code' },
  { id: 'git', icon: 'pi-sitemap' },
  { id: 'browser', icon: 'pi-globe' },
  { id: 'preview', icon: 'pi-eye' },
  { id: 'assets', icon: 'pi-palette' },
  { id: 'ai', icon: 'pi-microchip-ai' },
];

const { t } = useI18n();
const layout = computed(() => store.settings!.layout);
const tab = computed<PanelTab>(() => (TABS.some((x) => x.id === layout.value.panelTab) ? (layout.value.panelTab as PanelTab) : 'files'));
const width = ref(layout.value.panelWidth);
watch(() => layout.value.panelWidth, (w) => (width.value = w));
const conversation = computed(() => activeConversation.value);

const save = (patch: Partial<typeof layout.value>) => api.call('settings.update', { layout: patch });
const select = (id: PanelTab) => void save({ panelTab: id });

function startResize(e: PointerEvent) {
  const startX = e.clientX;
  const startW = width.value;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const max = Math.min(1400, window.innerWidth - 360);
  const move = (ev: PointerEvent) => (width.value = Math.min(max, Math.max(320, startW - (ev.clientX - startX))));
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    void save({ panelWidth: width.value });
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}
function resizeKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
  if (!step) return;
  width.value = Math.min(1400, Math.max(320, width.value + step));
  void save({ panelWidth: width.value });
}
</script>

<template>
  <aside class="panel" :class="{ max: layout.panelMaximized }" :style="layout.panelMaximized ? undefined : { width: `${width}px` }" :aria-label="t('panel.open')">
    <div v-if="!layout.panelMaximized" class="resizer" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="t('panel.resize')" :aria-valuenow="width" aria-valuemin="320" aria-valuemax="1400" @pointerdown="startResize" @keydown="resizeKey" />
    <header class="head">
      <div class="tabs" role="tablist">
        <button v-for="x in TABS" :key="x.id" type="button" role="tab" class="tab" :class="{ active: tab === x.id }" :aria-selected="tab === x.id" :title="t(`panel.tabs.${x.id}`)" @click="select(x.id)">
          <i class="pi" :class="x.icon" /> <span>{{ t(`panel.tabs.${x.id}`) }}</span>
        </button>
      </div>
      <button type="button" class="mh-icon-btn" :aria-label="layout.panelMaximized ? t('panel.restore') : t('panel.maximize')" v-tooltip.bottom="layout.panelMaximized ? t('panel.restore') : t('panel.maximize')" @click="save({ panelMaximized: !layout.panelMaximized })">
        <i class="pi" :class="layout.panelMaximized ? 'pi-window-minimize' : 'pi-window-maximize'" />
      </button>
      <button type="button" class="mh-icon-btn" :aria-label="t('panel.close')" v-tooltip.bottom="t('panel.close')" @click="save({ panelOpen: false, panelMaximized: false })"><i class="pi pi-times" /></button>
    </header>
    <div class="body">
      <div v-if="tab === 'assets'" class="assets-tab"><AssetsView /></div>
      <p v-else-if="!conversation && tab !== 'browser'" class="mh-muted empty">{{ t('panel.noConversation') }}</p>
      <template v-else>
        <FilesTab v-if="tab === 'files' && conversation" :key="`f${conversation.id}`" :conversation-id="conversation.id" @preview="select('preview')" />
        <TerminalTab v-else-if="tab === 'terminal' && conversation" :key="`t${conversation.id}`" :conversation-id="conversation.id" />
        <GitTab v-else-if="tab === 'git' && conversation" :key="`g${conversation.id}`" :conversation-id="conversation.id" />
        <PreviewTab v-else-if="tab === 'preview' && conversation" :conversation-id="conversation.id" @open-browser="select('browser')" />
        <AiInfoTab v-else-if="tab === 'ai' && conversation" :key="`a${conversation.id}`" :conversation-id="conversation.id" />
      </template>
      <!-- Le navigateur reste monté : ses onglets survivent aux changements d'onglet du panneau. -->
      <BrowserTab v-show="tab === 'browser'" :visible="tab === 'browser'" :conversation-id="conversation?.id ?? null" />
    </div>
  </aside>
</template>

<style scoped>
.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--mh-border);
  background: var(--mh-surface);
}
.panel.max {
  flex: 1;
  border-left: none;
}
.resizer {
  position: absolute;
  left: -3px;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}
.resizer:hover,
.resizer:focus-visible {
  background: color-mix(in srgb, var(--mh-accent) 35%, transparent);
}
.head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--mh-border);
}
.tabs {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
/* Panneau étroit : icônes seules, sauf l'onglet actif (tous les onglets restent visibles). */
.head {
  container-type: inline-size;
}
@container (max-width: 720px) {
  .tab:not(.active) span {
    display: none;
  }
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--mh-radius-sm);
  background: transparent;
  color: var(--mh-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.tab:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
.tab.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  color: var(--mh-accent);
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.assets-tab {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  display: flex;
}
.empty {
  padding: 24px;
  text-align: center;
}
</style>
