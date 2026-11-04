<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Conversation, PlanItem } from '@monolith/contracts';
import { messagesOf } from '../stores/app.ts';
import DockSection from './DockSection.vue';

/**
 * Plan de travail de l'agent, épinglé au-dessus de la zone de saisie (au lieu de cartes répétées
 * dans le fil) : dernière version publiée par `update_plan`, avec la progression. Affiché tant qu'il
 * reste des étapes ; une fois terminé, il disparaît et reste dans le fil (« Plan exécuté »).
 */
const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();

const latest = computed(() => {
  const list = messagesOf(props.conversation.id).value;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role !== 'assistant') continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!;
      if (p.type === 'tool' && p.call.name === 'update_plan' && p.call.display?.kind === 'plan') {
        return { id: p.call.id, items: p.call.display.items as PlanItem[] };
      }
    }
  }
  return null;
});
const done = computed(() => latest.value?.items.filter((i) => i.status === 'done').length ?? 0);
const total = computed(() => latest.value?.items.length ?? 0);
const finished = computed(() => total.value > 0 && done.value === total.value);
const active = computed(() => latest.value?.items.find((i) => i.status === 'in_progress') ?? null);

/** Étape en cours : animée pendant la génération seulement, en pause sinon. */
const stepIcon = (status: PlanItem['status']) => (status === 'done' ? 'pi-check-circle' : status === 'pending' ? 'pi-circle' : props.conversation.generating ? 'pi-spinner-dotted' : 'pi-pause-circle');

// Masqué par l'utilisateur jusqu'à la prochaine mise à jour du plan.
const dismissed = ref<string | null>(null);
watch(
  () => latest.value?.id,
  () => (dismissed.value = null),
);
const visible = computed(() => !!latest.value && !finished.value && dismissed.value !== latest.value.id);
</script>

<template>
  <DockSection v-if="visible && latest" icon="pi-list-check" :title="t('plan.title')" :count="t('plan.progress', { done, total })" :summary="active?.text">
    <template #actions>
      <button type="button" class="mh-icon-btn" :aria-label="t('plan.hide')" v-tooltip.top="t('plan.hide')" @click="dismissed = latest.id"><i class="pi pi-times" /></button>
    </template>
    <ol class="items" :class="{ live: conversation.generating }">
      <li v-for="(item, i) in latest.items" :key="i" :class="item.status">
        <i class="pi" :class="stepIcon(item.status)" />
        <span>{{ item.text }}</span>
      </li>
    </ol>
  </DockSection>
</template>

<style scoped>
.items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.items li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
}
.items li .pi {
  font-size: 12px;
  color: var(--mh-muted);
}
.items li.done {
  color: var(--mh-muted);
  text-decoration: line-through;
}
.items li.done .pi {
  color: var(--mh-success);
}
.items li.in_progress .pi {
  color: var(--mh-accent);
}
@media (prefers-reduced-motion: no-preference) {
  .items.live li.in_progress .pi {
    animation: spin 2.4s linear infinite;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
