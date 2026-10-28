<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Conversation, PlanItem } from '@monolith/contracts';
import { messagesOf } from '../stores/app.ts';

/**
 * Plan de travail de l'agent, épinglé au-dessus de la zone de saisie (au lieu de cartes répétées
 * dans le fil) : dernière version publiée par `update_plan`, avec la progression. Affiché tant que
 * le plan appartient à la dernière réponse ou qu'il reste des étapes.
 */
const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();

const latest = computed(() => {
  const list = messagesOf(props.conversation.id).value;
  const lastAssistant = [...list].reverse().find((m) => m.role === 'assistant');
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role !== 'assistant') continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]!;
      if (p.type === 'tool' && p.call.name === 'update_plan' && p.call.display?.kind === 'plan') {
        return { id: p.call.id, items: p.call.display.items as PlanItem[], current: m.id === lastAssistant?.id };
      }
    }
  }
  return null;
});
const done = computed(() => latest.value?.items.filter((i) => i.status === 'done').length ?? 0);
const total = computed(() => latest.value?.items.length ?? 0);
const finished = computed(() => total.value > 0 && done.value === total.value);
const active = computed(() => latest.value?.items.find((i) => i.status === 'in_progress') ?? null);

// Replié par défaut une fois terminé ; masqué par l'utilisateur jusqu'à la prochaine mise à jour.
const collapsed = ref(false);
const dismissed = ref<string | null>(null);
watch(
  () => latest.value?.id,
  () => {
    collapsed.value = finished.value;
    dismissed.value = null;
  },
);
watch(finished, (f) => f && (collapsed.value = true));
const visible = computed(() => !!latest.value && dismissed.value !== latest.value.id && (latest.value.current || !finished.value));
</script>

<template>
  <div v-if="visible && latest" class="wrap">
  <section class="dock" :aria-label="t('plan.title')">
    <header>
      <button type="button" class="toggle" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        <i class="pi pi-list-check" />
        <strong>{{ t('plan.title') }}</strong>
        <span class="count" :class="{ ok: finished }">{{ t('plan.progress', { done, total }) }}</span>
        <span v-if="collapsed && active" class="now">— {{ active.text }}</span>
        <i class="pi caret" :class="collapsed ? 'pi-angle-up' : 'pi-angle-down'" />
      </button>
      <button type="button" class="mh-icon-btn small" :aria-label="t('plan.hide')" v-tooltip.top="t('plan.hide')" @click="dismissed = latest.id"><i class="pi pi-times" /></button>
    </header>
    <ol v-if="!collapsed" class="items">
      <li v-for="(item, i) in latest.items" :key="i" :class="item.status">
        <i class="pi" :class="item.status === 'done' ? 'pi-check-circle' : item.status === 'in_progress' ? 'pi-spinner-dotted' : 'pi-circle'" />
        <span>{{ item.text }}</span>
      </li>
    </ol>
  </section>
  </div>
</template>

<style scoped>
.wrap {
  padding: 0 34px;
}
.dock {
  max-width: 860px;
  margin: 0 auto -1px;
  padding: 6px 12px 8px;
  border: 1px solid color-mix(in srgb, var(--mh-border) 60%, transparent);
  border-bottom: 0;
  border-radius: 14px 14px 0 0;
  background: color-mix(in srgb, var(--mh-text) 3%, var(--mh-surface));
  font-size: 13px;
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
.toggle .pi-list-check {
  color: var(--mh-accent);
}
.count {
  color: var(--mh-muted);
  font-variant-numeric: tabular-nums;
}
.count.ok {
  color: var(--mh-success);
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
.items {
  list-style: none;
  margin: 2px 0 0;
  padding: 0 2px;
  max-height: 180px;
  overflow: auto;
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
  .items li.in_progress .pi {
    animation: spin 2.4s linear infinite;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
