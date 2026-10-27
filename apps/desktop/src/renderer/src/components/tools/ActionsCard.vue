<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { ActionProposal, Id, ToolCallRecord } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { openConversation, store } from '../../stores/app.ts';

const props = defineProps<{ call: ToolCallRecord; conversationId: Id; messageId: Id }>();
const { t } = useI18n();
const toast = useToast();
const actions = computed<ActionProposal[]>(() => (props.call.display?.kind === 'actions' ? props.call.display.actions : []));
const expanded = ref<string | null>(null);
const busy = ref<string | null>(null);
const ICON: Record<ActionProposal['kind'], string> = { continue: 'pi-arrow-right', agent: 'pi-sitemap', new_chat: 'pi-plus', queue: 'pi-list' };

async function trigger(a: ActionProposal) {
  busy.value = a.id;
  try {
    const r = await api.call('actions.trigger', { conversationId: props.conversationId, messageId: props.messageId, callId: props.call.id, actionId: a.id });
    if (r.conversationId !== props.conversationId) {
      const c = await api.call('conversations.get', { id: r.conversationId });
      store.conversations.set(c.id, c);
      await openConversation(c.id);
    }
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="actions">
    <p class="mh-hint">{{ t('actionsCard.hint') }}</p>
    <div v-for="a in actions" :key="a.id" class="action" :class="{ done: a.triggered }">
      <div class="row">
        <Button :label="a.title" :icon="`pi ${ICON[a.kind]}`" size="small" :severity="a.triggered ? 'secondary' : undefined" :disabled="a.triggered" :loading="busy === a.id" @click="trigger(a)" />
        <span class="kind mh-hint">{{ t(`actionsCard.kinds.${a.kind}`) }}</span>
        <span v-if="a.triggered" class="mh-hint"><i class="pi pi-check" /> {{ t('actionsCard.triggered') }}</span>
        <button type="button" class="link" :aria-expanded="expanded === a.id" @click="expanded = expanded === a.id ? null : a.id">{{ expanded === a.id ? t('actionsCard.hide') : t('actionsCard.show') }}</button>
      </div>
      <pre v-if="expanded === a.id" class="instructions">{{ a.instructions }}</pre>
    </div>
  </div>
</template>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.link {
  border: 0;
  background: transparent;
  color: var(--mh-accent);
  cursor: pointer;
  font-size: 12.5px;
}
.instructions {
  margin: 6px 0 0;
  white-space: pre-wrap;
  background: var(--mh-code-bg);
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
}
</style>
