<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { Conversation, FileProposal, Id } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';
import DockSection from '../DockSection.vue';
import DiffView from './DiffView.vue';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const pending = computed<FileProposal[]>(() => (store.proposals.get(props.conversation.id) ?? []).filter((p) => p.status === 'pending' || p.status === 'conflict'));
const applicable = computed(() => pending.value.filter((p) => p.status === 'pending'));
const summary = computed(() => pending.value[0]?.change.path ?? null);
const openId = ref<Id | null>(null);

async function run(p: FileProposal, action: 'apply' | 'reject'): Promise<boolean> {
  try {
    await api.call(action === 'apply' ? 'proposals.apply' : 'proposals.reject', { id: p.id });
    return true;
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 7000 });
    return false;
  }
}
async function act(p: FileProposal, action: 'apply' | 'reject') {
  if (await run(p, action)) toast.add({ severity: 'success', summary: action === 'apply' ? t('proposals.applied', { path: p.change.path }) : t('proposals.rejected'), life: 2500 });
}
async function runAll(list: FileProposal[], action: 'apply' | 'reject') {
  let count = 0;
  for (const p of list) if (await run(p, action)) count++;
  if (count) toast.add({ severity: 'success', summary: t(action === 'apply' ? 'proposals.appliedAll' : 'proposals.rejectedAll', { count }), life: 2500 });
}
function rejectAll() {
  const list = [...pending.value];
  if (list.length === 1) return void act(list[0]!, 'reject');
  // Un refus ne se rattrape pas : les changements proposés sont abandonnés.
  confirm.require({
    header: t('proposals.rejectAllTitle', { count: list.length }),
    message: t('proposals.rejectAllMessage'),
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('proposals.rejectAll'), severity: 'danger' },
    accept: () => void runAll(list, 'reject'),
  });
}
</script>

<template>
  <DockSection v-if="pending.length" icon="pi-file-edit" :title="t('proposals.title')" :count="pending.length" :summary="summary" :max-height="320">
    <template #actions>
      <button type="button" class="mh-pill" @click="rejectAll">{{ t('proposals.rejectAll') }}</button>
      <button type="button" class="mh-pill accent" :disabled="!applicable.length" @click="runAll(applicable, 'apply')">{{ t('proposals.applyAll') }}</button>
    </template>
    <ul>
      <li v-for="p in pending" :key="p.id">
        <div class="row">
          <button type="button" class="file" :aria-expanded="openId === p.id" @click="openId = openId === p.id ? null : p.id">
            <i class="pi" :class="openId === p.id ? 'pi-angle-down' : 'pi-angle-right'" />
            <code>{{ p.change.path }}</code>
            <span class="kind">{{ t(`tools.change.${p.change.status}`) }}</span>
            <span v-if="p.status === 'conflict'" class="conflict">{{ t('proposals.conflict') }}</span>
          </button>
          <button type="button" class="mh-pill" @click="act(p, 'reject')">{{ t('proposals.reject') }}</button>
          <button type="button" class="mh-pill accent" :disabled="p.status === 'conflict'" @click="act(p, 'apply')">{{ t('proposals.apply') }}</button>
        </div>
        <DiffView v-if="openId === p.id" :before="p.change.before" :after="p.change.after" />
      </li>
    </ul>
  </DockSection>
</template>

<style scoped>
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}
.file {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  padding: 3px 4px 3px 0;
  text-align: left;
}
.file:hover {
  background: var(--mh-hover);
}
.file .pi {
  font-size: 12px;
  color: var(--mh-muted);
}
.file code {
  font-family: var(--mh-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kind {
  flex: none;
  color: var(--mh-muted);
  font-size: 12px;
}
.conflict {
  flex: none;
  color: var(--mh-warning);
  font-size: 12px;
}
</style>
