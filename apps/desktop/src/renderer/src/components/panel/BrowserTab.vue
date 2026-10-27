<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import InputText from 'primevue/inputtext';
import { useToast } from 'primevue/usetoast';
import type { Id } from '@monolith/contracts';
import { errorMessage, host } from '../../api.ts';
import { store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';
import type { BrowserCommand, BrowserStateInfo } from '../../../../shared/bridge.ts';

const props = defineProps<{ visible: boolean; conversationId: Id | null }>();
const { t } = useI18n();
const toast = useToast();

const state = ref<BrowserStateInfo>({ tabs: [], activeId: null, notice: null });
const address = ref('');
const editing = ref(false);
const viewport = ref<HTMLElement | null>(null);
const covered = ref(false);
const active = computed(() => state.value.tabs.find((x) => x.id === state.value.activeId) ?? null);

watch(
  () => active.value?.url,
  (url) => {
    if (!editing.value) address.value = url && url !== 'about:blank' ? url : '';
  },
);

async function cmd(c: BrowserCommand, args: Record<string, unknown> = {}) {
  try {
    await host.browser.command(c, { id: state.value.activeId, ...args });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });
  }
}
function go() {
  editing.value = false;
  const url = address.value.trim();
  if (!url) return;
  void (state.value.tabs.length ? cmd('navigate', { url }) : cmd('new', { url }));
}

// ---------- Placement de la vue native au-dessus du panneau ----------
// Les boîtes de dialogue et menus de l'interface sont sous la vue native : on la masque pendant leur affichage.
const OVERLAY = /\b(p-dialog-mask|p-popover|p-select-overlay|p-menu-overlay|p-contextmenu|p-tieredmenu-overlay|p-confirmdialog|p-autocomplete-overlay)\b/;
function overlayOpen(): boolean {
  return [...document.body.children].some((el) => OVERLAY.test(el.className) || !!el.querySelector?.('.p-dialog-mask'));
}

let frame = 0;
function place() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    covered.value = overlayOpen();
    const el = viewport.value;
    if (!props.visible || !el || covered.value || !active.value) {
      host.browser.setBounds(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const zoom = uiState.appearancePreview?.zoom ?? store.settings?.appearance.zoom ?? 1;
    host.browser.setBounds({ x: r.left * zoom, y: r.top * zoom, width: r.width * zoom, height: r.height * zoom });
  });
}

let resize: ResizeObserver | null = null;
let mutations: MutationObserver | null = null;
let offState: (() => void) | null = null;
onMounted(async () => {
  offState = host.browser.onState((s) => {
    state.value = { ...s, activeId: s.activeId ?? state.value.activeId };
    if (s.notice) toast.add({ severity: 'info', summary: s.notice, life: 5000 });
    place();
  });
  const initial = await host.browser.state();
  if (initial) state.value = initial;
  resize = new ResizeObserver(place);
  if (viewport.value) resize.observe(viewport.value);
  mutations = new MutationObserver(place);
  mutations.observe(document.body, { childList: true });
  window.addEventListener('resize', place);
  place();
});
onBeforeUnmount(() => {
  offState?.();
  resize?.disconnect();
  mutations?.disconnect();
  window.removeEventListener('resize', place);
  host.browser.setBounds(null);
});
watch(() => [props.visible, state.value.activeId, store.settings?.appearance.zoom, store.settings?.layout.panelMaximized, store.settings?.layout.panelWidth], place);
</script>

<template>
  <div class="browser">
    <div class="tabs" role="tablist">
      <div v-for="x in state.tabs" :key="x.id" class="tab" :class="{ active: x.id === state.activeId }">
        <button type="button" role="tab" class="label" :aria-selected="x.id === state.activeId" :title="x.url" @click="cmd('select', { id: x.id })">
          <i v-if="x.loading" class="pi pi-spin pi-spinner" />
          <i v-else-if="x.conversationId !== null" class="pi pi-sparkles" :title="t('panel.browser.agentTab')" />
          <span>{{ x.title }}</span>
        </button>
        <button type="button" class="close" :aria-label="t('panel.browser.closeTab')" @click="cmd('close', { id: x.id })"><i class="pi pi-times" /></button>
      </div>
      <button type="button" class="mh-icon-btn" :aria-label="t('panel.browser.newTab')" v-tooltip.bottom="t('panel.browser.newTab')" @click="cmd('new')"><i class="pi pi-plus" /></button>
    </div>
    <form class="bar" @submit.prevent="go">
      <button type="button" class="mh-icon-btn" :disabled="!active?.canGoBack" :aria-label="t('panel.browser.back')" @click="cmd('back')"><i class="pi pi-arrow-left" /></button>
      <button type="button" class="mh-icon-btn" :disabled="!active?.canGoForward" :aria-label="t('panel.browser.forward')" @click="cmd('forward')"><i class="pi pi-arrow-right" /></button>
      <button v-if="active?.loading" type="button" class="mh-icon-btn" :aria-label="t('panel.browser.stop')" @click="cmd('stop')"><i class="pi pi-times" /></button>
      <button v-else type="button" class="mh-icon-btn" :disabled="!active" :aria-label="t('panel.browser.reload')" @click="cmd('reload')"><i class="pi pi-refresh" /></button>
      <InputText v-model="address" size="small" class="url" :placeholder="t('panel.browser.url')" :aria-label="t('panel.browser.url')" @focus="editing = true" @blur="editing = false" />
      <button type="button" class="mh-icon-btn" :class="{ active: active?.mobile }" :disabled="!active" :aria-pressed="!!active?.mobile" :aria-label="t('panel.browser.mobile')" v-tooltip.bottom="t('panel.browser.mobile')" @click="cmd('mobile', { value: !active?.mobile })"><i class="pi pi-mobile" /></button>
      <button type="button" class="mh-icon-btn" :disabled="!active" :aria-label="t('panel.browser.devtools')" v-tooltip.bottom="t('panel.browser.devtools')" @click="cmd('devtools')"><i class="pi pi-wrench" /></button>
      <button type="button" class="mh-icon-btn" :disabled="!active" :aria-label="t('panel.browser.external')" v-tooltip.bottom="t('panel.browser.external')" @click="cmd('external')"><i class="pi pi-external-link" /></button>
      <button type="button" class="mh-icon-btn" :aria-label="t('panel.browser.clearData')" v-tooltip.left="t('panel.browser.clearData')" @click="cmd('clearData')"><i class="pi pi-eraser" /></button>
    </form>
    <p v-if="active?.error" class="error" role="alert">{{ active.error }}</p>
    <div ref="viewport" class="viewport">
      <p v-if="!state.tabs.length" class="mh-muted note">{{ t('panel.browser.empty') }}</p>
      <p v-else-if="covered" class="mh-muted note">{{ t('panel.browser.hidden') }}</p>
    </div>
  </div>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px 0;
  overflow-x: auto;
}
.tab {
  display: flex;
  align-items: center;
  max-width: 200px;
  border-radius: var(--mh-radius-sm) var(--mh-radius-sm) 0 0;
  background: transparent;
}
.tab.active {
  background: var(--mh-hover);
}
.label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border: none;
  background: none;
  padding: 5px 4px 5px 10px;
  color: var(--mh-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  border: none;
  background: none;
  color: var(--mh-muted);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 10px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px;
  border-bottom: 1px solid var(--mh-border);
}
.url {
  flex: 1;
  min-width: 0;
}
.error {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mh-danger);
}
.viewport {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--mh-bg);
}
.note {
  padding: 24px;
  text-align: center;
}
</style>
