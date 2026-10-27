<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{ tranche: string }>();
const { t } = useI18n();
</script>

<template>
  <div class="mh-card planned" role="note">
    <i class="pi pi-hourglass" />
    <div>
      <strong>{{ t('settings.planned', { tranche }) }}</strong>
      <p class="mh-hint">{{ t('settings.plannedHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.planned {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  max-width: 640px;
}
.planned > .pi {
  font-size: 20px;
  color: var(--mh-muted);
  margin-top: 2px;
}
</style>
