<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import { useToast } from 'primevue/usetoast';
import type { Conversation, ReasoningLevel } from '@monolith/contracts';
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

const providerOptions = computed(() => store.providers.filter((p) => p.enabled || p.id === effectiveProviderId.value).map((p) => ({ label: p.name, value: p.id, preset: p.preset })));
const modelOptions = computed(() => {
  const list = (provider.value?.models ?? []).filter((m) => m.enabled || m.id === effectiveModel.value).map((m) => ({ label: m.label, value: m.id }));
  if (effectiveModel.value && !list.some((m) => m.value === effectiveModel.value)) list.unshift({ label: effectiveModel.value, value: effectiveModel.value });
  return list;
});

const model = computed(() => provider.value?.models.find((m) => m.id === effectiveModel.value) ?? null);
/** Niveaux de réflexion : uniquement ceux déclarés pour le modèle ; Auto seul si inconnus. */
const reasoningOptions = computed(() => {
  const caps = model.value?.capabilities;
  const levels: ReasoningLevel[] = ['auto', ...(caps?.reasoningLevels ?? []).filter((l) => !caps?.rejectedLevels.includes(l))];
  return levels.map((l) => ({ label: t(`reasoningLevels.${l}`), value: l }));
});
/** Mode de la conversation : Chat ou Agent (Plan, Proposition, Exécution), appliqué par le moteur. */
const modeOptions = computed(() => [
  { value: 'chat', label: t('modes.chat'), icon: 'pi-comments' },
  { value: 'agent:plan', label: t('modes.plan'), icon: 'pi-search' },
  { value: 'agent:propose', label: t('modes.propose'), icon: 'pi-file-edit' },
  { value: 'agent:execute', label: t('modes.execute'), icon: 'pi-play' },
]);
const modeValue = computed(() => (props.conversation.mode === 'chat' ? 'chat' : `agent:${props.conversation.agentMode}`));
function selectMode(v: string) {
  if (v === 'chat') void update({ mode: 'chat' });
  else void update({ mode: 'agent', agentMode: v.split(':')[1] as 'plan' | 'propose' | 'execute' });
}

const reasoningUnknown = computed(() => reasoningOptions.value.length === 1 && props.conversation.reasoningLevel === 'auto');

async function update(patch: Parameters<typeof api.call<'conversations.update'>>[1]['patch']) {
  try {
    await api.call('conversations.update', { id: props.conversation.id, patch });
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 5000 });
  }
}

function selectProvider(id: number) {
  const p = providerById(id);
  const keep = p?.models.some((m) => m.id === effectiveModel.value && m.enabled);
  const first = p?.models.find((m) => m.enabled)?.id ?? null;
  void update({ providerId: id, model: keep ? effectiveModel.value : first, reasoningLevel: 'auto' });
}

function selectModel(id: string) {
  void update({ providerId: effectiveProviderId.value, model: id });
}

function manageModels() {
  uiState.settingsProviderId = effectiveProviderId.value;
  uiState.settingsSection = 'providers';
  uiState.settingsOpen = true;
}
</script>

<template>
  <div class="picker">
    <Select :model-value="modeValue" :options="modeOptions" option-label="label" option-value="value" :aria-label="t('modes.label')" size="small" class="mode" @update:model-value="selectMode">
      <template #value="{ value }">
        <span class="opt"><i class="pi" :class="modeOptions.find((o) => o.value === value)?.icon" />{{ modeOptions.find((o) => o.value === value)?.label }}</span>
      </template>
      <template #option="{ option }">
        <span class="opt-col">
          <span class="opt"><i class="pi" :class="option.icon" />{{ option.label }}</span>
          <span class="mh-hint">{{ t(`modes.hint.${option.value.replace('agent:', '')}`) }}</span>
        </span>
      </template>
    </Select>
    <Select
      :model-value="effectiveProviderId"
      :options="providerOptions"
      option-label="label"
      option-value="value"
      filter
      :filter-placeholder="t('common.search')"
      :placeholder="t('chat.chooseProvider')"
      :aria-label="t('chat.provider')"
      size="small"
      class="provider"
      @update:model-value="selectProvider"
    >
      <template #value="{ value, placeholder }">
        <span v-if="value !== null && providerById(value)" class="opt">
          <ProviderLogo :preset="providerById(value)!.preset" :size="16" />
          {{ providerById(value)!.name }}
        </span>
        <span v-else>{{ placeholder }}</span>
      </template>
      <template #option="{ option }">
        <span class="opt"><ProviderLogo :preset="option.preset" :size="16" />{{ option.label }}</span>
      </template>
    </Select>
    <Select
      :model-value="effectiveModel"
      :options="modelOptions"
      option-label="label"
      option-value="value"
      filter
      :filter-placeholder="t('common.search')"
      :placeholder="t('chat.chooseModel')"
      :empty-message="t('chat.noModels')"
      :aria-label="t('chat.model')"
      :disabled="!provider"
      size="small"
      class="model"
      @update:model-value="selectModel"
    >
      <template #footer>
        <button type="button" class="manage" @click="manageModels"><i class="pi pi-sliders-h" /> {{ t('chat.manageModels') }}</button>
      </template>
    </Select>
    <span v-tooltip.top="reasoningUnknown ? t('chat.reasoningOnlyAuto') : undefined" class="reasoning-wrap">
      <Select
        :model-value="conversation.reasoningLevel"
        :options="reasoningOptions"
        option-label="label"
        option-value="value"
        :aria-label="t('chat.reasoning')"
        :disabled="reasoningUnknown"
        size="small"
        class="reasoning"
        @update:model-value="(v: ReasoningLevel) => update({ reasoningLevel: v })"
      >
        <template #value="{ value }">
          <span class="opt"><i class="pi pi-sparkles" />{{ t(`reasoningLevels.${value ?? 'auto'}`) }}</span>
        </template>
      </Select>
    </span>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
.provider {
  max-width: 200px;
}
.mode {
  max-width: 190px;
}
.opt-col {
  display: flex;
  flex-direction: column;
  max-width: 300px;
  white-space: normal;
}
.model {
  max-width: 260px;
  min-width: 120px;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.manage {
  width: 100%;
  border: 0;
  border-top: 1px solid var(--mh-border);
  background: transparent;
  padding: 8px 12px;
  text-align: left;
  cursor: pointer;
  color: var(--mh-accent);
}
.manage:hover {
  background: var(--mh-hover);
}
.reasoning-wrap {
  display: inline-flex;
}
</style>
