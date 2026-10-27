<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { ScheduledRun, ScheduledTask, ScheduledTaskInput } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { openConversation, store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';

const { t, locale } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 7000 });
const tasks = ref<ScheduledTask[]>([]);
const history = ref<ScheduledRun[]>([]);
const editing = ref<ScheduledTaskInput | null>(null);
const preview = ref<string[]>([]);
const previewError = ref<string | null>(null);

async function load() {
  [tasks.value, history.value] = await Promise.all([api.call('scheduler.list').catch(() => []), api.call('scheduler.history', { limit: 50 }).catch(() => [])]);
}
let off: (() => void) | null = null;
onMounted(() => {
  void load();
  off = api.on('scheduler.changed', () => void load());
});
onBeforeUnmount(() => off?.());

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = computed(() => {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [tz, 'UTC'];
  return list.includes('UTC') ? list : ['UTC', ...list];
});
function startNew() {
  editing.value = { name: '', cron: '0 8 * * mon-fri', timezone: tz, prompt: '', projectId: null, conversationId: null, mode: 'chat', agentMode: 'plan', providerId: null, model: null, enabled: true };
}
function edit(task: ScheduledTask) {
  const { lastRunAt: _l, nextRunAt: _n, ...rest } = task;
  editing.value = { ...rest };
}
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => editing.value && [editing.value.cron, editing.value.timezone],
  () => {
    clearTimeout(timer);
    const e = editing.value;
    if (!e) return;
    timer = setTimeout(async () => {
      try {
        preview.value = (await api.call('scheduler.preview', { cron: e.cron, timezone: e.timezone, count: 3 })).next;
        previewError.value = null;
      } catch (err) {
        preview.value = [];
        previewError.value = errorMessage(err);
      }
    }, 250);
  },
  { deep: true },
);
async function save() {
  if (!editing.value) return;
  try {
    await api.call('scheduler.save', editing.value);
    editing.value = null;
  } catch (e) {
    fail(e);
  }
}
async function runNow(task: ScheduledTask) {
  try {
    const r = await api.call('scheduler.runNow', { id: task.id });
    if (r.conversationId) {
      uiState.settingsOpen = false;
      await openConversation(r.conversationId);
    }
  } catch (e) {
    fail(e);
  }
}
function remove(task: ScheduledTask) {
  confirm.require({
    header: t('settings.schedulerSettings.deleteTitle', { name: task.name }),
    message: '',
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: () => api.call('scheduler.delete', { id: task.id }).catch(fail),
  });
}
const projectOptions = computed(() => [{ label: t('settings.schedulerSettings.personal'), value: null }, ...store.projects.map((p) => ({ label: p.name, value: p.id }))]);
const conversationOptions = computed(() => [{ label: t('settings.schedulerSettings.newEach'), value: null }, ...[...store.conversations.values()].filter((c) => c.parentId === null && !c.archived).map((c) => ({ label: c.title, value: c.id }))]);
const modeOptions = computed(() => [
  { label: t('modes.chat'), value: 'chat' },
  { label: t('modes.plan'), value: 'plan' },
  { label: t('modes.propose'), value: 'propose' },
  { label: t('modes.execute'), value: 'execute' },
]);
const modeValue = computed({
  get: () => (editing.value?.mode === 'chat' ? 'chat' : (editing.value?.agentMode ?? 'plan')),
  set: (v: string) => {
    if (!editing.value) return;
    editing.value.mode = v === 'chat' ? 'chat' : 'agent';
    if (v !== 'chat') editing.value.agentMode = v as 'plan';
  },
});
const providerOptions = computed(() => [{ label: t('studio.defaultModel'), value: null }, ...store.providers.filter((p) => p.enabled).map((p) => ({ label: p.name, value: p.id }))]);
const modelOptions = computed(() => (store.providers.find((p) => p.id === editing.value?.providerId)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id })));
function setProvider(v: number | null) {
  if (!editing.value) return;
  editing.value.providerId = v;
  editing.value.model = store.providers.find((p) => p.id === v)?.models.find((m) => m.enabled)?.id ?? null;
}
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
</script>

<template>
  <p class="mh-hint">{{ t('settings.schedulerSettings.hint') }}</p>
  <Button :label="t('settings.schedulerSettings.add')" icon="pi pi-plus" size="small" @click="startNew" />

  <div v-if="editing" class="box">
    <div class="mh-row wrap">
      <div class="mh-field grow">
        <label for="sc-name">{{ t('settings.schedulerSettings.name') }}</label>
        <InputText id="sc-name" v-model="editing.name" maxlength="80" fluid />
      </div>
      <div class="mh-switch-row compact">
        <label for="sc-en">{{ t('settings.schedulerSettings.enabled') }}</label>
        <ToggleSwitch input-id="sc-en" v-model="editing.enabled" />
      </div>
    </div>
    <div class="mh-row wrap">
      <div class="mh-field grow">
        <label for="sc-cron">{{ t('settings.schedulerSettings.cron') }}</label>
        <InputText id="sc-cron" v-model="editing.cron" class="mono" fluid />
        <p class="mh-hint">{{ t('settings.schedulerSettings.cronHint') }}</p>
      </div>
      <div class="mh-field">
        <label for="sc-tz">{{ t('settings.schedulerSettings.timezone') }}</label>
        <Select input-id="sc-tz" v-model="editing.timezone" :options="zones" filter class="sel" />
      </div>
    </div>
    <p v-if="previewError" class="err">{{ previewError }}</p>
    <p v-else-if="preview.length" class="mh-hint">{{ t('settings.schedulerSettings.next') }} : {{ preview.map(date).join(' · ') }}</p>
    <div class="mh-field">
      <label for="sc-prompt">{{ t('settings.schedulerSettings.prompt') }}</label>
      <Textarea id="sc-prompt" v-model="editing.prompt" rows="3" auto-resize fluid />
    </div>
    <div class="mh-row wrap">
      <div class="mh-field">
        <label for="sc-proj">{{ t('settings.schedulerSettings.project') }}</label>
        <Select input-id="sc-proj" v-model="editing.projectId" :options="projectOptions" option-label="label" option-value="value" class="sel" />
      </div>
      <div class="mh-field">
        <label for="sc-conv">{{ t('settings.schedulerSettings.conversation') }}</label>
        <Select input-id="sc-conv" v-model="editing.conversationId" :options="conversationOptions" option-label="label" option-value="value" filter class="sel" />
      </div>
      <div class="mh-field">
        <label for="sc-mode">{{ t('settings.schedulerSettings.mode') }}</label>
        <Select input-id="sc-mode" v-model="modeValue" :options="modeOptions" option-label="label" option-value="value" class="sel" />
      </div>
    </div>
    <div class="mh-row wrap">
      <div class="mh-field">
        <label for="sc-prov">{{ t('settings.schedulerSettings.model') }}</label>
        <div class="mh-row">
          <Select input-id="sc-prov" :model-value="editing.providerId" :options="providerOptions" option-label="label" option-value="value" class="sel" @update:model-value="setProvider" />
          <Select v-if="editing.providerId !== null" v-model="editing.model" :options="modelOptions" option-label="label" option-value="value" filter class="sel" />
        </div>
      </div>
    </div>
    <div class="mh-row end">
      <Button :label="t('common.cancel')" severity="secondary" text size="small" @click="editing = null" />
      <Button :label="t('settings.schedulerSettings.save')" icon="pi pi-check" size="small" :disabled="!editing.name.trim() || !editing.prompt.trim() || !!previewError" @click="save" />
    </div>
  </div>

  <p v-if="!tasks.length && !editing" class="mh-muted">{{ t('settings.schedulerSettings.empty') }}</p>
  <div v-for="task in tasks" :key="task.id" class="task">
    <div class="mh-row head">
      <i class="pi" :class="task.enabled ? 'pi-clock' : 'pi-pause'" />
      <div class="grow">
        <strong>{{ task.name }}</strong> <code class="mh-hint">{{ task.cron }}</code> <span class="mh-hint">{{ task.timezone }}</span>
        <div class="mh-hint">{{ t('settings.schedulerSettings.nextRun', { date: date(task.nextRunAt) }) }} · {{ t('settings.schedulerSettings.lastRun', { date: date(task.lastRunAt) }) }}</div>
      </div>
      <Button :label="t('settings.schedulerSettings.runNow')" icon="pi pi-play" size="small" text @click="runNow(task)" />
      <Button icon="pi pi-pencil" text rounded size="small" :aria-label="t('common.edit')" @click="edit(task)" />
      <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('common.delete')" @click="remove(task)" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.schedulerSettings.history') }}</h3>
  <p v-if="!history.length" class="mh-hint">{{ t('settings.schedulerSettings.noHistory') }}</p>
  <table v-else class="table">
    <tbody>
      <tr v-for="r in history" :key="r.id">
        <td>{{ date(r.startedAt) }}</td>
        <td>{{ r.taskName }}</td>
        <td :class="r.status">{{ t(`settings.schedulerSettings.status.${r.status}`) }}<span v-if="r.error" class="mh-hint"> — {{ r.error }}</span></td>
        <td><Button v-if="r.conversationId" icon="pi pi-external-link" text rounded size="small" :aria-label="t('notifications.open')" @click="(uiState.settingsOpen = false), openConversation(r.conversationId)" /></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.box {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 12px;
  margin: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grow {
  flex: 1;
  min-width: 180px;
}
.sel {
  min-width: 200px;
}
.mono {
  font-family: var(--mh-font-mono);
}
.compact {
  border: 0;
  gap: 8px;
}
.end {
  justify-content: flex-end;
}
.err {
  color: var(--mh-danger);
  font-size: 12.5px;
  margin: 0;
}
.task {
  border-bottom: 1px solid var(--mh-border);
  padding: 8px 0;
}
.head {
  align-items: center;
  gap: 10px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table td {
  border-bottom: 1px solid var(--mh-border);
  padding: 5px 6px;
}
td.done {
  color: #2f9e5b;
}
td.error {
  color: var(--mh-danger);
}
</style>
