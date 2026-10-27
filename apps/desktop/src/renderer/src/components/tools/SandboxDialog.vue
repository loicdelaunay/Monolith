<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { Id, SandboxChange, SandboxStatus } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import DiffView from './DiffView.vue';

const props = defineProps<{ conversationId: Id }>();
const visible = defineModel<boolean>('visible', { required: true });
const { t, locale } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const status = ref<SandboxStatus | null>(null);
const changes = ref<SandboxChange[]>([]);
const selected = ref<Set<string>>(new Set());
const open = ref<string | null>(null);
const busy = ref(false);
const conflicts = ref<string[]>([]);
const key = (c: { root: number; path: string }) => `${c.root}:${c.path}`;
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 7000 });

async function load() {
  status.value = await api.call('sandbox.status', { conversationId: props.conversationId }).catch((e) => (fail(e), null));
  changes.value = status.value?.enabled ? await api.call('sandbox.diff', { conversationId: props.conversationId }).catch((e) => (fail(e), [])) : [];
  selected.value = new Set([...selected.value].filter((k) => changes.value.some((c) => key(c) === k)));
}
watch(visible, (v) => v && void load(), { immediate: true });

async function enable() {
  busy.value = true;
  try {
    status.value = await api.call('sandbox.enable', { conversationId: props.conversationId });
    await load();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function apply(force = false) {
  busy.value = true;
  try {
    const files = changes.value.filter((c) => selected.value.has(key(c))).map((c) => ({ root: c.root, path: c.path }));
    const r = await api.call('sandbox.apply', { conversationId: props.conversationId, files, force });
    conflicts.value = r.conflicts;
    if (r.applied) toast.add({ severity: 'success', summary: t('sandbox.applied', { count: r.applied }), life: 3000 });
    await load();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
function discard() {
  confirm.require({
    header: t('sandbox.discardTitle'),
    message: t('sandbox.discardMessage'),
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('sandbox.discard'), severity: 'danger' },
    accept: async () => {
      status.value = await api.call('sandbox.discard', { conversationId: props.conversationId }).catch((e) => (fail(e), status.value));
      changes.value = [];
    },
  });
}
function toggle(c: SandboxChange, v: boolean) {
  const next = new Set(selected.value);
  if (v) next.add(key(c));
  else next.delete(key(c));
  selected.value = next;
}
const allSelected = computed(() => changes.value.length > 0 && changes.value.every((c) => selected.value.has(key(c))));
function toggleAll(v: boolean) {
  selected.value = new Set(v ? changes.value.map(key) : []);
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="t('sandbox.title')" :style="{ width: 'min(1000px, 94vw)' }">
    <p class="mh-hint">{{ t('sandbox.intro') }}</p>
    <template v-if="status && !status.enabled">
      <Button :label="t('sandbox.enable')" icon="pi pi-box" :loading="busy" @click="enable" />
    </template>
    <template v-else-if="status">
      <p><strong>{{ t('sandbox.active', { date: status.createdAt ? new Date(status.createdAt).toLocaleString(locale) : '' }) }}</strong></p>
      <ul class="roots">
        <li v-for="r in status.roots" :key="r.copy"><code>{{ t('sandbox.copies', { original: r.original }) }}</code></li>
      </ul>
      <div class="mh-row wrap bar">
        <label class="all"><Checkbox :model-value="allSelected" binary @update:model-value="toggleAll" /> {{ t('sandbox.changes', { count: changes.length }) }}</label>
        <span class="grow" />
        <Button :label="t('sandbox.refresh')" icon="pi pi-refresh" size="small" text @click="load" />
        <Button :label="t('sandbox.applySelected', { count: selected.size })" icon="pi pi-check" size="small" :disabled="!selected.size" :loading="busy" @click="apply(false)" />
      </div>
      <Message v-if="conflicts.length" severity="warn" size="small">
        {{ t('sandbox.conflicts', { paths: conflicts.join(', ') }) }}
        <Button :label="t('sandbox.applyForce')" size="small" severity="warn" text @click="apply(true)" />
      </Message>
      <p v-if="!changes.length" class="mh-muted">{{ t('sandbox.noChanges') }}</p>
      <div v-for="c in changes" :key="key(c)" class="change">
        <div class="mh-row head">
          <Checkbox :model-value="selected.has(key(c))" binary :aria-label="c.path" @update:model-value="(v: boolean) => toggle(c, v)" />
          <button type="button" class="path" @click="open = open === key(c) ? null : key(c)">
            <i class="pi" :class="open === key(c) ? 'pi-angle-down' : 'pi-angle-right'" />
            <code>{{ c.path }}</code>
          </button>
          <span class="tag" :class="c.status">{{ t(`sandbox.status.${c.status}`) }}</span>
          <span v-if="c.conflict" class="tag conflict">{{ t('sandbox.conflict') }}</span>
        </div>
        <template v-if="open === key(c)">
          <p v-if="c.binary" class="mh-hint">{{ t('sandbox.binary') }}</p>
          <DiffView v-else :before="c.before" :after="c.after" :path="c.path" />
        </template>
      </div>
    </template>
    <template #footer>
      <Button v-if="status?.enabled" :label="t('sandbox.discard')" severity="danger" text @click="discard" />
      <Button :label="t('common.close')" severity="secondary" @click="visible = false" />
    </template>
  </Dialog>
</template>

<style scoped>
.roots {
  margin: 0 0 8px;
  padding-left: 18px;
  font-size: 12.5px;
}
.bar {
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.all {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
}
.change {
  border-top: 1px solid var(--mh-border);
  padding: 6px 0;
}
.head {
  align-items: center;
  gap: 8px;
}
.path {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--mh-text);
  font: inherit;
}
.tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mh-hover);
}
.tag.created {
  color: #2f9e5b;
}
.tag.modified {
  color: #c08a1e;
}
.tag.deleted,
.tag.conflict {
  color: var(--mh-danger);
}
</style>
