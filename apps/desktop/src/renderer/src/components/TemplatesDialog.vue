<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { Id } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';
import { store } from '../stores/app.ts';

const props = defineProps<{ draft: string }>();
const emit = defineEmits<{ insert: [content: string] }>();
const visible = defineModel<boolean>('visible', { required: true });
const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();

const selectedId = ref<Id | null>(null);
const form = ref({ name: '', content: '' });
const selected = computed(() => store.templates.find((x) => x.id === selectedId.value) ?? null);
const dirty = computed(() => (selected.value ? selected.value.name !== form.value.name || selected.value.content !== form.value.content : form.value.name !== '' || form.value.content !== ''));

watch(visible, (v) => {
  if (v) select(store.templates[0]?.id ?? null);
});

function select(id: Id | null) {
  selectedId.value = id;
  const tpl = store.templates.find((x) => x.id === id);
  form.value = { name: tpl?.name ?? '', content: tpl?.content ?? '' };
}

function startNew(fromDraft: boolean) {
  selectedId.value = null;
  form.value = { name: '', content: fromDraft ? props.draft : '' };
}

const fail = (e: unknown) => toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 6000 });

async function save() {
  try {
    if (selected.value) await api.call('templates.update', { id: selected.value.id, patch: { ...form.value } });
    else {
      const created = await api.call('templates.create', { ...form.value });
      selectedId.value = created.id;
    }
    toast.add({ severity: 'success', summary: t('common.saved'), life: 2000 });
  } catch (e) {
    fail(e);
  }
}

function remove() {
  const tpl = selected.value;
  if (!tpl) return;
  confirm.require({
    header: t('templates.deleteTitle', { name: tpl.name }),
    message: t('templates.deleteMessage'),
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: async () => {
      await api.call('templates.delete', { id: tpl.id }).catch(fail);
      select(store.templates[0]?.id ?? null);
    },
  });
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="t('templates.title')" :style="{ width: 'min(820px, 94vw)' }">
    <div class="layout">
      <aside class="list">
        <button v-for="tpl in store.templates" :key="tpl.id" type="button" class="item" :class="{ active: tpl.id === selectedId }" @click="select(tpl.id)">{{ tpl.name }}</button>
        <p v-if="store.templates.length === 0" class="mh-hint">{{ t('templates.empty') }}</p>
        <Button :label="t('templates.new')" icon="pi pi-plus" size="small" text @click="startNew(false)" />
        <Button v-if="draft.trim()" :label="t('templates.fromDraft')" icon="pi pi-file-import" size="small" text @click="startNew(true)" />
      </aside>
      <section class="editor">
        <div class="mh-field">
          <label for="tpl-name">{{ t('templates.name') }}</label>
          <InputText id="tpl-name" v-model="form.name" maxlength="120" fluid />
        </div>
        <div class="mh-field">
          <label for="tpl-content">{{ t('templates.content') }}</label>
          <Textarea id="tpl-content" v-model="form.content" rows="10" auto-resize fluid />
        </div>
      </section>
    </div>
    <template #footer>
      <Button v-if="selected" :label="t('common.delete')" severity="danger" text @click="remove" />
      <span class="grow" />
      <Button :label="t('templates.insert')" severity="secondary" outlined :disabled="!form.content.trim()" @click="(emit('insert', form.content), (visible = false))" />
      <Button :label="t('common.save')" icon="pi pi-check" :disabled="!dirty || !form.name.trim() || !form.content.trim()" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.layout {
  display: flex;
  gap: 16px;
  min-height: 320px;
}
.list {
  width: 220px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--mh-border);
  padding-right: 10px;
}
.item {
  border: 0;
  background: transparent;
  text-align: left;
  padding: 7px 10px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
}
.item:hover {
  background: var(--mh-hover);
}
.item.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  font-weight: 600;
}
.editor {
  flex: 1;
  min-width: 0;
}
.grow {
  flex: 1;
}
@media (max-width: 640px) {
  .layout {
    flex-direction: column;
  }
  .list {
    width: auto;
    border-right: 0;
    border-bottom: 1px solid var(--mh-border);
    padding: 0 0 10px;
  }
}
</style>
