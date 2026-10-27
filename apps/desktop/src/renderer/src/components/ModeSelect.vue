<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Menu from 'primevue/menu';
import { useToast } from 'primevue/usetoast';
import type { Conversation } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();
const menu = ref<InstanceType<typeof Menu> | null>(null);

/** Mode de la conversation : Chat ou Agent (Plan, Proposition, Exécution), appliqué par le moteur. */
const MODES = [
  { key: 'chat', icon: 'pi-comment' },
  { key: 'plan', icon: 'pi-search' },
  { key: 'propose', icon: 'pi-file-edit' },
  { key: 'execute', icon: 'pi-play' },
] as const;
const current = computed(() => (props.conversation.mode === 'chat' ? 'chat' : props.conversation.agentMode));
const currentIcon = computed(() => MODES.find((m) => m.key === current.value)?.icon ?? 'pi-comment');

async function select(key: (typeof MODES)[number]['key']) {
  try {
    await api.call('conversations.update', { id: props.conversation.id, patch: key === 'chat' ? { mode: 'chat' } : { mode: 'agent', agentMode: key } });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 });
  }
}
const items = computed(() => MODES.map((m) => ({ key: m.key, label: t(`modes.${m.key}`), icon: `pi ${m.icon}`, hint: t(`modes.hint.${m.key}`), command: () => select(m.key) })));
</script>

<template>
  <button type="button" class="ghost" :aria-label="`${t('modes.label')} : ${t(`modes.${current}`)}`" aria-haspopup="menu" v-tooltip.top="`${t('modes.label')} (Ctrl+Maj+M)`" @click="menu?.toggle($event)">
    <i class="pi" :class="currentIcon" />
    <span>{{ t(`modes.${current}`) }}</span>
    <i class="pi pi-angle-down caret" />
  </button>
  <Menu ref="menu" :model="items" popup>
    <template #item="{ item, props: p }">
      <a v-bind="p.action" class="mode-item" :class="{ active: item.key === current }">
        <i :class="item.icon" />
        <span class="col">
          <span>{{ item.label }}</span>
          <span class="mh-hint">{{ item.hint }}</span>
        </span>
        <i v-if="item.key === current" class="pi pi-check check" />
      </a>
    </template>
  </Menu>
</template>

<style scoped>
.ghost {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: var(--mh-text);
  font: inherit;
  font-size: 13.5px;
  padding: 6px 9px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--mh-transition);
}
.ghost:hover {
  background: var(--mh-hover);
}
.ghost .pi {
  color: var(--mh-muted);
}
.caret {
  font-size: 11px;
}
.mode-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  max-width: 320px;
}
.mode-item.active {
  color: var(--mh-accent);
}
.col {
  display: flex;
  flex-direction: column;
  white-space: normal;
}
.check {
  margin-left: auto;
}
</style>
