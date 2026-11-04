<script setup lang="ts">
import { ref } from 'vue';

/**
 * Bloc posé sur la zone de saisie : le plan, la file d'attente et les propositions partagent cette
 * présentation (en-tête repliable, compteur, actions) et s'empilent en un seul ensemble.
 */
defineProps<{ icon: string; title: string; count?: string | number; summary?: string | null; maxHeight?: number }>();
const collapsed = ref(false);
</script>

<template>
  <section class="dock" :aria-label="title">
    <header>
      <button type="button" class="toggle" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        <i class="pi lead" :class="icon" />
        <strong>{{ title }}</strong>
        <span v-if="count !== undefined" class="count">{{ count }}</span>
        <span v-if="collapsed && summary" class="now">— {{ summary }}</span>
        <i class="pi caret" :class="collapsed ? 'pi-angle-up' : 'pi-angle-down'" />
      </button>
      <slot name="actions" />
    </header>
    <div v-if="!collapsed" class="body" :style="{ maxHeight: `${maxHeight ?? 180}px` }"><slot /></div>
  </section>
</template>

<style scoped>
.dock {
  padding: 6px 12px 8px;
  border: 1px solid color-mix(in srgb, var(--mh-border) 60%, transparent);
  border-bottom: 0;
  background: color-mix(in srgb, var(--mh-text) 3%, var(--mh-surface));
  font-size: 13px;
}
.dock:first-child {
  border-radius: 14px 14px 0 0;
}
.dock:last-child {
  margin-bottom: -1px;
}
header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 4px 2px;
  text-align: left;
  cursor: pointer;
}
.lead {
  color: var(--mh-accent);
}
.toggle strong {
  flex: none;
}
.count {
  flex: none;
  color: var(--mh-muted);
  font-variant-numeric: tabular-nums;
}
.now {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--mh-muted);
}
.caret {
  margin-left: auto;
  font-size: 11px;
  color: var(--mh-muted);
}
.body {
  margin-top: 2px;
  padding: 0 2px;
  overflow: auto;
}
.dock :deep(.mh-icon-btn) {
  width: 24px;
  height: 24px;
}
.dock :deep(.mh-icon-btn .pi) {
  font-size: 11px;
}
</style>
