<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Popover from 'primevue/popover';
import Menu from 'primevue/menu';
import { useToast } from 'primevue/usetoast';
import type { Conversation, Id, ReasoningLevel } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';
import { providerById, store } from '../stores/app.ts';
import { uiState } from '../ui-state.ts';
import ProviderLogo from './ProviderLogo.vue';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();

/** Sélection effective : celle de la conversation, sinon le couple par défaut. */
const effectiveProviderId = computed(() => props.conversation.providerId ?? store.settings?.chat.defaultProviderId ?? null);
const effectiveModel = computed(() => (props.conversation.providerId !== null ? props.conversation.model : (store.settings?.chat.defaultModel ?? null)));
const provider = computed(() => providerById(effectiveProviderId.value));
const model = computed(() => provider.value?.models.find((m) => m.id === effectiveModel.value) ?? null);

async function update(patch: Parameters<typeof api.call<'conversations.update'>>[1]['patch']) {
  try {
    await api.call('conversations.update', { id: props.conversation.id, patch });
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 5000 });
  }
}

// ---------- Fournisseur / modèle : un seul sélecteur à deux colonnes ----------
const pop = ref<InstanceType<typeof Popover> | null>(null);
const browsing = ref<Id | null>(null);
const query = ref('');
const search = ref<HTMLInputElement | null>(null);
const providers = computed(() => store.providers.filter((p) => p.enabled || p.id === effectiveProviderId.value));
const shown = computed(() => providerById(browsing.value ?? effectiveProviderId.value));
const models = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (shown.value?.models ?? []).filter((m) => (m.enabled || m.id === effectiveModel.value) && (!q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)));
});
async function open(e: Event) {
  browsing.value = effectiveProviderId.value;
  query.value = '';
  pop.value?.toggle(e);
  await nextTick();
  search.value?.focus();
}
function pick(providerId: Id, modelId: string) {
  pop.value?.hide();
  const sameProvider = providerId === effectiveProviderId.value;
  void update({ providerId, model: modelId, ...(sameProvider ? {} : { reasoningLevel: 'auto' as const }) });
}
function manageModels() {
  pop.value?.hide();
  uiState.settingsProviderId = shown.value?.id ?? effectiveProviderId.value;
  uiState.settingsSection = 'providers';
  uiState.settingsOpen = true;
}
const label = computed(() => (provider.value ? `${provider.value.name} / ${model.value?.label ?? effectiveModel.value ?? t('chat.chooseModel')}` : t('chat.chooseProvider')));

// ---------- Réflexion ----------
const reasoningMenu = ref<InstanceType<typeof Menu> | null>(null);
/** Niveaux de réflexion : uniquement ceux déclarés pour le modèle ; Auto seul si inconnus. */
const levels = computed<ReasoningLevel[]>(() => {
  const caps = model.value?.capabilities;
  return ['auto', ...(caps?.reasoningLevels ?? []).filter((l) => !caps?.rejectedLevels.includes(l))];
});
const reasoningUnknown = computed(() => levels.value.length === 1 && props.conversation.reasoningLevel === 'auto');
const reasoningItems = computed(() => levels.value.map((l) => ({ key: l, label: t(`reasoningLevels.${l}`), command: () => update({ reasoningLevel: l }) })));
</script>

<template>
  <div class="picker">
    <button type="button" class="ghost model-btn" :aria-label="`${t('chat.provider')} / ${t('chat.model')} : ${label}`" aria-haspopup="dialog" @click="open">
      <ProviderLogo v-if="provider" :preset="provider.preset" :size="15" />
      <span class="label">{{ label }}</span>
      <i class="pi pi-angle-down caret" />
    </button>
    <button
      type="button"
      class="ghost"
      :class="{ off: reasoningUnknown }"
      :aria-label="`${t('chat.reasoning')} : ${t(`reasoningLevels.${conversation.reasoningLevel}`)}`"
      aria-haspopup="menu"
      v-tooltip.top="reasoningUnknown ? t('chat.reasoningOnlyAuto') : `${t('chat.reasoning')} (Ctrl+Maj+R)`"
      @click="!reasoningUnknown && reasoningMenu?.toggle($event)"
    >
      <i class="pi pi-sparkles" />
      <span>{{ t(`reasoningLevels.${conversation.reasoningLevel}`) }}</span>
      <i v-if="!reasoningUnknown" class="pi pi-angle-down caret" />
    </button>
    <Menu ref="reasoningMenu" :model="reasoningItems" popup>
      <template #item="{ item, props: p }">
        <a v-bind="p.action" class="lvl" :class="{ active: item.key === conversation.reasoningLevel }">
          <span>{{ item.label }}</span>
          <i v-if="item.key === conversation.reasoningLevel" class="pi pi-check" />
        </a>
      </template>
    </Menu>

    <Popover ref="pop">
      <div class="pm" role="dialog" :aria-label="`${t('chat.provider')} / ${t('chat.model')}`">
        <ul class="col providers" role="listbox" :aria-label="t('chat.provider')">
          <li v-for="p in providers" :key="p.id">
            <button type="button" class="row" :class="{ active: p.id === shown?.id }" :aria-selected="p.id === shown?.id" role="option" @click="(browsing = p.id), (query = '')">
              <ProviderLogo :preset="p.preset" :size="16" />
              <span class="name">{{ p.name }}</span>
              <i v-if="p.id === effectiveProviderId" class="pi pi-check dot" />
            </button>
          </li>
          <li v-if="!providers.length" class="mh-hint pad">{{ t('chat.chooseProvider') }}</li>
        </ul>
        <div class="col models">
          <input ref="search" v-model="query" class="filter" :placeholder="t('common.search')" :aria-label="t('common.search')" />
          <ul role="listbox" :aria-label="t('chat.model')">
            <li v-for="m in models" :key="m.id">
              <button type="button" class="row" :class="{ active: shown?.id === effectiveProviderId && m.id === effectiveModel }" role="option" :aria-selected="shown?.id === effectiveProviderId && m.id === effectiveModel" @click="pick(shown!.id, m.id)">
                <span class="name">{{ m.label }}</span>
                <span v-if="m.capabilities.reasoningLevels.length" class="pi pi-sparkles tag" :title="t('chat.reasoning')" />
                <span v-if="m.capabilities.vision" class="pi pi-image tag" :title="t('settings.providers.vision')" />
              </button>
            </li>
            <li v-if="!models.length" class="mh-hint pad">{{ t('chat.noModels') }}</li>
          </ul>
          <button type="button" class="manage" @click="manageModels"><i class="pi pi-sliders-h" /> {{ t('chat.manageModels') }}</button>
        </div>
      </div>
    </Popover>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.ghost {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: var(--mh-text);
  font: inherit;
  font-size: 13.5px;
  padding: 6px 9px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  min-width: 0;
  transition: background var(--mh-transition);
}
.ghost:hover {
  background: var(--mh-hover);
}
.ghost.off {
  cursor: default;
  color: var(--mh-muted);
}
.ghost.off:hover {
  background: transparent;
}
.ghost .pi {
  color: var(--mh-muted);
}
.model-btn {
  max-width: 340px;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.caret {
  font-size: 11px;
}
.lvl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 7px 12px;
  min-width: 140px;
}
.lvl.active {
  color: var(--mh-accent);
}
.pm {
  display: flex;
  width: min(560px, 86vw);
  height: min(360px, 60vh);
}
.col {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow: auto;
}
.providers {
  width: 42%;
  border-right: 1px solid var(--mh-border);
}
.models {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 4px 4px 0;
}
.models ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
}
.filter {
  margin: 2px 2px 6px;
  padding: 6px 10px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  background: var(--mh-bg);
  color: var(--mh-text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.filter:focus {
  border-color: var(--mh-accent);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--mh-text);
  font: inherit;
  font-size: 13px;
  padding: 7px 9px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  text-align: left;
}
.row:hover {
  background: var(--mh-hover);
}
.row.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  color: var(--mh-accent);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  font-size: 11px;
  color: var(--mh-accent);
}
.tag {
  font-size: 11px;
  color: var(--mh-muted);
}
.pad {
  padding: 10px;
}
.manage {
  border: 0;
  border-top: 1px solid var(--mh-border);
  background: transparent;
  padding: 9px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--mh-accent);
  font: inherit;
  font-size: 13px;
}
.manage:hover {
  background: var(--mh-hover);
}
</style>
