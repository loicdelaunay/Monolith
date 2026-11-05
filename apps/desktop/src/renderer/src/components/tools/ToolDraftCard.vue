<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFollowScroll } from '../../lib/follow-scroll.ts';
import { fileIcon } from '../../lib/file-icons.ts';
import type { ToolDraft } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';

/** Fichier en cours d'écriture par le modèle : aperçu en direct, l'outil n'a encore rien exécuté. */
const props = defineProps<{ draft: ToolDraft }>();
const { t, te } = useI18n();

const name = computed(() => (te(`tools.names.${props.draft.name}`) ? t(`tools.names.${props.draft.name}`) : props.draft.name));
const lines = computed(() => (props.draft.text ? props.draft.text.split('\n').length : 0));
const kind = computed(() => (props.draft.path ? fileIcon(props.draft.path, 'file') : null));
const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
useFollowScroll(scroller, content);
</script>

<template>
  <div class="draft">
    <button type="button" class="head" :aria-expanded="uiState.liveCode" @click="uiState.liveCode = !uiState.liveCode">
      <i class="pi pi-spin pi-spinner" aria-hidden="true" />
      <span class="name">{{ name }}</span>
      <span v-if="draft.path" class="path" :title="draft.path"><i v-if="kind" class="pi" :class="kind.icon" :style="{ color: kind.color }" aria-hidden="true" /> {{ draft.path }}</span>
      <span class="count">{{ t('render.widgetLines', { n: lines }) }}</span>
      <i class="pi pi-chevron-right chevron" :class="{ open: uiState.liveCode }" aria-hidden="true" />
    </button>
    <pre v-if="uiState.liveCode" ref="scroller" class="code" tabindex="0"><code ref="content">{{ draft.text }}</code></pre>
  </div>
</template>

<style scoped>
.draft {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: var(--mh-tool-bubble);
  font-size: 13px;
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  color: var(--mh-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.head:hover {
  color: var(--mh-text);
}
.name {
  flex: none;
  color: var(--mh-text);
  font-weight: 600;
}
.path {
  min-width: 0;
  overflow: hidden;
  font-family: var(--mh-font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  flex: none;
  font-size: 12px;
}
.chevron {
  margin-left: auto;
  font-size: 11px;
  transition: transform 0.15s;
}
.chevron.open {
  transform: rotate(90deg);
}
.code {
  margin: 0;
  max-height: 320px;
  padding: 8px 12px;
  overflow: auto;
  border-top: 1px solid var(--mh-border);
  background: var(--mh-code-bg);
  font-family: var(--mh-font-mono);
  font-size: 12px;
  line-height: 1.5;
  tab-size: 2;
}
.code code {
  display: block;
  width: max-content;
  min-width: 100%;
}
</style>
