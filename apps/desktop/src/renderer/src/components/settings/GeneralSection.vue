<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { Settings } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { store } from '../../stores/app.ts';

defineProps<{ draft: Settings }>();
const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();

const languages = [
  { value: 'system', label: () => t('settings.general.languageSystem') },
  { value: 'fr', label: () => 'Français' },
  { value: 'en', label: () => 'English' },
];

async function changeLocation(dir: string | null) {
  try {
    const r = await api.call('app.setDataLocation', { dir });
    confirm.require({
      header: t('settings.appearance.restartRequired'),
      message: `${t('settings.general.locationSaved')}\n${r.file}`,
      rejectProps: { label: t('common.close'), severity: 'secondary', outlined: true },
      acceptProps: { label: t('settings.appearance.restartNow') },
      accept: () => void host.relaunch(),
    });
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 6000 });
  }
}

async function pickLocation() {
  const dir = await host.pickDirectory(t('settings.general.chooseLocation'));
  if (dir) await changeLocation(dir);
}
</script>

<template>
  <div class="mh-field">
    <label for="lang">{{ t('settings.general.language') }}</label>
    <Select input-id="lang" v-model="draft.general.language" :options="languages" option-value="value" :option-label="(o: (typeof languages)[number]) => o.label()" class="w-sel" />
  </div>

  <div class="mh-switch-row">
    <label for="confirm-delete">{{ t('settings.general.confirmDelete') }}</label>
    <ToggleSwitch input-id="confirm-delete" v-model="draft.general.confirmDelete" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.general.dataLocation') }}</h3>
  <div v-if="store.info" class="mh-card">
    <div class="mh-row between wrap">
      <code class="path">{{ store.info.dataDir }}</code>
      <Button :label="t('settings.general.showFolder')" icon="pi pi-folder-open" size="small" severity="secondary" outlined @click="host.showItemInFolder(store.info.databasePath)" />
    </div>
    <p class="mh-hint">{{ t(`settings.general.dataSource.${store.info.dataDirSource}`) }}</p>
    <div class="mh-row wrap actions">
      <Button :label="t('settings.general.chooseLocation')" icon="pi pi-folder" size="small" severity="secondary" outlined @click="pickLocation" />
      <Button v-if="store.info.dataDirSource === 'location-file'" :label="t('settings.general.defaultLocation')" icon="pi pi-undo" size="small" severity="secondary" text @click="changeLocation(null)" />
      <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
    </div>
    <p class="mh-hint">{{ t('settings.general.locationHint') }}</p>
  </div>

  <h3 class="mh-section-title">{{ t('settings.general.secrets') }}</h3>
  <div v-if="store.info" class="mh-card">
    <div class="mh-row">
      <Tag :severity="store.info.secretProtection.systemBacked && store.info.secretProtection.available ? 'success' : 'warn'" :value="store.info.secretProtection.mechanism.toUpperCase()" />
      <span>{{ store.info.secretProtection.message }}</span>
    </div>
  </div>
</template>

<style scoped>
.w-sel {
  max-width: 320px;
}
.path {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.wrap {
  flex-wrap: wrap;
}
.actions {
  margin-top: 10px;
}
</style>
