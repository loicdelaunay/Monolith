<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import ToggleSwitch from 'primevue/toggleswitch';
import InputNumber from 'primevue/inputnumber';
import SelectButton from 'primevue/selectbutton';
import type { Settings } from '@monolith/contracts';

defineProps<{ draft: Settings }>();
const { t } = useI18n();
</script>

<template>
  <p class="mh-hint">{{ t('loopSettings.hint') }}</p>
  <div class="mh-switch-row">
    <label for="loop-on">{{ t('loopSettings.enabled') }}</label>
    <ToggleSwitch input-id="loop-on" v-model="draft.loop.enabled" />
  </div>
  <div class="grid">
    <div class="mh-field">
      <label for="loop-thr">{{ t('loopSettings.threshold') }}</label>
      <InputNumber input-id="loop-thr" v-model="draft.loop.threshold" :min="2" :max="20" show-buttons :allow-empty="false" :disabled="!draft.loop.enabled" />
    </div>
    <div class="mh-field">
      <label for="loop-win">{{ t('loopSettings.window') }}</label>
      <InputNumber input-id="loop-win" v-model="draft.loop.window" :min="3" :max="100" show-buttons :allow-empty="false" :disabled="!draft.loop.enabled" />
    </div>
  </div>
  <div class="mh-field">
    <span class="mh-label">{{ t('loopSettings.match') }}</span>
    <SelectButton v-model="draft.loop.match" :options="['exact', 'equivalent']" :option-label="(m: string) => t(`loopSettings.matches.${m}`)" :allow-empty="false" :disabled="!draft.loop.enabled" :aria-label="t('loopSettings.match')" />
    <p class="mh-hint">{{ t('loopSettings.matchHint') }}</p>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0 18px;
  margin-top: 12px;
}
</style>
