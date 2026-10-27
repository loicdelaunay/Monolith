<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import type { Settings } from '@monolith/contracts';
import { host } from '../../api.ts';
import { playChime } from '../../lib/chime.ts';

const props = defineProps<{ draft: Settings }>();
const { t } = useI18n();
const ROWS = ['system', 'sound', 'onGeneration', 'onScheduled', 'onError'] as const;
async function test() {
  if (props.draft.notifications.sound) playChime('success');
  if (props.draft.notifications.system) await host.notify(t('notifications.title'), t('settings.notificationsSettings.testBody'), true);
}
</script>

<template>
  <div v-for="k in ROWS" :key="k" class="mh-switch-row">
    <div>
      <label :for="`nt-${k}`">{{ t(`settings.notificationsSettings.${k}`) }}</label>
      <p v-if="k === 'system'" class="mh-hint">{{ t('settings.notificationsSettings.systemHint') }}</p>
    </div>
    <ToggleSwitch :input-id="`nt-${k}`" v-model="draft.notifications[k]" />
  </div>
  <Button :label="t('settings.notificationsSettings.test')" icon="pi pi-bell" size="small" severity="secondary" outlined @click="test" />
</template>
