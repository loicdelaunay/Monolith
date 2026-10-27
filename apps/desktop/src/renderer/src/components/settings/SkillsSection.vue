<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from 'primevue/toggleswitch';
import Checkbox from 'primevue/checkbox';
import type { Settings, SkillInfo } from '@monolith/contracts';
import { api } from '../../api.ts';

const props = defineProps<{ draft: Settings }>();
const { t, te } = useI18n();
const skills = ref<SkillInfo[]>([]);
onMounted(async () => (skills.value = await api.call('skills.list')));

function setEnabled(id: string, value: boolean) {
  props.draft.skills.enabled = { ...props.draft.skills.enabled, [id]: value };
}
</script>

<template>
  <p class="mh-hint">{{ t('skills.hint') }}</p>
  <div class="list">
    <div v-for="s in skills" :key="s.id" class="mh-switch-row">
      <div class="text">
        <label :for="`sk-${s.id}`">{{ te(`skills.names.${s.id}`) ? t(`skills.names.${s.id}`) : s.id }}</label>
        <p class="mh-hint">{{ te(`skills.desc.${s.id}`) ? t(`skills.desc.${s.id}`) : '' }}</p>
        <p v-if="s.tools.length" class="tools">{{ s.tools.join(' · ') }}</p>
        <p v-if="!s.available" class="mh-hint warn">{{ s.unavailableReason }}</p>
      </div>
      <ToggleSwitch :input-id="`sk-${s.id}`" :model-value="draft.skills.enabled[s.id] ?? false" :disabled="!s.available" @update:model-value="(v: boolean) => setEnabled(s.id, v)" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('skills.infoTitle') }}</h3>
  <div class="mh-row wrap">
    <div v-for="k in ['date', 'system', 'conversation'] as const" :key="k" class="mh-row">
      <Checkbox v-model="draft.skills.info[k]" binary :input-id="`info-${k}`" />
      <label :for="`info-${k}`">{{ t(`skills.info.${k}`) }}</label>
    </div>
  </div>
  <p class="mh-hint">{{ t('skills.later') }}</p>
</template>

<style scoped>
.text {
  min-width: 0;
}
.tools {
  font-family: var(--mh-font-mono);
  font-size: 11.5px;
  color: var(--mh-muted);
  margin: 2px 0 0;
}
.warn {
  color: var(--mh-warning);
}
.wrap {
  flex-wrap: wrap;
  gap: 18px;
}
</style>
