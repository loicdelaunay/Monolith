<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Id } from '@monolith/contracts';
import { api, host } from '../api.ts';
import { highlightVersion, renderBlock, splitBlocks } from '../lib/markdown.ts';
import { decorateFileBadges, renderMermaid } from '../lib/rich-render.ts';
import { store } from '../stores/app.ts';
import { uiState } from '../ui-state.ts';

const props = defineProps<{ text: string; conversationId?: Id }>();
const root = ref<HTMLElement | null>(null);

/**
 * Un élément par bloc : pendant le streaming, seul le dernier bloc change de HTML ;
 * les blocs terminés ne sont pas retouchés (sélection et position conservées).
 */
const blocks = computed(() => {
  void highlightVersion.value;
  return splitBlocks(props.text).map(renderBlock);
});

// Enrichissements après rendu : diagrammes (différés pendant le streaming) et badges de fichiers.
let timer: ReturnType<typeof setTimeout> | null = null;
function enhance() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!root.value) return;
    void renderMermaid(root.value);
    if (props.conversationId !== undefined) void decorateFileBadges(root.value, props.conversationId);
  }, 350);
}
onMounted(enhance);
watch(blocks, () => void nextTick(enhance));

function togglePreview(button: HTMLElement) {
  const block = button.closest<HTMLElement>('.mh-code');
  if (!block) return;
  const existing = block.querySelector('.mh-html-preview');
  if (existing) {
    existing.remove();
    return;
  }
  const code = block.querySelector('pre')?.innerText ?? '';
  const holder = document.createElement('div');
  holder.className = 'mh-html-preview';
  if (button.dataset.preview === 'svg') {
    const img = document.createElement('img');
    img.alt = 'SVG';
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    holder.append(img);
  } else {
    // Isolation complète : sandbox vide (aucun script, formulaire, navigation ni accès à l'application).
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = 'Aperçu HTML';
    frame.srcdoc = code;
    holder.append(frame);
  }
  block.append(holder);
}

async function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLElement>('[data-copy]');
  if (copy) {
    const code = copy.closest('.mh-code')?.querySelector('pre')?.innerText ?? '';
    await navigator.clipboard.writeText(code);
    const icon = copy.querySelector('i');
    if (icon) {
      icon.className = 'pi pi-check';
      setTimeout(() => (icon.className = 'pi pi-copy'), 1200);
    }
    return;
  }
  const preview = target.closest<HTMLElement>('[data-preview]');
  if (preview) {
    togglePreview(preview);
    return;
  }
  const toggle = target.closest<HTMLElement>('[data-mermaid-toggle]');
  if (toggle) {
    toggle.closest('.mh-mermaid')?.classList.toggle('show-code');
    return;
  }
  const badge = target.closest<HTMLElement>('.mh-file-badge');
  if (badge?.dataset.file && badge.dataset.type === 'directory') {
    await host.showItemInFolder(badge.dataset.file);
    return;
  }
  if (badge?.dataset.file && props.conversationId !== undefined) {
    uiState.preview = { conversationId: props.conversationId, path: badge.dataset.file, line: badge.dataset.line ? Number(badge.dataset.line) : null };
    await api.call('settings.update', { layout: { panelOpen: true, panelTab: 'preview' } });
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) await host.openExternal(href);
  }
}
</script>

<template>
  <div ref="root" class="mh-md" :class="{ 'mh-code-lines': store.settings?.chat.codeLineNumbers }" @click="onClick">
    <div v-for="(html, i) in blocks" :key="i" class="mh-md-block" v-html="html" />
  </div>
</template>

<style scoped>
.mh-md-block {
  display: contents;
}
</style>
