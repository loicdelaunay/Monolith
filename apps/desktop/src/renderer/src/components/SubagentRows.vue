<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import type { Conversation } from '@monolith/contracts';
import { openConversation, store, subagentsOf } from '../stores/app.ts';

/**
 * Sous-conversations des agents délégués, sous leur conversation parente dans la barre latérale :
 * repliables, ouvertes d'office quand l'une d'elles travaille ou est affichée.
 */
const props = defineProps<{ parent: Conversation; depth?: number }>();
const { t } = useI18n();
const children = computed(() => subagentsOf(props.parent.id));
const busy = computed(() => children.value.some((c) => c.generating));
const containsActive = computed(() => {
  const seek = (id: number): boolean => subagentsOf(id).some((c) => c.id === store.activeId || seek(c.id));
  return seek(props.parent.id);
});
const open = ref(false);
watch([busy, containsActive], ([b, a]) => (b || a) && (open.value = true), { immediate: true });
</script>

<template>
  <div v-if="children.length" class="subagents" :style="{ '--level': depth ?? 0 }">
    <button type="button" class="toggle" :aria-expanded="open" @click="open = !open">
      <i class="pi chevron" :class="open ? 'pi-angle-down' : 'pi-angle-right'" />
      <i class="pi pi-sitemap" />
      <span>{{ t('sidebar.subagents', { n: children.length }) }}</span>
      <ProgressSpinner v-if="busy && !open" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
    </button>
    <ul v-if="open">
      <li v-for="c in children" :key="c.id">
        <button type="button" class="child" :class="{ active: store.activeId === c.id }" :aria-current="store.activeId === c.id ? 'page' : undefined" :title="c.title" @click="openConversation(c.id)">
          <i class="pi pi-user" />
          <span v-if="c.role" class="role">{{ c.role }}</span>
          <span class="title">{{ c.title }}</span>
          <ProgressSpinner v-if="c.generating" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
        </button>
        <SubagentRows :parent="c" :depth="(depth ?? 0) + 1" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.subagents {
  padding-left: calc(14px + var(--level) * 12px);
  font-size: 12.5px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0 0 2px 10px;
  border-left: 1px solid var(--mh-border);
  margin-left: 6px;
}
.toggle,
.child {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 3px 8px;
  border: 0;
  border-radius: var(--mh-radius-sm);
  background: transparent;
  color: var(--mh-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.toggle:hover,
.child:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
.child.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  color: var(--mh-text);
}
.chevron {
  font-size: 11px;
}
.role {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--mh-accent) 12%, transparent);
  color: var(--mh-accent);
  font-size: 11px;
}
.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spin {
  width: 12px;
  height: 12px;
  margin-left: auto;
  flex-shrink: 0;
}
</style>
