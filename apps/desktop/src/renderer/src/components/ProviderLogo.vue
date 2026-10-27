<script setup lang="ts">
import { computed } from 'vue';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw';
import vertex from '@lobehub/icons-static-svg/icons/vertexai-color.svg?raw';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw';
import nvidia from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw';
import zai from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import geminicli from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw';
import claudecode from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw';

/**
 * Logos des fournisseurs (Lobe Icons, MIT ; marques de leurs propriétaires), intégrés au bundle :
 * aucune ressource distante. Les logos monochromes suivent la couleur du texte (thème clair ou
 * sombre). Sans logo connu : initiales sur une pastille colorée.
 */
const props = withDefaults(defineProps<{ preset: string; size?: number }>(), { size: 20 });

const SVG: Record<string, string> = {
  openai,
  chatgpt: openai,
  deepseek,
  openrouter,
  'gemini-openai': gemini,
  gemini,
  vertex,
  groq,
  mistral,
  nvidia,
  zai,
  ollama,
  lmstudio,
  opencode,
  'gemini-cli': geminicli,
  'claude-code': claudecode,
};
const BADGES: Record<string, { label: string; color: string }> = {
  llamacpp: { label: 'LC', color: '#8a5a2b' },
  acp: { label: 'AC', color: '#7c3aed' },
  composite: { label: 'CM', color: '#0f8a7a' },
  local: { label: 'GG', color: '#b45309' },
  custom: { label: '{ }', color: '#6b7280' },
};
// Le SVG provient du paquet (texte connu à la compilation) : les dimensions suivent la taille demandée.
const svg = computed(() => SVG[props.preset]?.replace(/ (width|height)="1em"/g, ''));
const badge = computed(() => BADGES[props.preset] ?? { label: props.preset.slice(0, 2).toUpperCase(), color: '#6b7280' });
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <span v-if="svg" class="logo svg" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true" v-html="svg" />
  <span v-else class="logo badge" :style="{ width: `${size}px`, height: `${size}px`, background: badge.color, fontSize: `${Math.round(size * 0.42)}px` }" aria-hidden="true">{{ badge.label }}</span>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
}
.svg {
  color: var(--mh-text);
}
.svg :deep(svg) {
  width: 100%;
  height: 100%;
}
.badge {
  border-radius: 28%;
  color: #fff;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-family: var(--mh-font-ui);
}
</style>
