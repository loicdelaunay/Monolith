<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { previewUrl } from '../../lib/attachments.ts';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import Popover from 'primevue/popover';
import SelectButton from 'primevue/selectbutton';
import type { Id, ToolCallRecord } from '@monolith/contracts';
import DiffView from './DiffView.vue';
import QuestionCard from './QuestionCard.vue';
import ActionsCard from './ActionsCard.vue';

const props = defineProps<{ call: ToolCallRecord; conversationId: Id; messageId: Id }>();
const { t, te } = useI18n();

const ICONS: Record<string, string> = { sources: 'pi-folder-open', edit: 'pi-pencil', terminal: 'pi-desktop', info: 'pi-info-circle', questions: 'pi-question-circle', actions: 'pi-bolt', planning: 'pi-list-check', mcp: 'pi-link', web: 'pi-globe', memory: 'pi-database', git: 'pi-sitemap', browser: 'pi-globe', desktop: 'pi-camera' };
const icon = computed(() => ICONS[props.call.family] ?? 'pi-wrench');
const active = computed(() => ['pending', 'running', 'awaiting_permission'].includes(props.call.status));
const open = ref(false);
const shield = ref<InstanceType<typeof Popover> | null>(null);
const view = ref<'formatted' | 'raw'>('formatted');

/** Bouclier : couleur selon l'origine de la décision. */
const shieldClass = computed(() => {
  const p = props.call.permission;
  if (!p) return 'none';
  if (p.decision === 'deny') return 'deny';
  return p.source === 'user' ? 'user' : p.source === 'rule' ? 'rule' : 'auto';
});
const statusLabel = computed(() => (te(`tools.status.${props.call.status}`) ? t(`tools.status.${props.call.status}`) : props.call.status));
const prettyArgs = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.call.arguments || '{}'), null, 2);
  } catch {
    return props.call.arguments;
  }
});
const display = computed(() => props.call.display);
const hasFormatted = computed(() => display.value?.kind === 'changes');
// Les questions en attente s'affichent ouvertes : l'utilisateur doit pouvoir répondre.
const showBody = computed(() => open.value || (display.value?.kind === 'question' && active.value) || display.value?.kind === 'actions' || display.value?.kind === 'plan' || display.value?.kind === 'image');
const image = ref<string | null>(null);
watch(
  () => (display.value?.kind === 'image' ? display.value.attachmentId : null),
  async (id) => (image.value = id === null ? null : await previewUrl(id).catch(() => null)),
  { immediate: true },
);
</script>

<template>
  <div class="tool" :class="[call.status, { open: showBody }]">
    <div class="head">
      <button type="button" class="toggle" :aria-expanded="showBody" @click="open = !open">
        <i class="pi" :class="icon" aria-hidden="true" />
        <span class="name">{{ te(`tools.names.${call.name}`) ? t(`tools.names.${call.name}`) : call.name }}</span>
        <span v-if="call.target" class="target" :title="call.target">{{ call.target }}</span>
      </button>
      <ProgressSpinner v-if="active" class="spin" stroke-width="6" :aria-label="statusLabel" />
      <span v-else class="status" :class="call.status">{{ statusLabel }}</span>
      <button type="button" class="shield" :class="shieldClass" :aria-label="t('tools.permissionDetails')" v-tooltip.top="t('tools.permissionDetails')" @click="shield?.toggle($event)">
        <i class="pi" :class="shieldClass === 'deny' ? 'pi-shield' : 'pi-verified'" />
      </button>
    </div>

    <div v-if="showBody" class="body">
      <QuestionCard v-if="display?.kind === 'question'" :call="call" :conversation-id="conversationId" />
      <ActionsCard v-else-if="display?.kind === 'actions'" :call="call" :conversation-id="conversationId" :message-id="messageId" />
      <figure v-else-if="display?.kind === 'image'" class="shot">
        <img v-if="image" :src="image" :alt="display.caption" />
        <figcaption class="mh-hint">{{ display.caption }}</figcaption>
      </figure>
      <ol v-else-if="display?.kind === 'plan'" class="plan">
        <li v-for="(item, i) in display.items" :key="i" :class="item.status">
          <i class="pi" :class="item.status === 'done' ? 'pi-check-circle' : item.status === 'in_progress' ? 'pi-spinner-dotted' : 'pi-circle'" />
          {{ item.text }}
        </li>
      </ol>

      <template v-if="open && display?.kind !== 'plan'">
        <div class="params-head">
          <span class="mh-label">{{ t('tools.params') }}</span>
          <SelectButton v-if="hasFormatted" v-model="view" :options="['formatted', 'raw']" :option-label="(o: string) => t(`tools.view.${o}`)" :allow-empty="false" size="small" :aria-label="t('tools.params')" />
        </div>
        <template v-if="hasFormatted && view === 'formatted' && display?.kind === 'changes'">
          <DiffView v-for="c in display.changes" :key="c.path" :before="c.before" :after="c.after" :path="`${c.path} (${t(`tools.change.${c.status}`)})`" />
          <p v-if="!display.applied" class="mh-hint">{{ call.status === 'proposed' ? t('tools.proposedHint') : t('tools.notApplied') }}</p>
        </template>
        <pre v-else class="raw">{{ prettyArgs }}</pre>

        <template v-if="display?.kind === 'command'">
          <div class="mh-label">{{ t('tools.output') }} <span class="mh-hint">{{ display.cwd }} · {{ display.exitCode !== null ? t('tools.exitCode', { code: display.exitCode }) : t(`tools.cmdStatus.${display.status}`) }}</span></div>
          <pre class="raw output">{{ display.output || t('tools.noOutput') }}</pre>
        </template>
        <template v-else-if="display?.kind === 'file'">
          <div class="mh-label">{{ display.path }} <span class="mh-hint">{{ t('tools.lines', { start: display.startLine, end: display.endLine, total: display.totalLines }) }}</span></div>
          <pre class="raw output">{{ display.content }}</pre>
        </template>
        <template v-else-if="display?.kind === 'list'">
          <div class="mh-label">{{ display.title }} <span class="mh-hint">({{ display.items.length }}{{ display.truncated ? '+' : '' }})</span></div>
          <pre class="raw output">{{ display.items.join('\n') }}</pre>
        </template>
        <dl v-else-if="display?.kind === 'info'" class="info">
          <template v-for="e in display.entries" :key="e.label"><dt>{{ e.label }}</dt><dd>{{ e.value }}</dd></template>
        </dl>
        <template v-else-if="call.result && display?.kind !== 'changes'">
          <div class="mh-label">{{ t('tools.result') }}</div>
          <pre class="raw output">{{ call.result }}</pre>
        </template>
        <p v-if="call.result && (call.status === 'error' || call.status === 'denied' || call.status === 'interrupted')" class="error-text">{{ call.result }}</p>
      </template>
    </div>

    <Popover ref="shield">
      <div class="perm">
        <strong>{{ t('tools.permissionTitle') }}</strong>
        <template v-if="call.permission">
          <div><span class="mh-muted">{{ t('tools.decision') }}</span> {{ t(`tools.decisions.${call.permission.decision}`) }}</div>
          <div><span class="mh-muted">{{ t('tools.origin') }}</span> {{ t(`tools.sources.${call.permission.source}`) }}</div>
          <div v-if="call.permission.ruleId"><span class="mh-muted">{{ t('tools.rule') }}</span> n° {{ call.permission.ruleId }}</div>
          <div v-if="call.permission.scope"><span class="mh-muted">{{ t('tools.scope') }}</span> {{ t(`tools.scopes.${call.permission.scope}`) }}</div>
          <p class="mh-hint">{{ call.permission.reason }}</p>
        </template>
        <p v-else class="mh-hint">{{ t('tools.noDecisionYet') }}</p>
        <div class="mh-hint">{{ t('tools.effects') }} : {{ call.effects.map((e) => t(`tools.effect.${e}`)).join(', ') || '—' }}</div>
      </div>
    </Popover>
  </div>
</template>

<style scoped>
.shot {
  margin: 4px 0;
}
.shot img {
  max-width: 100%;
  max-height: 420px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
}

.tool {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: var(--mh-tool-bubble);
  font-size: 13px;
}
.tool.denied,
.tool.error {
  border-color: color-mix(in srgb, var(--mh-danger) 35%, var(--mh-border));
}
.tool.awaiting_permission {
  border-color: color-mix(in srgb, var(--mh-warning) 60%, var(--mh-border));
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 10px;
}
.toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  padding: 3px 0;
}
.toggle .pi {
  color: var(--mh-muted);
}
.name {
  font-weight: 600;
  white-space: nowrap;
}
.target {
  font-family: var(--mh-font-mono);
  font-size: 12px;
  color: var(--mh-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.spin {
  width: 14px !important;
  height: 14px !important;
  margin: 0;
  flex: none;
}
.status {
  font-size: 11.5px;
  color: var(--mh-muted);
  flex: none;
}
.status.error,
.status.denied {
  color: var(--mh-danger);
}
.status.proposed {
  color: var(--mh-accent);
}
.status.cancelled,
.status.interrupted {
  color: var(--mh-warning);
}
.shield {
  border: 0;
  background: transparent;
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  flex: none;
}
.shield:hover {
  background: var(--mh-hover);
}
.shield.auto {
  color: var(--mh-muted);
}
.shield.rule {
  color: var(--mh-success);
}
.shield.user {
  color: var(--mh-accent);
}
.shield.deny {
  color: var(--mh-danger);
}
.shield.none {
  color: var(--mh-muted);
  opacity: 0.5;
}
.body {
  padding: 4px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--mh-border);
}
.params-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}
.raw {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  background: var(--mh-code-bg);
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--mh-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.plan {
  list-style: none;
  margin: 0;
  padding: 2px 0;
}
.plan li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.plan li.done {
  color: var(--mh-muted);
  text-decoration: line-through;
}
.plan li.done .pi {
  color: var(--mh-success);
}
.plan li.in_progress .pi {
  color: var(--mh-accent);
}
.info {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0;
}
.info dt {
  color: var(--mh-muted);
}
.info dd {
  margin: 0;
}
.error-text {
  color: var(--mh-danger);
  margin: 0;
}
.perm {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 340px;
  font-size: 13px;
}
</style>
