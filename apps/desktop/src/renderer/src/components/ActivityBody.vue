<script setup lang="ts">
import { ref } from 'vue';
import { useFollowScroll } from '../lib/follow-scroll.ts';

/**
 * Contenu du bloc réflexion et outils : hauteur bornée, même suivi du défilement que le chat
 * (suit tant qu'on est en bas, suspendu dès qu'on remonte, repris en revenant en bas).
 */
const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
useFollowScroll(scroller, content);
</script>

<template>
  <div ref="scroller" class="activity-body" tabindex="-1">
    <div ref="content" class="activity-content"><slot /></div>
  </div>
</template>

<style scoped>
.activity-body {
  /* Hauteur bornée : l'en-tête reste à portée, le bloc défile. */
  max-height: min(420px, 50vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  outline: none;
}
.activity-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 10px;
}
</style>
