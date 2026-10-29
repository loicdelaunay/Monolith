<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import type { FileContent, Id } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { uiState } from '../../ui-state.ts';
import { formatSize as formatBytes } from '../../lib/attachments.ts';
import { fenced } from '../../lib/markdown.ts';
import MarkdownView from '../MarkdownView.vue';

const props = defineProps<{ conversationId: Id }>();
const emit = defineEmits<{ 'open-browser': [] }>();
const { t } = useI18n();

const file = ref<FileContent | null>(null);
const error = ref<string | null>(null);
const mode = ref<'rendered' | 'source'>('rendered');
const target = computed(() => (uiState.preview?.conversationId === props.conversationId ? uiState.preview : null));

watch(
  target,
  async (p) => {
    file.value = null;
    error.value = null;
    mode.value = 'rendered';
    if (!p) return;
    try {
      file.value = await api.call('files.read', { conversationId: props.conversationId, path: p.path });
      // Ligne ou plage citée : affichée dans le code source, surlignée.
      if (p.line) mode.value = 'source';
      scrolled = false;
    } catch (e) {
      error.value = errorMessage(e);
    }
  },
  { immediate: true },
);

const ext = computed(() => file.value?.path.split('.').pop()?.toLowerCase() ?? '');
const isMarkdown = computed(() => file.value?.mime === 'text/markdown');
const isHtml = computed(() => file.value?.mime === 'text/html');
const isSvg = computed(() => file.value?.mime === 'image/svg+xml');
const renderable = computed(() => isMarkdown.value || isHtml.value || isSvg.value);
const source = computed(() => (file.value?.text !== undefined ? fenced(file.value.text, ext.value) : ''));
const svgUrl = computed(() => (isSvg.value && file.value?.text ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(file.value.text)))}` : ''));

// ---------- Lignes citées surlignées (le code peut être re-rendu : coloration chargée à la demande) ----------
const content = ref<HTMLElement | null>(null);
let scrolled = false;
function highlightLines() {
  const el = content.value;
  const p = target.value;
  if (!el || !p?.line) return;
  const lines = el.querySelectorAll<HTMLElement>('.mh-code .line');
  if (!lines.length) return;
  const first = Math.max(1, p.line);
  const last = Math.max(first, p.endLine ?? first);
  lines.forEach((node, i) => node.classList.toggle('mh-line-hl', i + 1 >= first && i + 1 <= last));
  if (!scrolled) {
    scrolled = true;
    lines[first - 1]?.scrollIntoView({ block: 'center' });
  }
}
let observer: MutationObserver | null = null;
watch(
  content,
  (el) => {
    observer?.disconnect();
    if (!el) return;
    observer = new MutationObserver(() => highlightLines());
    observer.observe(el, { childList: true, subtree: true });
    void nextTick(highlightLines);
  },
  { flush: 'post' },
);
watch([target, mode, file], () => void nextTick(highlightLines), { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());

async function openInBrowser() {
  if (!file.value) return;
  const url = `file:///${file.value.path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  await host.browser.command('new', { url: encodeURI(url) });
  emit('open-browser');
}
</script>

<template>
  <div class="preview">
    <p v-if="!target" class="mh-muted note">{{ t('panel.preview.empty') }}</p>
    <p v-else-if="error" class="note error" role="alert">{{ error }}</p>
    <template v-else-if="file">
      <div class="bar">
        <i class="pi pi-file mh-muted" />
        <span class="path" :title="file.path">{{ file.display }}<template v-if="target.line">:{{ target.line }}<template v-if="target.endLine">-{{ target.endLine }}</template></template></span>
        <span class="mh-muted size">{{ formatBytes(file.size) }}</span>
        <div v-if="renderable" class="seg" role="group">
          <button type="button" :class="{ active: mode === 'rendered' }" :aria-pressed="mode === 'rendered'" @click="mode = 'rendered'">{{ t('panel.preview.rendered') }}</button>
          <button type="button" :class="{ active: mode === 'source' }" :aria-pressed="mode === 'source'" @click="mode = 'source'">{{ t('panel.preview.source') }}</button>
        </div>
        <Button v-if="isHtml" size="small" text icon="pi pi-globe" :label="t('panel.preview.openInBrowser')" @click="openInBrowser" />
        <button type="button" class="mh-icon-btn" :aria-label="t('panel.files.reveal')" v-tooltip.left="t('panel.files.reveal')" @click="host.showItemInFolder(file.path)"><i class="pi pi-external-link" /></button>
      </div>
      <div ref="content" class="content">
        <img v-if="file.kind === 'image'" :src="`data:${file.mime};base64,${file.dataBase64}`" :alt="file.display" class="img" />
        <p v-else-if="file.kind === 'binary'" class="mh-muted note">{{ t('panel.preview.binary') }}</p>
        <p v-else-if="file.kind === 'too_large'" class="mh-muted note">{{ t('panel.preview.tooLarge', { size: formatBytes(file.size) }) }}</p>
        <template v-else-if="mode === 'rendered' && isMarkdown"><MarkdownView :text="file.text ?? ''" class="md" /></template>
        <template v-else-if="mode === 'rendered' && isSvg"><img :src="svgUrl" :alt="file.display" class="img" /></template>
        <template v-else-if="mode === 'rendered' && isHtml">
          <p class="mh-muted small">{{ t('panel.preview.htmlNote') }}</p>
          <iframe class="frame" sandbox="" referrerpolicy="no-referrer" :srcdoc="file.text" :title="file.display" />
        </template>
        <MarkdownView v-else :text="source" class="md" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.note {
  padding: 24px;
  text-align: center;
}
.error {
  color: var(--mh-danger);
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--mh-border);
  font-size: 13px;
}
.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  font-size: 11px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  overflow: hidden;
}
.seg button {
  border: none;
  background: none;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--mh-muted);
  cursor: pointer;
}
.seg button.active {
  background: var(--mh-hover);
  color: var(--mh-text);
}
.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}
.img {
  max-width: 100%;
  object-fit: contain;
  align-self: center;
}
.frame {
  flex: 1;
  min-height: 300px;
  width: 100%;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  background: #fff;
}
.small {
  font-size: 12px;
  margin: 0 0 6px;
}
.content :deep(.mh-code .line.mh-line-hl) {
  display: inline-block;
  min-width: 100%;
  background: color-mix(in srgb, var(--mh-accent) 20%, transparent);
  box-shadow: inset 3px 0 0 var(--mh-accent);
}
</style>
