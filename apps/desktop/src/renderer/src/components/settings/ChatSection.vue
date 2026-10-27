<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Textarea from 'primevue/textarea';
import InputNumber from 'primevue/inputnumber';
import RadioButton from 'primevue/radiobutton';
import Slider from 'primevue/slider';
import type { ResponseStyle, Settings } from '@monolith/contracts';
import { store } from '../../stores/app.ts';

const props = defineProps<{ draft: Settings }>();
const { t } = useI18n();

const styles: ResponseStyle[] = ['default', 'short', 'pragmatic', 'detailed', 'playful'];
const displays = ['none', 'collapsed', 'expanded'] as const;

const providerOptions = computed(() => store.providers.map((p) => ({ label: p.name, value: p.id })));
const namingModelOptions = computed(() => {
  const p = store.providers.find((x) => x.id === props.draft.chat.namingProviderId);
  return (p?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id }));
});
function setNamingProvider(id: number | null) {
  props.draft.chat.namingProviderId = id;
  const p = store.providers.find((x) => x.id === id);
  props.draft.chat.namingModel = p?.models.find((m) => m.enabled)?.id ?? null;
}
const modelOptions = computed(() => {
  const p = store.providers.find((x) => x.id === props.draft.chat.defaultProviderId);
  return (p?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id }));
});
function setProvider(id: number | null) {
  props.draft.chat.defaultProviderId = id;
  const p = store.providers.find((x) => x.id === id);
  props.draft.chat.defaultModel = p?.models.find((m) => m.enabled)?.id ?? null;
}
</script>

<template>
  <div class="mh-field">
    <span class="mh-label">{{ t('settings.chat.defaultModel') }}</span>
    <div class="mh-row wrap">
      <Select :model-value="draft.chat.defaultProviderId" :options="providerOptions" option-label="label" option-value="value" show-clear :placeholder="t('chat.chooseProvider')" :aria-label="t('chat.provider')" class="sel" @update:model-value="setProvider" />
      <Select v-model="draft.chat.defaultModel" :options="modelOptions" option-label="label" option-value="value" filter :placeholder="t('chat.chooseModel')" :aria-label="t('chat.model')" :disabled="!draft.chat.defaultProviderId" class="sel" />
    </div>
  </div>

  <div class="mh-field">
    <label for="style">{{ t('settings.chat.responseStyle') }}</label>
    <Select input-id="style" v-model="draft.chat.responseStyle" :options="styles" :option-label="(s: ResponseStyle) => t(`settings.chat.styles.${s}`)" class="sel" />
  </div>

  <fieldset class="mh-field plain">
    <legend class="mh-label">{{ t('settings.chat.reasoningDisplay') }}</legend>
    <div v-for="d in displays" :key="d" class="radio">
      <RadioButton v-model="draft.chat.reasoningDisplay" :input-id="`rd-${d}`" :value="d" />
      <label :for="`rd-${d}`">{{ t(`settings.chat.reasoningDisplays.${d}`) }}</label>
    </div>
    <p class="mh-hint">{{ t('settings.chat.reasoningDisplayHint') }}</p>
  </fieldset>

  <div class="mh-switch-row">
    <label for="tps">{{ t('settings.chat.showThroughput') }}</label>
    <ToggleSwitch input-id="tps" v-model="draft.chat.showThroughput" />
  </div>
  <div class="mh-switch-row">
    <label for="ctxu">{{ t('settings.chat.showContextUsage') }}</label>
    <ToggleSwitch input-id="ctxu" v-model="draft.chat.showContextUsage" />
  </div>
  <div class="mh-switch-row">
    <label for="lines">{{ t('settings.chat.codeLineNumbers') }}</label>
    <ToggleSwitch input-id="lines" v-model="draft.chat.codeLineNumbers" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.chat.naming') }}</h3>
  <div class="mh-switch-row">
    <div>
      <label for="naming">{{ t('settings.chat.autoNaming') }}</label>
      <p class="mh-hint">{{ t('settings.chat.autoNamingHint') }}</p>
    </div>
    <ToggleSwitch input-id="naming" v-model="draft.chat.autoNaming" />
  </div>
  <div v-if="draft.chat.autoNaming" class="mh-field top-gap">
    <span class="mh-label">{{ t('settings.chat.namingModel') }}</span>
    <div class="mh-row wrap">
      <Select :model-value="draft.chat.namingProviderId" :options="providerOptions" option-label="label" option-value="value" show-clear :placeholder="t('settings.chat.namingSame')" :aria-label="t('chat.provider')" class="sel" @update:model-value="setNamingProvider" />
      <Select v-model="draft.chat.namingModel" :options="namingModelOptions" option-label="label" option-value="value" filter :placeholder="t('chat.chooseModel')" :aria-label="t('chat.model')" :disabled="!draft.chat.namingProviderId" class="sel" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.chat.compaction') }}</h3>
  <div class="mh-switch-row">
    <div>
      <label for="autocompact">{{ t('settings.chat.autoCompact') }}</label>
      <p class="mh-hint">{{ t('settings.chat.autoCompactHint') }}</p>
    </div>
    <ToggleSwitch input-id="autocompact" v-model="draft.chat.autoCompact" />
  </div>
  <div class="mh-row wrap top-gap">
    <div class="mh-field grow">
      <label id="lbl-thr">{{ t('settings.chat.compactThreshold', { value: draft.chat.compactThreshold }) }}</label>
      <Slider v-model="draft.chat.compactThreshold" :min="40" :max="95" :step="5" aria-labelledby="lbl-thr" :disabled="!draft.chat.autoCompact" />
    </div>
    <div class="mh-field">
      <label for="keep">{{ t('settings.chat.compactKeepTurns') }}</label>
      <InputNumber input-id="keep" v-model="draft.chat.compactKeepTurns" :min="1" :max="20" show-buttons :allow-empty="false" />
    </div>
  </div>

  <div class="mh-field top-gap">
    <label for="instr">{{ t('settings.chat.customInstructions') }}</label>
    <Textarea id="instr" v-model="draft.chat.customInstructions" rows="5" auto-resize fluid />
    <p class="mh-hint">{{ t('settings.chat.customInstructionsHint') }}</p>
  </div>

  <h3 class="mh-section-title">{{ t('settings.chat.retry') }}</h3>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="attempts">{{ t('settings.chat.retryAttempts') }}</label>
      <InputNumber input-id="attempts" v-model="draft.network.retryMaxAttempts" :min="1" :max="8" show-buttons :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="delay">{{ t('settings.chat.retryDelay') }}</label>
      <InputNumber input-id="delay" v-model="draft.network.retryBaseDelayMs" :min="100" :max="10000" :step="100" show-buttons :allow-empty="false" />
    </div>
  </div>
  <p class="mh-hint">{{ t('settings.chat.retryHint') }}</p>
  <div class="mh-switch-row">
    <div>
      <label for="trunc">{{ t('settings.chat.retryTruncated') }}</label>
      <p class="mh-hint">{{ t('settings.chat.retryTruncatedHint') }}</p>
    </div>
    <ToggleSwitch input-id="trunc" v-model="draft.network.retryTruncatedJson400" />
  </div>
</template>

<style scoped>
.sel {
  min-width: 220px;
  max-width: 340px;
}
.wrap {
  flex-wrap: wrap;
  align-items: flex-start;
}
.plain {
  border: 0;
  padding: 0;
  margin: 0 0 18px;
}
.radio {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.top-gap {
  margin-top: 18px;
}
.grow {
  flex: 1;
  min-width: 220px;
}
</style>
