<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { Conversation, FileProposal, Id } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';
import DiffView from './DiffView.vue';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();
const pending = computed<FileProposal[]>(() => (store.proposals.get(props.conversation.id) ?? []).filter((p) => p.status === 'pending' || p.status === 'conflict'));
const openId = ref<Id | null>(null);

async function act(p: FileProposal, action: 'apply' | 'reject') {
  try {
    await api.call(action === 'apply' ? 'proposals.apply' : 'proposals.reject', { id: p.id });
    toast.add({ severity: 'success', summary: action === 'apply' ? t('proposals.applied', { path: p.change.path }) : t('proposals.rejected'), life: 2500 });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 7000 });
  }
}
async function applyAll() {
  for (const p of pending.value.filter((x) => x.status === 'pending')) await act(p, 'apply');
}
</script>

<template>
  <section v-if="pending.length" class="proposals" :aria-label="t('proposals.title')">
    <header>
      <i class="pi pi-file-edit" />
      <span>{{ t('proposals.title') }} ({{ pending.length }})</span>
      <Button :label="t('proposals.applyAll')" size="small" text @click="applyAll" />
    </header>
    <ul>
      <li v-for="p in pending" :key="p.id">
        <div class="row">
          <button type="button" class="file" :aria-expanded="openId === p.id" @click="openId = openId === p.id ? null : p.id">
            <i class="pi" :class="openId === p.id ? 'pi-angle-down' : 'pi-angle-right'" />
            <code>{{ p.change.path }}</code>
            <span class="mh-hint">{{ t(`tools.change.${p.change.status}`) }}</span>
            <span v-if="p.status === 'conflict'" class="conflict">{{ t('proposals.conflict') }}</span>
          </button>
          <Button :label="t('proposals.reject')" size="small" severity="secondary" text @click="act(p, 'reject')" />
          <Button :label="t('proposals.apply')" size="small" :disabled="p.status === 'conflict'" @click="act(p, 'apply')" />
        </div>
        <DiffView v-if="openId === p.id" :before="p.change.before" :after="p.change.after" />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.proposals {
  max-width: 900px;
  margin: 0 auto 8px;
  border: 1px solid color-mix(in srgb, var(--mh-accent) 40%, var(--mh-border));
  border-radius: var(--mh-radius);
  background: var(--mh-surface);
  font-size: 13px;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--mh-border);
}
header span {
  flex: 1;
}
ul {
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 320px;
  overflow-y: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.file {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 4px 6px;
  text-align: left;
}
.file code {
  font-family: var(--mh-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict {
  color: var(--mh-warning);
  font-size: 12px;
}
</style>
