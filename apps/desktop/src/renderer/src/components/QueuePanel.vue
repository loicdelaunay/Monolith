<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'primevue/usetoast';
import type { Conversation, Id, QueuedInput } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';
import { store } from '../stores/app.ts';
import DockSection from './DockSection.vue';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();

const items = computed<QueuedInput[]>(() => store.queues.get(props.conversation.id) ?? []);
/** File en pause : rien ne génère et des éléments attendent (après une annulation ou une erreur). */
const paused = computed(() => !props.conversation.generating && items.value.some((i) => i.kind === 'queue'));
const summary = computed(() => items.value[0]?.text || items.value[0]?.attachments.map((a) => a.name).join(', ') || null);
const editingId = ref<Id | null>(null);
const editText = ref('');

const fail = (e: unknown) => toast.add({ severity: 'error', summary: t('errors.internal'), detail: errorMessage(e), life: 6000 });

function startEdit(item: QueuedInput) {
  editingId.value = item.id;
  editText.value = item.text;
}
async function commitEdit() {
  const id = editingId.value;
  editingId.value = null;
  if (id !== null) await api.call('queue.update', { id, text: editText.value }).catch(fail);
}
async function move(item: QueuedInput, delta: number) {
  const list = items.value.filter((i) => i.kind === item.kind).map((i) => i.id);
  const from = list.indexOf(item.id);
  const to = from + delta;
  if (to < 0 || to >= list.length) return;
  list.splice(from, 1);
  list.splice(to, 0, item.id);
  await api.call('queue.reorder', { conversationId: props.conversation.id, ids: list }).catch(fail);
}
/** Orienter : le message rejoint la réflexion en cours (ou part tout de suite si rien ne génère). */
async function setKind(item: QueuedInput, kind: 'queue' | 'steer') {
  await api.call('queue.setKind', { id: item.id, kind }).catch(fail);
}
async function sendNext() {
  await api.call('queue.sendNext', { conversationId: props.conversation.id }).catch(fail);
}
</script>

<template>
  <DockSection v-if="items.length" icon="pi-list" :title="t('queue.title')" :count="items.length" :summary="summary">
    <template #actions>
      <span v-if="paused" class="paused">{{ t('queue.paused') }}</span>
      <button v-if="paused" type="button" class="mh-pill accent" @click="sendNext"><i class="pi pi-play" /> {{ t('queue.sendNext') }}</button>
    </template>
    <ul>
      <li v-for="item in items" :key="item.id" :class="item.kind">
        <span class="kind" :title="item.kind === 'steer' ? t('queue.steerHint') : t('queue.enqueueHint')">
          <i class="pi" :class="item.kind === 'steer' ? 'pi-bolt' : 'pi-clock'" />
        </span>
        <textarea v-if="editingId === item.id" v-model="editText" class="edit" rows="2" :aria-label="t('common.edit')" @keydown.enter.exact.prevent="commitEdit" @keydown.esc.prevent="editingId = null" @blur="commitEdit" />
        <button v-else type="button" class="text" :title="t('common.edit')" @click="startEdit(item)">
          {{ item.text || item.attachments.map((a) => a.name).join(', ') }}
          <span v-if="item.attachments.length && item.text" class="mh-hint"> · 📎 {{ item.attachments.length }}</span>
        </button>
        <button v-if="item.kind === 'queue'" type="button" class="mh-pill accent" :aria-label="t('queue.orient')" v-tooltip.top="conversation.generating ? t('queue.orientHint') : t('queue.orientNowHint')" @click="setKind(item, 'steer')">
          <i class="pi pi-bolt" /> {{ t('queue.orient') }}
        </button>
        <button v-else type="button" class="mh-icon-btn" :aria-label="t('queue.unorient')" v-tooltip.top="t('queue.unorient')" @click="setKind(item, 'queue')"><i class="pi pi-clock" /></button>
        <button type="button" class="mh-icon-btn" :aria-label="t('queue.up')" @click="move(item, -1)"><i class="pi pi-arrow-up" /></button>
        <button type="button" class="mh-icon-btn" :aria-label="t('queue.down')" @click="move(item, 1)"><i class="pi pi-arrow-down" /></button>
        <button type="button" class="mh-icon-btn" :aria-label="t('common.delete')" @click="api.call('queue.remove', { id: item.id }).catch(fail)"><i class="pi pi-times" /></button>
      </li>
    </ul>
  </DockSection>
</template>

<style scoped>
.paused {
  flex: none;
  color: var(--mh-warning);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 0;
}
.kind {
  flex: none;
  width: 20px;
  font-size: 12px;
  color: var(--mh-muted);
}
.kind .pi {
  font-size: 12px;
}
li.steer .kind {
  color: var(--mh-accent);
}
.text {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.text:hover {
  background: var(--mh-hover);
}
.edit {
  flex: 1;
  resize: vertical;
  border: 1px solid var(--mh-accent);
  border-radius: 6px;
  padding: 4px 6px;
  background: var(--mh-surface);
}
</style>
