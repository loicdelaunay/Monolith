<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import type { Message, MessagePart } from '@monolith/contracts';
import { messageVersions, store } from '../stores/app.ts';
import { formatDuration, formatTokens, throughput } from '../lib/format.ts';
import MarkdownView from './MarkdownView.vue';

const props = defineProps<{ message: Message }>();
const { t, te } = useI18n();

/** Lecture de la version : le composant se re-rend à chaque delta de ce message uniquement. */
const parts = computed<MessagePart[]>(() => {
  void messageVersions.get(props.message.id);
  return props.message.parts.map((p) => ({ ...p }));
});
const status = computed(() => {
  void messageVersions.get(props.message.id);
  return props.message.status;
});
const streaming = computed(() => status.value === 'streaming');
const display = computed(() => store.settings?.chat.reasoningDisplay ?? 'collapsed');
const userText = computed(() => parts.value.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''));
const hasVisible = computed(() => parts.value.some((p) => (p.type === 'text' && p.text.trim()) || (p.type === 'reasoning' && display.value !== 'none')));
/** Statut minimal « Raisonnement… » : réflexion en cours et affichage réglé sur Aucun, ou rien encore reçu. */
const reasoningOnly = computed(() => streaming.value && parts.value.at(-1)?.type === 'reasoning' && display.value === 'none');

const generation = computed(() => store.generations.get(props.message.conversationId));
const retryInfo = computed(() => {
  const g = generation.value;
  if (!g || g.messageId !== props.message.id || g.status !== 'retrying') return null;
  return t('chat.retrying', { attempt: g.attempt + 1, seconds: Math.ceil((g.retryInMs ?? 0) / 1000), reason: g.retryReason ?? '' });
});

const tps = computed(() => (store.settings?.chat.showThroughput ? throughput(props.message) : null));
const copied = ref(false);
async function copy() {
  const text = parts.value.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n\n');
  await navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1200);
}
const errorTitle = computed(() => {
  const code = props.message.error?.code;
  return code && te(`errors.${code}`) ? t(`errors.${code}`) : t('chat.status.error');
});
</script>

<template>
  <article class="msg" :class="message.role" :aria-label="message.role === 'user' ? t('chat.userMessage') : t('chat.assistantMessage')">
    <template v-if="message.role === 'user'">
      <div class="bubble user-bubble">{{ userText }}</div>
    </template>

    <template v-else>
      <div class="assistant-body">
        <template v-for="(part, i) in parts" :key="i">
          <details v-if="part.type === 'reasoning' && display !== 'none'" class="reasoning" :open="display === 'expanded'">
            <summary>
              <i class="pi pi-sparkles" />
              <span>{{ t('chat.reasoningBlock') }}</span>
              <ProgressSpinner v-if="streaming && i === parts.length - 1" class="tiny" stroke-width="6" />
            </summary>
            <div class="reasoning-text">{{ part.text }}</div>
          </details>
          <MarkdownView v-else-if="part.type === 'text'" :text="part.text" />
          <div v-else-if="part.type === 'notice'" class="notice" :class="part.level" role="note">
            <i class="pi" :class="part.level === 'info' ? 'pi-info-circle' : 'pi-exclamation-triangle'" />
            <span>{{ part.text }}</span>
          </div>
        </template>

        <div v-if="streaming && (!hasVisible || reasoningOnly)" class="pending" role="status">
          <ProgressSpinner class="tiny" stroke-width="6" />
          <span>{{ retryInfo ?? t('chat.thinking') }}</span>
        </div>
        <div v-else-if="retryInfo" class="pending" role="status">
          <i class="pi pi-refresh" />
          <span>{{ retryInfo }}</span>
        </div>

        <div v-if="message.error" class="error" role="alert">
          <i class="pi pi-times-circle" />
          <div>
            <strong>{{ errorTitle }}</strong>
            <span v-if="message.error.status"> (HTTP {{ message.error.status }})</span>
            <div class="error-detail">{{ message.error.message }}</div>
            <div v-if="message.error.attempts && message.error.attempts > 1" class="mh-hint">{{ t('chat.attempts', { count: message.error.attempts }) }}</div>
          </div>
        </div>
      </div>

      <footer v-if="!streaming" class="meta">
        <span v-if="status !== 'complete'" class="state" :class="status">{{ t(`chat.status.${status}`) }}</span>
        <span v-if="message.snapshot" class="model" :title="message.snapshot.providerName">{{ message.snapshot.model }}</span>
        <span v-if="message.usage" :title="message.usage.estimated ? t('chat.estimatedHint') : undefined">
          {{ formatTokens(message.usage.inputTokens) }} {{ t('chat.tokensIn') }} · {{ formatTokens(message.usage.outputTokens) }} {{ t('chat.tokensOut') }}
          <template v-if="message.usage.cachedInputTokens"> · {{ formatTokens(message.usage.cachedInputTokens) }} {{ t('chat.cached') }}</template>
          <template v-if="message.usage.estimated"> ({{ t('chat.estimated') }})</template>
        </span>
        <span v-if="message.durationMs">{{ formatDuration(message.durationMs) }}</span>
        <span v-if="tps">{{ t('chat.throughput', { value: tps.toFixed(1) }) }}</span>
        <button type="button" class="mh-icon-btn copy" :aria-label="t('chat.copyMessage')" v-tooltip.top="copied ? t('common.copied') : t('chat.copyMessage')" @click="copy">
          <i class="pi" :class="copied ? 'pi-check' : 'pi-copy'" />
        </button>
      </footer>
    </template>
  </article>
</template>

<style scoped>
.msg {
  padding: calc(10px * var(--mh-density)) 0;
}
.msg.user {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  max-width: min(78%, 720px);
  padding: 10px 14px;
  border-radius: 16px 16px 4px 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mh-font-reply);
  font-size: var(--mh-reading-size);
  line-height: 1.55;
}
.user-bubble {
  background: var(--mh-user-bubble);
}
.assistant-body {
  background: var(--mh-assistant-bubble);
  border-radius: var(--mh-radius);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.reasoning {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: var(--mh-tool-bubble);
  font-size: 13px;
}
.reasoning summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  color: var(--mh-muted);
  user-select: none;
  list-style: none;
}
.reasoning summary::-webkit-details-marker {
  display: none;
}
.reasoning[open] summary {
  border-bottom: 1px solid var(--mh-border);
}
.reasoning-text {
  padding: 10px 14px;
  white-space: pre-wrap;
  color: var(--mh-muted);
  max-height: 360px;
  overflow-y: auto;
  line-height: 1.55;
}
.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  padding: 7px 12px;
  border-radius: var(--mh-radius-sm);
  background: color-mix(in srgb, var(--mh-warning) 10%, transparent);
  color: var(--mh-text);
}
.notice.info {
  background: color-mix(in srgb, var(--mh-accent) 8%, transparent);
}
.notice .pi {
  margin-top: 2px;
  color: var(--mh-warning);
}
.notice.info .pi {
  color: var(--mh-accent);
}
.pending {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--mh-muted);
  font-size: 13px;
}
.tiny {
  width: 14px !important;
  height: 14px !important;
  margin: 0;
}
.error {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--mh-danger) 40%, var(--mh-border));
  background: color-mix(in srgb, var(--mh-danger) 8%, transparent);
  border-radius: var(--mh-radius);
  font-size: 13.5px;
}
.error .pi {
  color: var(--mh-danger);
  margin-top: 2px;
}
.error-detail {
  color: var(--mh-muted);
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--mh-muted);
}
.meta .model {
  font-family: var(--mh-font-mono);
}
.meta .state {
  font-weight: 600;
}
.meta .state.error {
  color: var(--mh-danger);
}
.meta .state.cancelled,
.meta .state.interrupted {
  color: var(--mh-warning);
}
.copy {
  width: 24px;
  height: 24px;
  font-size: 12px;
  opacity: 0;
}
.msg:hover .copy,
.copy:focus-visible {
  opacity: 1;
}
</style>
