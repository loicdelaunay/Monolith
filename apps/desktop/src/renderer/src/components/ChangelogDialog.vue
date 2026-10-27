<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import { api } from '../api.ts';
import { uiState } from '../ui-state.ts';
import MarkdownView from './MarkdownView.vue';

const { t } = useI18n();
const text = ref('');

watch(
  () => uiState.changelogOpen,
  async (open) => {
    if (open && !text.value) text.value = await api.call('app.changelog');
  },
);
</script>

<template>
  <Dialog v-model:visible="uiState.changelogOpen" modal :header="t('settings.about.changelog')" :style="{ width: 'min(760px, 94vw)' }" :content-style="{ maxHeight: '70vh' }">
    <MarkdownView :text="text" />
  </Dialog>
</template>
