<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import { useToast } from 'primevue/usetoast';
import type { FileEntry, Id } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { uiState } from '../../ui-state.ts';
import { formatSize as formatBytes } from '../../lib/attachments.ts';

const props = defineProps<{ conversationId: Id }>();
const emit = defineEmits<{ preview: [] }>();
const { t } = useI18n();
const toast = useToast();

const stack = ref<string[]>([]); // dossiers ouverts depuis la racine (vide = ressources)
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const query = ref('');
const inContent = ref(false);
const results = ref<{ display: string; path: string; line: number | null; text: string | null }[] | null>(null);
const current = computed(() => stack.value.at(-1));

const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

async function load() {
  loading.value = true;
  try {
    entries.value = (await api.call('files.list', { conversationId: props.conversationId, ...(current.value ? { path: current.value } : {}) })).entries;
  } catch (e) {
    fail(e);
    if (stack.value.length) stack.value.pop();
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(current, load);

function open(e: FileEntry) {
  if (e.type === 'directory') stack.value = [...stack.value, e.path];
  else preview(e.path, null);
}
function preview(path: string, line: number | null) {
  uiState.preview = { conversationId: props.conversationId, path, line };
  emit('preview');
}

let timer: ReturnType<typeof setTimeout> | null = null;
watch([query, inContent], () => {
  if (timer) clearTimeout(timer);
  if (!query.value.trim()) {
    results.value = null;
    return;
  }
  timer = setTimeout(async () => {
    results.value = await api.call('files.search', { conversationId: props.conversationId, query: query.value, content: inContent.value }).catch((e) => (fail(e), []));
  }, 250);
});

async function copy(path: string) {
  await navigator.clipboard.writeText(path);
  toast.add({ severity: 'success', summary: t('common.copied'), life: 1500 });
}
const crumbs = computed(() => stack.value.map((p, i) => ({ label: p.split(/[\\/]/).filter(Boolean).at(-1) ?? p, index: i })));
</script>

<template>
  <div class="files">
    <div class="bar">
      <InputText v-model="query" :placeholder="t('panel.files.search')" :aria-label="t('panel.files.search')" size="small" class="grow" />
      <label class="opt"><Checkbox v-model="inContent" binary input-id="fc" /> <span>{{ t('panel.files.searchContent') }}</span></label>
      <button type="button" class="mh-icon-btn" :aria-label="t('panel.files.refresh')" v-tooltip.bottom="t('panel.files.refresh')" @click="load"><i class="pi pi-refresh" /></button>
    </div>

    <ul v-if="results" class="list" :aria-label="t('panel.files.search')">
      <li v-if="!results.length" class="mh-muted pad">{{ t('panel.files.noResult') }}</li>
      <li v-for="(r, i) in results" :key="i">
        <button type="button" class="row" @click="preview(r.path, r.line)">
          <i class="pi pi-file" />
          <span class="name">{{ r.display }}<template v-if="r.line">:{{ r.line }}</template></span>
          <span v-if="r.text" class="snippet">{{ r.text.trim() }}</span>
        </button>
      </li>
    </ul>

    <template v-else>
      <nav class="crumbs" aria-label="breadcrumb">
        <button type="button" class="crumb" @click="stack = []"><i class="pi pi-home" /> {{ t('panel.files.root') }}</button>
        <template v-for="c in crumbs" :key="c.index">
          <i class="pi pi-angle-right sep" />
          <button type="button" class="crumb" @click="stack = stack.slice(0, c.index + 1)">{{ c.label }}</button>
        </template>
      </nav>
      <ul class="list" :aria-busy="loading">
        <li v-if="!loading && !entries.length" class="mh-muted pad">{{ stack.length ? t('panel.files.noResult') : t('panel.files.empty') }}</li>
        <li v-if="stack.length">
          <button type="button" class="row" @click="stack = stack.slice(0, -1)"><i class="pi pi-arrow-up" /> <span class="name">..</span></button>
        </li>
        <li v-for="e in entries" :key="e.path" class="item">
          <button type="button" class="row" :title="e.display" @click="open(e)">
            <i class="pi" :class="e.type === 'directory' ? 'pi-folder' : 'pi-file'" />
            <span class="name">{{ e.name }}</span>
            <span v-if="e.type === 'file'" class="size">{{ formatBytes(e.size) }}</span>
          </button>
          <span class="acts">
            <button type="button" class="mh-icon-btn" :aria-label="t('panel.files.copyPath')" v-tooltip.left="t('panel.files.copyPath')" @click="copy(e.path)"><i class="pi pi-copy" /></button>
            <button type="button" class="mh-icon-btn" :aria-label="t('panel.files.reveal')" v-tooltip.left="t('panel.files.reveal')" @click="host.showItemInFolder(e.path)"><i class="pi pi-external-link" /></button>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.files {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--mh-border);
}
.grow {
  flex: 1;
  min-width: 0;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--mh-muted);
  white-space: nowrap;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  font-size: 12px;
}
.crumb {
  border: none;
  background: none;
  color: var(--mh-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font: inherit;
}
.crumb:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
.sep {
  font-size: 10px;
  color: var(--mh-muted);
}
.list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow: auto;
  flex: 1;
}
.pad {
  padding: 12px;
}
.item {
  display: flex;
  align-items: center;
}
.row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: none;
  background: none;
  color: var(--mh-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--mh-radius-sm);
}
.row:hover {
  background: var(--mh-hover);
}
.row .pi {
  color: var(--mh-muted);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mh-muted);
  font-family: var(--mh-font-mono);
  font-size: 12px;
}
.size {
  margin-left: auto;
  color: var(--mh-muted);
  font-size: 11px;
}
.acts {
  display: none;
}
.item:hover .acts,
.item:focus-within .acts {
  display: inline-flex;
}
</style>
