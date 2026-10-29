<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from 'primevue/usetoast';
import type { Conversation, ConversationPatch, McpServer } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';

/**
 * Ce qui est imposé ou réglé autrement dans cette conversation que dans les réglages : skills imposés
 * (/skill-…), orchestration forcée (/orchestration), serveurs MCP activés ou désactivés ici.
 * Chaque puce se retire d'un clic sur sa croix.
 */
const props = defineProps<{ conversation: Conversation }>();
const { t, te } = useI18n();
const toast = useToast();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 });

const skillLabel = (id: string) => (te(`skills.names.${id}`) ? t(`skills.names.${id}`) : id);
function patch(p: ConversationPatch) {
  void api.call('conversations.update', { id: props.conversation.id, patch: p }).catch(fail);
}
const removeSkill = (name: string) => patch({ forcedSkills: props.conversation.forcedSkills.filter((n) => n !== name) });

// Serveurs MCP : réglage de la conversation différent du réglage global.
const servers = ref<McpServer[]>([]);
const perConversation = ref<{ serverId: number; enabled: boolean }[]>([]);
async function loadMcp() {
  const id = props.conversation.id;
  const [list, conv] = await Promise.all([api.call('mcp.list').catch(() => []), api.call('mcp.conversation', { conversationId: id }).catch(() => [])]);
  if (id !== props.conversation.id) return;
  servers.value = list;
  perConversation.value = conv;
}
watch(() => props.conversation.id, loadMcp, { immediate: true });
const offMcp = api.on('mcp.changed', () => void loadMcp());
onBeforeUnmount(offMcp);
const mcpOverrides = computed(() =>
  perConversation.value
    .map((c) => ({ server: servers.value.find((s) => s.id === c.serverId), enabled: c.enabled }))
    .filter((x): x is { server: McpServer; enabled: boolean } => !!x.server && x.server.enabled !== x.enabled),
);
async function resetMcp(server: McpServer) {
  await api.call('mcp.setConversation', { conversationId: props.conversation.id, serverId: server.id, enabled: server.enabled }).catch(fail);
  await loadMcp();
}
</script>

<template>
  <span v-if="conversation.forcedSkills.length || conversation.orchestration || mcpOverrides.length" class="chips" role="list" :aria-label="t('chips.title')">
    <span v-for="name in conversation.forcedSkills" :key="`s-${name}`" class="chip" role="listitem" :title="t('chips.skillHint', { name: skillLabel(name) })">
      <i class="pi pi-bolt" />{{ skillLabel(name) }}
      <button type="button" class="x" :aria-label="t('chips.remove', { name: skillLabel(name) })" @click="removeSkill(name)"><i class="pi pi-times" /></button>
    </span>
    <span v-if="conversation.orchestration" class="chip" role="listitem" :title="t('chips.orchestrationHint')">
      <i class="pi pi-sitemap" />{{ t('chips.orchestration') }}
      <button type="button" class="x" :aria-label="t('chips.remove', { name: t('chips.orchestration') })" @click="patch({ orchestration: false })"><i class="pi pi-times" /></button>
    </span>
    <span v-for="o in mcpOverrides" :key="`m-${o.server.id}`" class="chip" :class="{ off: !o.enabled }" role="listitem" :title="t(o.enabled ? 'chips.mcpOnHint' : 'chips.mcpOffHint', { name: o.server.name })">
      <i class="pi" :class="o.enabled ? 'pi-link' : 'pi-ban'" />MCP {{ o.server.name }}
      <button type="button" class="x" :aria-label="t('chips.reset', { name: o.server.name })" @click="resetMcp(o.server)"><i class="pi pi-times" /></button>
    </span>
  </span>
</template>

<style scoped>
.chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 2px 4px 2px 9px;
  border: 1px solid color-mix(in srgb, var(--mh-accent) 40%, var(--mh-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--mh-accent) 8%, var(--mh-surface));
  color: var(--mh-text);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip > .pi {
  color: var(--mh-accent);
  font-size: 11px;
}
.chip.off {
  border-color: var(--mh-border);
  background: var(--mh-surface);
  color: var(--mh-muted);
}
.chip.off > .pi {
  color: var(--mh-muted);
}
.x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--mh-muted);
  cursor: pointer;
}
.x .pi {
  font-size: 9px;
}
.x:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
</style>
