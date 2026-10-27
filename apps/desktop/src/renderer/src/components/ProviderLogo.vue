<script setup lang="ts">
import { computed } from 'vue';

/**
 * Pastilles locales (aucune ressource distante, aucun logo de marque reproduit) :
 * initiales et couleur propres à chaque préréglage.
 */
const props = withDefaults(defineProps<{ preset: string; size?: number }>(), { size: 20 });

const STYLES: Record<string, { label: string; color: string }> = {
  openai: { label: 'OA', color: '#10a37f' },
  deepseek: { label: 'DS', color: '#4d6bfe' },
  openrouter: { label: 'OR', color: '#6467f2' },
  'gemini-openai': { label: 'G', color: '#1a73e8' },
  gemini: { label: 'G', color: '#1a73e8' },
  vertex: { label: 'VX', color: '#34a853' },
  groq: { label: 'GQ', color: '#f55036' },
  mistral: { label: 'M', color: '#fa520f' },
  nvidia: { label: 'NV', color: '#76b900' },
  zai: { label: 'Z', color: '#2d2d2d' },
  ollama: { label: 'OL', color: '#4a4a4a' },
  lmstudio: { label: 'LM', color: '#5a46d6' },
  llamacpp: { label: 'LC', color: '#8a5a2b' },
  opencode: { label: 'OC', color: '#222222' },
  acp: { label: 'AC', color: '#7c3aed' },
  composite: { label: 'CM', color: '#0f8a7a' },
  local: { label: 'GG', color: '#b45309' },
  custom: { label: '{ }', color: '#6b7280' },
};
const style = computed(() => STYLES[props.preset] ?? { label: props.preset.slice(0, 2).toUpperCase(), color: '#6b7280' });
</script>

<template>
  <span class="logo" :style="{ width: `${size}px`, height: `${size}px`, background: style.color, fontSize: `${Math.round(size * 0.42)}px` }" aria-hidden="true">{{ style.label }}</span>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 28%;
  color: #fff;
  font-weight: 700;
  letter-spacing: -0.02em;
  flex: none;
  line-height: 1;
  font-family: var(--mh-font-ui);
}
</style>
