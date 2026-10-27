<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import ContextMenu from 'primevue/contextmenu';
import Dialog from 'primevue/dialog';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { MenuItem } from 'primevue/menuitem';
import type { Id, Provider, ProviderPreset, Settings } from '@monolith/contracts';
import { KINDS_WITHOUT_BASE_URL } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';
import ProviderLogo from '../ProviderLogo.vue';
import ProviderDetail from './ProviderDetail.vue';

const props = defineProps<{ draft: Settings }>();
const emit = defineEmits<{ 'update:dirty': [value: boolean] }>();
const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();

const query = ref('');
const selectedId = ref<Id | null>(uiState.settingsProviderId ?? store.providers[0]?.id ?? null);
uiState.settingsProviderId = null;
const detailDirty = ref(false);
const showDetailOnSmall = ref(selectedId.value !== null);
watch(detailDirty, (v) => emit('update:dirty', v));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return store.providers.filter((p) => !q || p.name.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q) || p.preset.includes(q));
});
const selected = computed(() => store.providers.find((p) => p.id === selectedId.value) ?? null);
const presetName = (id: string) => store.presets.find((p) => p.id === id)?.name ?? id;

watch(
  () => store.providers.map((p) => p.id),
  (ids) => {
    if (selectedId.value !== null && !ids.includes(selectedId.value)) selectedId.value = ids[0] ?? null;
    if (selectedId.value === null && ids.length) selectedId.value = ids[0]!;
  },
);

function fail(e: unknown) {
  toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 7000 });
}

function guardSwitch(action: () => void) {
  if (!detailDirty.value) return action();
  confirm.require({
    header: t('settings.discardTitle'),
    message: t('settings.providers.unsaved'),
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('settings.discard'), severity: 'danger' },
    accept: () => {
      detailDirty.value = false;
      action();
    },
  });
}

function select(id: Id) {
  if (id === selectedId.value) {
    showDetailOnSmall.value = true;
    return;
  }
  guardSwitch(() => {
    selectedId.value = id;
    showDetailOnSmall.value = true;
  });
}

// ---------- Ajout (immédiat) ----------
const presetPicker = ref(false);
async function addFromPreset(preset: ProviderPreset) {
  if (!preset.available) return;
  presetPicker.value = false;
  try {
    const p = await api.call('providers.create', { name: preset.name, kind: preset.kind, preset: preset.id, baseUrl: preset.baseUrl || ((KINDS_WITHOUT_BASE_URL as readonly string[]).includes(preset.kind) ? '' : 'http://127.0.0.1:8080/v1') });
    store.providers = store.providers.some((x) => x.id === p.id) ? store.providers : [...store.providers, p];
    selectedId.value = p.id;
    showDetailOnSmall.value = true;
    if (props.draft.chat.defaultProviderId === null) {
      props.draft.chat.defaultProviderId = p.id;
      props.draft.chat.defaultModel = null;
    }
    toast.add({ severity: 'success', summary: t('settings.providers.created'), life: 2500 });
  } catch (e) {
    fail(e);
  }
}

// ---------- Menu contextuel ----------
const menu = ref<InstanceType<typeof ContextMenu> | null>(null);
const menuItems = ref<MenuItem[]>([]);
function openMenu(e: MouseEvent, p: Provider) {
  menuItems.value = [
    { label: t('settings.providers.setDefault'), icon: 'pi pi-check-circle', command: () => setDefault(p) },
    { label: t('common.duplicate'), icon: 'pi pi-copy', command: () => duplicate(p) },
    { separator: true },
    { label: t('common.delete'), icon: 'pi pi-trash', command: () => remove(p) },
  ];
  menu.value?.show(e);
}

function setDefault(p: Provider) {
  props.draft.chat.defaultProviderId = p.id;
  props.draft.chat.defaultModel = p.models.find((m) => m.enabled)?.id ?? null;
}

async function duplicate(p: Provider) {
  try {
    const copy = await api.call('providers.duplicate', { id: p.id });
    guardSwitch(() => (selectedId.value = copy.id));
  } catch (e) {
    fail(e);
  }
}

function remove(p: Provider) {
  confirm.require({
    header: t('settings.providers.deleteTitle', { name: p.name }),
    message: t('settings.providers.deleteMessage'),
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: async () => {
      try {
        await api.call('providers.delete', { id: p.id });
        // Le brouillon des réglages ne doit pas réintroduire une connexion supprimée à l'enregistrement.
        if (props.draft.chat.defaultProviderId === p.id) {
          props.draft.chat.defaultProviderId = null;
          props.draft.chat.defaultModel = null;
        }
        if (selectedId.value === p.id) detailDirty.value = false;
        toast.add({ severity: 'success', summary: t('settings.providers.deleted'), life: 2500 });
      } catch (e) {
        fail(e);
      }
    },
  });
}
</script>

<template>
  <div class="providers" :class="{ 'show-detail': showDetailOnSmall && selected }">
    <aside class="list-pane">
      <div class="list-head">
        <IconField class="grow">
          <InputIcon class="pi pi-search" />
          <InputText v-model="query" size="small" :placeholder="t('settings.providers.search')" :aria-label="t('settings.providers.search')" fluid />
        </IconField>
        <Button icon="pi pi-plus" size="small" :aria-label="t('settings.providers.add')" v-tooltip.bottom="t('settings.providers.add')" @click="presetPicker = true" />
      </div>
      <ul class="list" role="listbox" :aria-label="t('settings.sections.providers')">
        <li
          v-for="p in filtered"
          :key="p.id"
          role="option"
          :aria-selected="p.id === selectedId"
          tabindex="0"
          class="item"
          :class="{ active: p.id === selectedId, off: !p.enabled }"
          @click="select(p.id)"
          @keydown.enter.prevent="select(p.id)"
          @contextmenu.prevent="openMenu($event, p)"
        >
          <ProviderLogo :preset="p.preset" :size="26" />
          <div class="item-text">
            <span class="item-name">{{ p.name }}</span>
            <span class="item-sub">{{ presetName(p.preset) }} · {{ t('settings.providers.modelCount', { count: p.models.filter((m) => m.enabled).length }) }}</span>
          </div>
          <Tag v-if="draft.chat.defaultProviderId === p.id" :value="t('settings.providers.isDefault')" severity="secondary" class="tag" />
          <i v-if="p.keyUnreadable" class="pi pi-exclamation-triangle warn" :aria-label="t('settings.providers.keyUnreadable')" />
        </li>
        <li v-if="filtered.length === 0" class="empty">
          <strong>{{ t('settings.providers.empty') }}</strong>
          <p class="mh-hint">{{ t('settings.providers.emptyHint') }}</p>
          <Button :label="t('settings.providers.add')" icon="pi pi-plus" size="small" @click="presetPicker = true" />
        </li>
      </ul>
      <p class="mh-hint immediate"><i class="pi pi-bolt" /> {{ t('settings.providers.immediateHint') }}</p>
    </aside>

    <section class="detail-pane">
      <button type="button" class="back" @click="guardSwitch(() => (showDetailOnSmall = false))"><i class="pi pi-arrow-left" /> {{ t('settings.providers.backToList') }}</button>
      <ProviderDetail v-if="selected" :key="selected.id" :provider="selected" :draft="draft" @update:dirty="(v: boolean) => (detailDirty = v)" @delete="remove(selected)" @duplicate="duplicate(selected)" />
      <div v-else class="none mh-muted">{{ t('settings.providers.emptyHint') }}</div>
    </section>

    <ContextMenu ref="menu" :model="menuItems" />

    <Dialog v-model:visible="presetPicker" modal :header="t('settings.providers.choosePreset')" :style="{ width: 'min(720px, 94vw)' }">
      <div class="presets">
        <button v-for="preset in store.presets" :key="preset.id" type="button" class="preset" :disabled="!preset.available" :aria-disabled="!preset.available" @click="addFromPreset(preset)">
          <ProviderLogo :preset="preset.id" :size="28" />
          <span class="preset-text">
            <span class="preset-name">{{ preset.name }}</span>
            <span v-if="preset.available" class="mh-hint">{{ preset.baseUrl || '—' }}</span>
            <span v-else class="mh-hint">{{ t('settings.providers.presetUnavailable') }} — {{ preset.unavailableReason }}</span>
          </span>
        </button>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.providers {
  display: flex;
  gap: 0;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  min-height: 520px;
  height: calc(100% - 40px);
  overflow: hidden;
  background: var(--mh-surface);
}
.list-pane {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--mh-border);
  background: var(--mh-bg);
  min-height: 0;
}
.list-head {
  display: flex;
  gap: 6px;
  padding: 10px;
}
.grow {
  flex: 1;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0 6px 6px;
  overflow-y: auto;
  flex: 1;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
}
.item:hover {
  background: var(--mh-hover);
}
.item.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
}
.item.off {
  opacity: 0.6;
}
.item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.item-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-sub {
  font-size: 11.5px;
  color: var(--mh-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  font-size: 10.5px;
}
.warn {
  color: var(--mh-warning);
}
.empty {
  padding: 16px 8px;
  text-align: center;
}
.immediate {
  padding: 8px 12px;
  border-top: 1px solid var(--mh-border);
  margin: 0;
}
.detail-pane {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.back {
  display: none;
}
.none {
  padding: 30px;
}
.presets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 8px;
}
.preset {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: var(--mh-surface);
  cursor: pointer;
  text-align: left;
}
.preset:hover:not(:disabled) {
  border-color: var(--mh-accent);
}
.preset:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.preset-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.preset-name {
  font-weight: 600;
}
@media (max-width: 900px) {
  .list-pane {
    width: 100%;
    border-right: 0;
  }
  .detail-pane {
    display: none;
  }
  .providers.show-detail .list-pane {
    display: none;
  }
  .providers.show-detail .detail-pane {
    display: flex;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    color: var(--mh-accent);
    padding: 10px 14px 0;
    cursor: pointer;
  }
}
</style>
