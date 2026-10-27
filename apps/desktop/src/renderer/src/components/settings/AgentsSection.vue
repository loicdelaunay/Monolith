<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import InputNumber from 'primevue/inputnumber';
import ToggleSwitch from 'primevue/toggleswitch';
import type { Settings } from '@monolith/contracts';

defineProps<{ draft: Settings }>();
const { t } = useI18n();
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
  <div class="mh-card note">
    <i class="pi pi-hourglass" />
    <p class="mh-hint">{{ t('agentsSettings.subagentsPlanned') }}</p>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0 18px;
}
.note {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-top: 16px;
}
.note p {
  margin: 0;
}
</style>
