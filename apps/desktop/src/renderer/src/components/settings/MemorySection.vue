<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import Slider from 'primevue/slider';
import ToggleSwitch from 'primevue/toggleswitch';
import Paginator from 'primevue/paginator';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { Memory, MemoryQuery, MemoryScope, MemoryVersion, Settings } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';

defineProps<{ draft: Settings }>();
const { t, locale } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

const SCOPES: MemoryScope[] = ['conversation', 'project', 'global', 'user'];
const query = reactive({ text: '', scope: null as MemoryScope | null, sort: 'updated' as NonNullable<MemoryQuery['sort']>, order: 'desc' as 'asc' | 'desc', first: 0 });
const PAGE = 20;
const items = ref<Memory[]>([]);
const total = ref(0);

async function load() {
  const r = await api.call('memory.list', { ...(query.text.trim() ? { query: query.text } : {}), ...(query.scope ? { scope: query.scope } : {}), sort: query.sort, order: query.order, limit: PAGE, offset: query.first }).catch((e) => (fail(e), { items: [], total: 0 }));
  items.value = r.items;
  total.value = r.total;
}
let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => [query.text, query.scope, query.sort, query.order], () => {
  clearTimeout(timer);
  query.first = 0;
  timer = setTimeout(load, 200);
});
watch(() => query.first, load);
let off: (() => void) | null = null;
onMounted(() => {
  void load();
  off = api.on('memory.changed', () => void load());
});
onBeforeUnmount(() => off?.());

function sortBy(col: NonNullable<MemoryQuery['sort']>) {
  if (query.sort === col) query.order = query.order === 'asc' ? 'desc' : 'asc';
  else Object.assign(query, { sort: col, order: col === 'title' ? 'asc' : 'desc' });
}
const scopeOptions = computed(() => [{ label: t('settings.memorySettings.allScopes'), value: null }, ...SCOPES.map((s) => ({ label: t(`settings.memorySettings.scopes.${s}`), value: s }))]);
const editScopes = computed(() => SCOPES.filter((s) => s !== 'conversation').map((s) => ({ label: t(`settings.memorySettings.scopes.${s}`), value: s })));
const projectOptions = computed(() => store.projects.map((p) => ({ label: p.name, value: p.id })));
const projectName = (id: number | null) => store.projects.find((p) => p.id === id)?.name ?? '';

// ---------- Édition ----------
const edit = reactive({ open: false, id: null as number | null, scope: 'global' as MemoryScope, projectId: null as number | null, conversationId: null as number | null, title: '', content: '', tags: '', versions: [] as MemoryVersion[] });
async function open(m: Memory | null) {
  if (m) {
    const full = await api.call('memory.get', { id: m.id }).catch((e) => (fail(e), null));
    if (!full) return;
    Object.assign(edit, { open: true, id: m.id, scope: m.scope, projectId: m.projectId, conversationId: m.conversationId, title: m.title, content: m.content, tags: m.tags.join(', '), versions: full.versions });
  } else Object.assign(edit, { open: true, id: null, scope: 'global', projectId: null, conversationId: null, title: '', content: '', tags: '', versions: [] });
}
async function save() {
  try {
    await api.call('memory.save', { ...(edit.id !== null ? { id: edit.id } : {}), scope: edit.scope, projectId: edit.projectId, conversationId: edit.conversationId, title: edit.title, content: edit.content, tags: edit.tags.split(',').map((x) => x.trim()).filter(Boolean) });
    edit.open = false;
  } catch (e) {
    fail(e);
  }
}
function remove(m: Memory) {
  confirm.require({
    header: t('settings.memorySettings.deleteTitle', { title: m.title }),
    message: t('settings.memorySettings.deleteMessage'),
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: () => api.call('memory.delete', { id: m.id }).catch(fail),
  });
}
const date = (iso: string) => new Date(iso).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' });
</script>

<template>
  <div class="mh-switch-row">
    <div>
      <label for="mem-fr">{{ t('settings.memorySettings.forcedRead') }}</label>
      <p class="mh-hint">{{ t('settings.memorySettings.forcedReadHint') }}</p>
    </div>
    <ToggleSwitch input-id="mem-fr" v-model="draft.memory.forcedRead" />
  </div>
  <div v-if="draft.memory.forcedRead" class="mh-field">
    <label id="mem-cnt">{{ t('settings.memorySettings.forcedReadCount', { value: draft.memory.forcedReadCount }) }}</label>
    <Slider v-model="draft.memory.forcedReadCount" :min="1" :max="100" aria-labelledby="mem-cnt" />
  </div>
  <div class="mh-switch-row">
    <div>
      <label for="mem-fw">{{ t('settings.memorySettings.forcedWrite') }}</label>
      <p class="mh-hint">{{ t('settings.memorySettings.forcedWriteHint') }}</p>
    </div>
    <ToggleSwitch input-id="mem-fw" v-model="draft.memory.forcedWrite" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.memorySettings.admin') }} <span class="mh-hint">({{ total }})</span></h3>
  <div class="mh-row wrap bar">
    <InputText v-model="query.text" :placeholder="t('settings.memorySettings.search')" :aria-label="t('settings.memorySettings.search')" size="small" class="grow" />
    <Select v-model="query.scope" :options="scopeOptions" option-label="label" option-value="value" size="small" :placeholder="t('settings.memorySettings.allScopes')" :aria-label="t('settings.memorySettings.scope')" />
    <Button :label="t('settings.memorySettings.add')" icon="pi pi-plus" size="small" @click="open(null)" />
  </div>

  <div v-if="edit.open" class="box">
    <div class="mh-row wrap">
      <div class="mh-field grow">
        <label for="mem-title">{{ t('settings.memorySettings.title') }}</label>
        <InputText id="mem-title" v-model="edit.title" maxlength="200" fluid />
      </div>
      <div v-if="edit.scope !== 'conversation'" class="mh-field">
        <label for="mem-scope">{{ t('settings.memorySettings.scope') }}</label>
        <Select input-id="mem-scope" v-model="edit.scope" :options="editScopes" option-label="label" option-value="value" />
      </div>
      <div v-if="edit.scope === 'project'" class="mh-field">
        <label for="mem-proj">{{ t('settings.memorySettings.project') }}</label>
        <Select input-id="mem-proj" v-model="edit.projectId" :options="projectOptions" option-label="label" option-value="value" :placeholder="t('settings.memorySettings.projectRequired')" />
      </div>
    </div>
    <div class="mh-field">
      <label for="mem-content">{{ t('settings.memorySettings.content') }}</label>
      <Textarea id="mem-content" v-model="edit.content" rows="4" auto-resize fluid />
    </div>
    <div class="mh-field">
      <label for="mem-tags">{{ t('settings.memorySettings.tags') }}</label>
      <InputText id="mem-tags" v-model="edit.tags" fluid />
    </div>
    <details v-if="edit.id !== null">
      <summary>{{ t('settings.memorySettings.versions') }} ({{ edit.versions.length }})</summary>
      <p v-if="!edit.versions.length" class="mh-hint">{{ t('settings.memorySettings.noVersions') }}</p>
      <div v-for="v in edit.versions" :key="v.version" class="version">
        <strong>v{{ v.version }}</strong> · {{ date(v.createdAt) }} · {{ t(`settings.memorySettings.sources.${v.source}`) }} — {{ v.title }}
        <div class="mh-hint">{{ v.content }}</div>
      </div>
    </details>
    <div class="mh-row end">
      <Button :label="t('common.cancel')" severity="secondary" text size="small" @click="edit.open = false" />
      <Button :label="t('common.save')" icon="pi pi-check" size="small" :disabled="!edit.title.trim() || !edit.content.trim() || (edit.scope === 'project' && edit.projectId === null)" @click="save" />
    </div>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th><button type="button" @click="sortBy('title')">{{ t('settings.memorySettings.title') }} <i v-if="query.sort === 'title'" class="pi" :class="query.order === 'asc' ? 'pi-sort-up' : 'pi-sort-down'" /></button></th>
        <th><button type="button" @click="sortBy('scope')">{{ t('settings.memorySettings.scope') }} <i v-if="query.sort === 'scope'" class="pi" :class="query.order === 'asc' ? 'pi-sort-up' : 'pi-sort-down'" /></button></th>
        <th><button type="button" @click="sortBy('updated')">{{ t('settings.memorySettings.updated') }} <i v-if="query.sort === 'updated'" class="pi" :class="query.order === 'asc' ? 'pi-sort-up' : 'pi-sort-down'" /></button></th>
        <th />
      </tr>
    </thead>
    <tbody>
      <tr v-if="!items.length"><td colspan="4" class="mh-muted">{{ t('settings.memorySettings.empty') }}</td></tr>
      <tr v-for="m in items" :key="m.id">
        <td>
          <button type="button" class="link" @click="open(m)">{{ m.title }}</button>
          <div class="mh-hint clip">{{ m.content }}</div>
        </td>
        <td>{{ t(`settings.memorySettings.scopes.${m.scope}`) }}<span v-if="m.projectId" class="mh-hint"> · {{ projectName(m.projectId) }}</span></td>
        <td class="nowrap">{{ date(m.updatedAt) }}<div class="mh-hint">v{{ m.version }} · {{ t(`settings.memorySettings.sources.${m.source}`) }}</div></td>
        <td><Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('common.delete')" @click="remove(m)" /></td>
      </tr>
    </tbody>
  </table>
  <Paginator v-if="total > PAGE" v-model:first="query.first" :rows="PAGE" :total-records="total" />
</template>

<style scoped>
.bar {
  gap: 8px;
  margin-bottom: 8px;
}
.grow {
  flex: 1;
  min-width: 160px;
}
.box {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 12px;
  margin-bottom: 12px;
}
.end {
  justify-content: flex-end;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th {
  text-align: left;
  border-bottom: 1px solid var(--mh-border);
  padding: 6px;
}
.table th button {
  border: 0;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--mh-text);
  cursor: pointer;
  padding: 0;
}
.table td {
  border-bottom: 1px solid var(--mh-border);
  padding: 6px;
  vertical-align: top;
}
.link {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--mh-accent);
  cursor: pointer;
  text-align: left;
}
.clip {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.nowrap {
  white-space: nowrap;
}
.version {
  margin: 6px 0;
  font-size: 12.5px;
}
</style>
