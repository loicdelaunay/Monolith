<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import Slider from 'primevue/slider';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import type { Settings, SubagentPreset } from '@monolith/contracts';
import { store } from '../../stores/app.ts';

const props = defineProps<{ draft: Settings }>();
const { t } = useI18n();

const modeOptions = computed(() => (['auto', 'forced', 'off'] as const).map((v) => ({ value: v, label: t(`settings.subagentsSettings.modes.${v}`) })));
const agentModes = computed(() => (['plan', 'propose', 'execute'] as const).map((v) => ({ value: v, label: t(`modes.${v}`) })));
const providerOptions = computed(() => [{ label: '—', value: null }, ...store.providers.map((p) => ({ label: p.name, value: p.id }))]);
const modelOptions = (p: SubagentPreset) => (store.providers.find((x) => x.id === p.providerId)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id }));
function addPreset() {
  const n = props.draft.subagents.presets.length + 1;
  props.draft.subagents.presets.push({ id: `role-${n}`, name: `Rôle ${n}`, description: '', instructions: '', agentMode: 'plan', providerId: null, model: null });
}
function setProvider(p: SubagentPreset, id: number | null) {
  p.providerId = id;
  p.model = store.providers.find((x) => x.id === id)?.models.find((m) => m.enabled)?.id ?? null;
}
</script>

<template>
  <p class="mh-hint">{{ t('agentsSettings.hint') }}</p>
  <div class="grid">
    <div class="mh-field">
      <label for="ag-rounds">{{ t('agentsSettings.maxToolRounds') }}</label>
      <InputNumber input-id="ag-rounds" v-model="draft.agent.maxToolRounds" :min="1" :max="200" show-buttons :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="ag-timeout">{{ t('agentsSettings.commandTimeout') }}</label>
      <InputNumber input-id="ag-timeout" v-model="draft.agent.commandTimeoutSec" :min="5" :max="3600" show-buttons :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="ag-result">{{ t('agentsSettings.maxResultChars') }}</label>
      <InputNumber input-id="ag-result" v-model="draft.agent.maxResultChars" :min="2000" :max="200000" :step="1000" show-buttons :allow-empty="false" />
    </div>
  </div>
  <div class="mh-switch-row">
    <div>
      <label for="ag-instr">{{ t('agentsSettings.instructionFiles') }}</label>
      <p class="mh-hint">{{ t('agentsSettings.instructionFilesHint') }}</p>
    </div>
    <ToggleSwitch input-id="ag-instr" v-model="draft.agent.readInstructionFiles" />
  </div>

  <h3 class="mh-section-title">{{ t('subagents.title') }}</h3>
  <div class="mh-field">
    <label for="sa-mode">{{ t('settings.subagentsSettings.mode') }}</label>
    <Select input-id="sa-mode" v-model="draft.subagents.mode" :options="modeOptions" option-label="label" option-value="value" class="sel" />
  </div>
  <template v-if="draft.subagents.mode !== 'off'">
    <div class="grid">
      <div class="mh-field">
        <label id="sa-depth">{{ t('settings.subagentsSettings.maxDepth', { value: draft.subagents.maxDepth }) }}</label>
        <Slider v-model="draft.subagents.maxDepth" :min="1" :max="3" aria-labelledby="sa-depth" />
      </div>
      <div class="mh-field">
        <label id="sa-par">{{ t('settings.subagentsSettings.maxParallel', { value: draft.subagents.maxParallel }) }}</label>
        <Slider v-model="draft.subagents.maxParallel" :min="1" :max="8" aria-labelledby="sa-par" />
      </div>
    </div>
    <div class="grid">
      <div class="mh-field">
        <label for="sa-rounds">{{ t('settings.subagentsSettings.maxRounds') }}</label>
        <InputNumber input-id="sa-rounds" v-model="draft.subagents.maxRounds" :min="1" :max="200" show-buttons :allow-empty="false" />
      </div>
      <div class="mh-field">
        <label for="sa-tokens">{{ t('settings.subagentsSettings.maxOutputTokens') }}</label>
        <InputNumber input-id="sa-tokens" v-model="draft.subagents.maxOutputTokens" :min="1000" :max="1000000" :step="1000" :allow-empty="false" />
      </div>
      <div class="mh-field">
        <label for="sa-time">{{ t('settings.subagentsSettings.timeoutSec') }}</label>
        <InputNumber input-id="sa-time" v-model="draft.subagents.timeoutSec" :min="30" :max="7200" :step="30" :allow-empty="false" />
      </div>
    </div>
    <p class="mh-hint">{{ t('settings.subagentsSettings.budgetHint') }}</p>

    <h3 class="mh-section-title">{{ t('settings.subagentsSettings.presets') }}</h3>
    <p class="mh-hint">{{ t('settings.subagentsSettings.presetsHint') }}</p>
    <div v-for="(p, i) in draft.subagents.presets" :key="i" class="preset">
      <div class="mh-row wrap">
        <InputText v-model="p.name" :aria-label="t('settings.subagentsSettings.presetName')" :placeholder="t('settings.subagentsSettings.presetName')" maxlength="60" class="name" />
        <InputText v-model="p.id" :aria-label="t('settings.subagentsSettings.presetId')" :placeholder="t('settings.subagentsSettings.presetId')" maxlength="40" class="id" />
        <Select v-model="p.agentMode" :options="agentModes" option-label="label" option-value="value" :aria-label="t('settings.subagentsSettings.presetMode')" />
        <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('settings.subagentsSettings.remove')" @click="draft.subagents.presets.splice(i, 1)" />
      </div>
      <InputText v-model="p.description" :placeholder="t('settings.subagentsSettings.presetDesc')" :aria-label="t('settings.subagentsSettings.presetDesc')" fluid />
      <Textarea v-model="p.instructions" rows="2" auto-resize :placeholder="t('settings.subagentsSettings.presetInstructions')" :aria-label="t('settings.subagentsSettings.presetInstructions')" fluid />
      <div class="mh-row wrap">
        <Select :model-value="p.providerId" :options="providerOptions" option-label="label" option-value="value" :placeholder="t('settings.subagentsSettings.presetModel')" :aria-label="t('settings.subagentsSettings.presetModel')" class="sel" @update:model-value="(v: number | null) => setProvider(p, v)" />
        <Select v-if="p.providerId !== null" v-model="p.model" :options="modelOptions(p)" option-label="label" option-value="value" filter class="sel" />
      </div>
    </div>
    <Button :label="t('settings.subagentsSettings.addPreset')" icon="pi pi-plus" size="small" severity="secondary" outlined @click="addPreset" />
  </template>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0 18px;
}
.sel {
  min-width: 220px;
}
.preset {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 10px 12px;
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.name {
  flex: 1;
  min-width: 160px;
}
.id {
  width: 140px;
}
</style>
