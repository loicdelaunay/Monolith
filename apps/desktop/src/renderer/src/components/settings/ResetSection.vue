<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { Settings } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';

const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();

const SECTIONS: { id: keyof Settings; label: string }[] = [
  { id: 'general', label: 'settings.sections.general' },
  { id: 'chat', label: 'settings.sections.chat' },
  { id: 'appearance', label: 'settings.sections.appearance' },
  { id: 'network', label: 'settings.chat.retry' },
  { id: 'layout', label: 'settings.reset.layout' },
];

function reset(section?: keyof Settings, label?: string) {
  confirm.require({
    header: t('settings.reset.confirmTitle'),
    message: section ? t('settings.reset.confirmSection', { section: label ?? section }) : t('settings.reset.confirmAll'),
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.reset'), severity: 'danger' },
    accept: async () => {
      try {
        await api.call('settings.reset', section ? { section } : {});
        toast.add({ severity: 'success', summary: t('settings.reset.done'), life: 2500 });
      } catch (e) {
        toast.add({ severity: 'error', summary: t('errors.internal'), detail: errorMessage(e), life: 6000 });
      }
    },
  });
}
</script>

<template>
  <p class="mh-hint">{{ t('settings.reset.hint') }}</p>
  <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
  <h3 class="mh-section-title">{{ t('settings.reset.section') }}</h3>
  <div class="list">
    <div v-for="s in SECTIONS" :key="s.id" class="mh-switch-row">
      <span>{{ t(s.label) }}</span>
      <Button :label="t('common.reset')" size="small" severity="secondary" outlined @click="reset(s.id, t(s.label))" />
    </div>
  </div>
  <h3 class="mh-section-title">{{ t('settings.reset.all') }}</h3>
  <Button :label="t('settings.reset.all')" icon="pi pi-refresh" severity="danger" outlined @click="reset()" />
</template>

<style scoped>
.list {
  max-width: 560px;
}
</style>
