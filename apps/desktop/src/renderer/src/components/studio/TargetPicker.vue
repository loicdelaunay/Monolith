<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import type { Id } from '@monolith/contracts';
import { store } from '../../stores/app.ts';

/** Connexion + modèle (null : modèle par défaut indiqué par `emptyLabel`). */
const props = defineProps<{ providerId: Id | null; model: string | null; emptyLabel?: string; filter?: (kind: string) => boolean }>();
const emit = defineEmits<{ change: [value: { providerId: Id | null; model: string | null }] }>();
const { t } = useI18n();

const providers = computed(() => [{ label: props.emptyLabel ?? t('studio.defaultModel'), value: null as Id | null }, ...store.providers.filter((p) => p.enabled && (!props.filter || props.filter(p.kind))).map((p) => ({ label: p.name, value: p.id as Id | null }))]);
const models = computed(() => (store.providers.find((p) => p.id === props.providerId)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id })));
function setProvider(id: Id | null) {
  const first = store.providers.find((p) => p.id === id)?.models.find((m) => m.enabled)?.id ?? null;
  emit('change', { providerId: id, model: id === null ? null : first });
}
</script>

<template>
  <div class="tp">
    <Select :model-value="providerId" :options="providers" option-label="label" option-value="value" size="small" :aria-label="t('studio.provider')" class="sel" @update:model-value="setProvider" />
    <Select v-if="providerId !== null" :model-value="model" :options="models" option-label="label" option-value="value" filter size="small" :aria-label="t('studio.model')" class="sel" @update:model-value="(m: string) => emit('change', { providerId, model: m })" />
  </div>
</template>

<style scoped>
.tp {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sel {
  min-width: 170px;
  max-width: 260px;
}
</style>
