<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { SubagentItem } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { openConversation } from '../../stores/app.ts';

defineProps<{ items: SubagentItem[] }>();
const { t } = useI18n();
const toast = useToast();
const expanded = ref<number | null>(null);
const icons: Record<SubagentItem['status'], string> = { running: 'pi-spin pi-spinner', done: 'pi-check-circle ok', interrupted: 'pi-exclamation-circle warn', budget: 'pi-gauge warn', error: 'pi-times-circle bad', cancelled: 'pi-ban' };
async function removeWorktree(item: SubagentItem) {
  try {
    await api.call('subagents.removeWorktree', { conversationId: item.conversationId });
    toast.add({ severity: 'success', summary: t('subagents.worktreeRemoved'), life: 3000 });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });
  }
}
</script>

<template>
  <ul class="subs" :aria-label="t('subagents.title')">
    <li v-for="(it, i) in items" :key="i" class="sub">
      <div class="row">
        <i class="pi" :class="icons[it.status]" />
        <button type="button" class="title" @click="expanded = expanded === i ? null : i">
          <strong>{{ it.title }}</strong>
          <span class="mh-hint">{{ it.role }} · {{ t(`subagents.status.${it.status}`) }}</span>
        </button>
        <Button v-if="it.conversationId" :label="t('subagents.open')" size="small" text icon="pi pi-external-link" @click="openConversation(it.conversationId)" />
      </div>
      <div v-if="it.worktree" class="mh-hint wt">
        <i class="pi pi-sitemap" /> {{ t('subagents.worktree', { path: it.worktree.path, branch: it.worktree.branch }) }}
        <Button v-if="it.status !== 'running'" :label="t('subagents.removeWorktree')" size="small" text severity="danger" @click="removeWorktree(it)" />
      </div>
      <pre v-if="expanded === i" class="summary">{{ it.summary || t('subagents.noReport') }}</pre>
    </li>
  </ul>
</template>

<style scoped>
.subs {
  list-style: none;
  margin: 4px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sub {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  padding: 6px 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--mh-text);
  font: inherit;
  text-align: left;
}
.pi.ok {
  color: #2f9e5b;
}
.pi.warn {
  color: var(--mh-warning);
}
.pi.bad {
  color: var(--mh-danger);
}
.wt {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.summary {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font-family: var(--mh-font-ui);
  font-size: 12.5px;
  max-height: 300px;
  overflow: auto;
}
</style>
