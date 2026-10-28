<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PlanItem } from '@monolith/contracts';

/** Plan terminé : retiré du haut de la zone de saisie, gardé dans le fil comme historique (replié). */
defineProps<{ items: PlanItem[] }>();
const { t } = useI18n();
const open = ref(false);
</script>

<template>
  <section class="plan-history" :aria-label="t('plan.executed')">
    <button type="button" class="head" :aria-expanded="open" @click="open = !open">
      <i class="pi pi-check-circle ok" />
      <strong>{{ t('plan.executed') }}</strong>
      <span class="count">{{ t('plan.steps', { n: items.length }) }}</span>
      <i class="pi caret" :class="open ? 'pi-angle-up' : 'pi-angle-down'" />
    </button>
    <ol v-if="open" class="items">
      <li v-for="(item, i) in items" :key="i">
        <i class="pi pi-check ok" />
        <span>{{ item.text }}</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.plan-history {
  margin: 4px 0;
  border: 1px solid color-mix(in srgb, var(--mh-border) 60%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--mh-text) 2%, var(--mh-surface));
  font-size: 13px;
}
.head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ok {
  color: var(--mh-success);
}
.count {
  color: var(--mh-muted);
}
.caret {
  margin-left: auto;
  color: var(--mh-muted);
}
.items {
  list-style: none;
  margin: 0;
  padding: 0 12px 8px;
}
.items li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  color: var(--mh-muted);
}
</style>
