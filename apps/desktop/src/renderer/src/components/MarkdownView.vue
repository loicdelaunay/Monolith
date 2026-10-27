<script setup lang="ts">
import { computed } from 'vue';
import { host } from '../api.ts';
import { highlightVersion, renderBlock, splitBlocks } from '../lib/markdown.ts';
import { store } from '../stores/app.ts';

const props = defineProps<{ text: string }>();

/**
 * Un élément par bloc : pendant le streaming, seul le dernier bloc change de HTML ;
 * les blocs terminés ne sont pas retouchés (sélection et position conservées).
 */
const blocks = computed(() => {
  void highlightVersion.value;
  return splitBlocks(props.text).map(renderBlock);
});

async function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLElement>('[data-copy]');
  if (copy) {
    const code = copy.closest('.mh-code')?.querySelector('pre')?.innerText ?? '';
    await navigator.clipboard.writeText(code);
    const icon = copy.querySelector('i');
    if (icon) {
      icon.className = 'pi pi-check';
      setTimeout(() => (icon.className = 'pi pi-copy'), 1200);
    }
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) await host.openExternal(href);
  }
}
</script>

<template>
  <div class="mh-md" :class="{ 'mh-code-lines': store.settings?.chat.codeLineNumbers }" @click="onClick">
    <div v-for="(html, i) in blocks" :key="i" class="mh-md-block" v-html="html" />
  </div>
</template>

<style scoped>
.mh-md-block {
  display: contents;
}
</style>
