<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import type { AttachmentRef, Message, MessagePart } from '@monolith/contracts';
import { messageVersions, store } from '../stores/app.ts';
import { formatDuration, formatTokens, throughput } from '../lib/format.ts';
import MarkdownView from './MarkdownView.vue';
import AttachmentChip from './AttachmentChip.vue';
import ToolCallBubble from './tools/ToolCallBubble.vue';
import PlanHistory from './PlanHistory.vue';
import ActivityBody from './ActivityBody.vue';

const props = defineProps<{ message: Message; busy?: boolean }>();
const emit = defineEmits<{ resume: []; fork: [] }>();
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
const attachments = computed(() => parts.value.filter((p) => p.type === 'attachment').map((p) => (p as { attachment: AttachmentRef }).attachment));
/** Niveau de réflexion demandé / envoyé / paramètre / repli (jamais présenté comme l'effort réel du modèle). */
const reasoningInfo = computed(() => {
  const r = props.message.snapshot?.reasoning;
  if (!r || (r.requested === 'auto' && !r.fallback)) return null;
  const requested = t(`reasoningLevels.${r.requested}`);
  const sent = r.sent ? t(`reasoningLevels.${r.sent}`) : t('reasoningLevels.auto');
  return { text: t('chat.reasoningSent', { requested, sent }), detail: [r.parameter ? t('chat.reasoningParameter', { parameter: r.parameter }) : null, r.fallback ? t('chat.reasoningFallback', { reason: r.fallback }) : null].filter(Boolean).join(' · '), fallback: !!r.fallback };
});
const hasVisible = computed(() => parts.value.some((p) => (p.type === 'text' && p.text.trim()) || p.type === 'tool' || (p.type === 'reasoning' && display.value !== 'none')));
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
/** Plan publié par l'agent : affiché épinglé au-dessus de la zone de saisie, pas dans le fil (sauf échec). */
const pinnedPlan = (call: { name: string; status: string; display: { kind: string } | null }) => call.name === 'update_plan' && call.status === 'done' && call.display?.kind === 'plan';
/** Dernière version du plan de cette réponse, si toutes ses étapes sont faites : gardée dans le fil comme historique. */
const finishedPlan = computed(() => {
  for (let j = parts.value.length - 1; j >= 0; j--) {
    const p = parts.value[j]!;
    if (p.type !== 'tool' || !pinnedPlan(p.call) || p.call.display?.kind !== 'plan') continue;
    const items = p.call.display.items;
    return items.length > 0 && items.every((i) => i.status === 'done') ? { id: p.call.id, items } : null;
  }
  return null;
});

/**
 * Réflexion et appels d'outils consécutifs : regroupés dans un seul bloc repliable (« activité »).
 * Restent visibles hors du bloc ce qui attend l'utilisateur ou lui est destiné : autorisation en
 * attente, proposition à valider, question, suggestions d'actions, plan exécuté.
 */
type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type Segment = { kind: 'activity'; key: number; items: { part: MessagePart; index: number }[]; tools: ToolPart['call'][]; reasoning: boolean } | { kind: 'part'; key: number; part: MessagePart; index: number };
const standalone = (call: ToolPart['call']) => call.status === 'awaiting_permission' || call.status === 'proposed' || call.display?.kind === 'question' || call.display?.kind === 'actions';
const segments = computed<Segment[]>(() => {
  const out: Segment[] = [];
  let group: Extract<Segment, { kind: 'activity' }> | null = null;
  parts.value.forEach((part, index) => {
    if (part.type === 'tool' && pinnedPlan(part.call) && part.call.id !== finishedPlan.value?.id) return; // plan épinglé : rien dans le fil
    const grouped = (part.type === 'reasoning' && display.value !== 'none') || (part.type === 'tool' && part.call.id !== finishedPlan.value?.id && !standalone(part.call));
    if (part.type === 'reasoning' && display.value === 'none') return;
    if (!grouped) {
      group = null;
      out.push({ kind: 'part', key: index, part, index });
      return;
    }
    if (!group) {
      group = { kind: 'activity', key: index, items: [], tools: [], reasoning: false };
      out.push(group);
    }
    group.items.push({ part, index });
    if (part.type === 'tool') group.tools.push(part.call);
    else group.reasoning = true;
  });
  return out;
});
const activityLabel = (s: Extract<Segment, { kind: 'activity' }>) =>
  [s.reasoning ? t('chat.reasoningBlock') : null, s.tools.length ? t('chat.toolCount', { n: s.tools.length }) : null].filter(Boolean).join(' · ');
const toolName = (c: ToolPart['call']) => (te(`tools.names.${c.name}`) ? t(`tools.names.${c.name}`) : c.name);
/** Pendant la génération : outil en cours, affiché dans l'en-tête du bloc replié. */
const activityNow = (s: Extract<Segment, { kind: 'activity' }>) => {
  const running = s.tools.findLast((c) => c.status === 'running' || c.status === 'pending');
  return running ? toolName(running) : null;
};
/** Dernière étape du bloc : outil (nom et cible) ou fin de la réflexion (dernier titre en gras, sinon dernière ligne). */
const showLastStep = computed(() => store.settings?.chat.activityLastStep ?? true);
function lastStep(s: Extract<Segment, { kind: 'activity' }>): string | null {
  const item = s.items.at(-1);
  if (!item) return null;
  if (item.part.type === 'tool') return [toolName(item.part.call), item.part.call.target].filter(Boolean).join(' · ');
  if (item.part.type !== 'reasoning') return null;
  const text = item.part.text.trim();
  const heading = [...text.matchAll(/\*\*([^*\n]{3,120})\*\*/g)].at(-1)?.[1];
  const line = heading ?? text.split(/\n+/).filter((l) => l.trim()).at(-1) ?? '';
  const clean = line.replace(/[*_`#>]/g, '').trim();
  return clean ? (clean.length > 140 ? `${clean.slice(0, 140)}…` : clean) : null;
}
</script>

<template>
  <article class="msg" :class="message.role" :aria-label="message.role === 'user' ? t('chat.userMessage') : t('chat.assistantMessage')">
    <template v-if="message.role === 'user'">
      <div class="user-col">
        <span v-if="message.origin !== 'direct'" class="origin" :class="message.origin">
          <i class="pi" :class="message.origin === 'steer' ? 'pi-bolt' : 'pi-clock'" />
          {{ message.origin === 'steer' ? t('queue.originSteer') : t('queue.originQueue') }}
        </span>
        <div v-if="attachments.length" class="attachments">
          <AttachmentChip v-for="a in attachments" :key="a.id" :attachment="a" large />
        </div>
        <div v-if="userText" class="bubble user-bubble">{{ userText }}</div>
        <div class="user-actions">
          <button type="button" class="mh-icon-btn act" :disabled="busy" :aria-label="t('actions.resumeHere')" v-tooltip.top="busy ? t('actions.resumeBusy') : t('actions.resumeHere')" @click="emit('resume')"><i class="pi pi-replay" /></button>
          <button type="button" class="mh-icon-btn act" :aria-label="t('actions.forkHere')" v-tooltip.top="t('actions.forkHere')" @click="emit('fork')"><i class="pi pi-clone" /></button>
          <button type="button" class="mh-icon-btn act" :aria-label="t('chat.copyMessage')" v-tooltip.top="copied ? t('common.copied') : t('chat.copyMessage')" @click="copy"><i class="pi" :class="copied ? 'pi-check' : 'pi-copy'" /></button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="assistant-body">
        <template v-for="seg in segments" :key="seg.key">
          <details v-if="seg.kind === 'activity'" class="reasoning activity" :open="display === 'expanded'">
            <summary>
              <i class="pi" :class="seg.reasoning ? 'pi-sparkles' : 'pi-wrench'" />
              <template v-if="showLastStep && lastStep(seg)">
                <span class="now step">{{ lastStep(seg) }}</span>
                <span class="count">{{ activityLabel(seg) }}</span>
              </template>
              <template v-else>
                <span>{{ activityLabel(seg) }}</span>
                <span v-if="streaming && activityNow(seg)" class="now">— {{ activityNow(seg) }}</span>
              </template>
              <ProgressSpinner v-if="streaming && seg === segments.at(-1)" class="tiny" stroke-width="6" />
            </summary>
            <ActivityBody>
              <template v-for="item in seg.items" :key="item.index">
                <div v-if="item.part.type === 'reasoning'" class="reasoning-text">{{ item.part.text }}</div>
                <ToolCallBubble v-else-if="item.part.type === 'tool'" :call="item.part.call" :conversation-id="message.conversationId" :message-id="message.id" />
              </template>
            </ActivityBody>
          </details>
          <MarkdownView v-else-if="seg.part.type === 'text'" :text="seg.part.text" :conversation-id="message.conversationId" />
          <PlanHistory v-else-if="seg.part.type === 'tool' && seg.part.call.id === finishedPlan?.id" :items="finishedPlan.items" />
          <ToolCallBubble v-else-if="seg.part.type === 'tool'" :call="seg.part.call" :conversation-id="message.conversationId" :message-id="message.id" />
          <div v-else-if="seg.part.type === 'notice'" class="notice" :class="seg.part.level" role="note">
            <i class="pi" :class="seg.part.level === 'info' ? 'pi-info-circle' : 'pi-exclamation-triangle'" />
            <span>{{ seg.part.text }}</span>
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
        <span v-if="reasoningInfo" class="reasoning-info" :class="{ fallback: reasoningInfo.fallback }" v-tooltip.top="reasoningInfo.detail || undefined">
          <i class="pi pi-sparkles" /> {{ reasoningInfo.text }}
        </span>
        <button type="button" class="mh-icon-btn copy" :aria-label="t('actions.forkHere')" v-tooltip.top="t('actions.forkHere')" @click="emit('fork')"><i class="pi pi-clone" /></button>
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
/* Rendu différé des messages hors écran : longues conversations fluides, sélection et recherche conservées. */
.msg {
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}
.user-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: min(78%, 720px);
}
.user-col .bubble {
  max-width: 100%;
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: flex-start;
  gap: 6px;
}
.origin {
  font-size: 11.5px;
  color: var(--mh-muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.origin.steer {
  color: var(--mh-accent);
}
.user-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--mh-transition);
}
.msg:hover .user-actions,
.user-actions:focus-within {
  opacity: 1;
}
.act {
  width: 26px;
  height: 26px;
  font-size: 12px;
}
.reasoning-info {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.reasoning-info.fallback {
  color: var(--mh-warning);
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
.activity .now {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity .step {
  color: var(--mh-text);
  opacity: 0.85;
}
.activity .count {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 12px;
}
.activity-body .reasoning-text {
  padding: 2px 4px;
  max-height: none;
  overflow: visible;
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
