<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ContextDetail, Id } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { messagesOf, store } from '../../stores/app.ts';
import { formatDuration, formatTokens, throughput } from '../../lib/format.ts';

/**
 * AI Info : contexte de la prochaine requête détaillé par poste (estimations) et vitesses de la
 * conversation (minimum, moyenne, maximum, dernière), premier token et tokens consommés.
 */
const props = defineProps<{ conversationId: Id }>();
const { t } = useI18n();
const detail = ref<ContextDetail | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

async function refresh() {
  loading.value = true;
  try {
    detail.value = await api.call('conversations.contextDetail', { id: props.conversationId });
    error.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

const messages = messagesOf(props.conversationId);
const generating = computed(() => store.generations.has(props.conversationId));
// Rafraîchi à l'ouverture, à la fin de chaque génération et quand des messages changent.
watch([() => props.conversationId, generating, () => messages.value.length], () => void (generating.value ? undefined : refresh()), { immediate: true });

const usage = computed(() => detail.value?.usage ?? null);
const ratio = computed(() => (usage.value?.contextWindow ? Math.min(1, usage.value.tokens / usage.value.contextWindow) : null));
const parts = computed(() => (detail.value?.parts ?? []).filter((p) => p.tokens > 0 || (p.count ?? 0) > 0));
const share = (n: number) => (detail.value?.estimated ? Math.round((n / detail.value.estimated) * 1000) / 10 : 0);

const replies = computed(() => messages.value.filter((m) => m.role === 'assistant' && m.status !== 'streaming'));
const speeds = computed(() => replies.value.map(throughput).filter((v): v is number => v !== null));
const speed = computed(() => {
  const v = speeds.value;
  if (!v.length) return null;
  return { min: Math.min(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), last: v.at(-1)!, count: v.length };
});
const firstToken = computed(() => {
  const v = replies.value.map((m) => m.firstTokenMs).filter((x): x is number => typeof x === 'number' && x > 0);
  return v.length ? { min: Math.min(...v), avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) } : null;
});
const totals = computed(() =>
  replies.value.reduce(
    (acc, m) => ({ input: acc.input + (m.usage?.inputTokens ?? 0), output: acc.output + (m.usage?.outputTokens ?? 0), cached: acc.cached + (m.usage?.cachedInputTokens ?? 0), estimated: acc.estimated || !!m.usage?.estimated }),
    { input: 0, output: 0, cached: 0, estimated: false },
  ),
);
const tps = (v: number) => t('chat.throughput', { value: v.toFixed(v < 10 ? 1 : 0) });
</script>

<template>
  <div class="ai-info">
    <section>
      <header class="sec-head">
        <h3><i class="pi pi-microchip-ai" /> {{ t('aiInfo.model') }}</h3>
        <button type="button" class="mh-icon-btn small" :aria-label="t('aiInfo.refresh')" v-tooltip.left="t('aiInfo.refresh')" :disabled="loading" @click="refresh"><i class="pi pi-refresh" :class="{ 'pi-spin': loading }" /></button>
      </header>
      <p v-if="error" class="mh-hint warn">{{ error }}</p>
      <dl v-if="detail" class="grid">
        <dt>{{ t('aiInfo.provider') }}</dt>
        <dd>{{ detail.provider ?? '—' }}</dd>
        <dt>{{ t('aiInfo.modelName') }}</dt>
        <dd class="mono">{{ detail.model ?? '—' }}</dd>
        <dt>{{ t('aiInfo.reasoning') }}</dt>
        <dd>{{ detail.reasoningLevel ? t(`reasoningLevels.${detail.reasoningLevel}`) : '—' }}</dd>
      </dl>
    </section>

    <section v-if="usage">
      <h3><i class="pi pi-chart-pie" /> {{ t('aiInfo.context') }}</h3>
      <div class="meter" aria-hidden="true"><span :style="{ width: `${(ratio ?? 0) * 100}%` }" :class="{ warn: (ratio ?? 0) >= 0.8, danger: (ratio ?? 0) >= 0.95 }" /></div>
      <dl class="grid">
        <dt>{{ t('composer.context.used') }}</dt>
        <dd>{{ formatTokens(usage.tokens) }}<template v-if="ratio !== null"> ({{ Math.round(ratio * 100) }} %)</template> · {{ usage.source === 'api' ? t('aiInfo.sourceApi') : t('aiInfo.sourceEstimate') }}</dd>
        <dt>{{ t('composer.context.window') }}</dt>
        <dd>{{ usage.contextWindow ? formatTokens(usage.contextWindow) : t('composer.context.unknown') }}</dd>
        <template v-if="usage.contextWindow">
          <dt>{{ t('composer.context.free') }}</dt>
          <dd>{{ formatTokens(Math.max(0, usage.contextWindow - usage.tokens)) }}</dd>
        </template>
        <template v-if="usage.maxOutputTokens">
          <dt>{{ t('composer.context.maxOutput') }}</dt>
          <dd>{{ formatTokens(usage.maxOutputTokens) }}</dd>
        </template>
        <dt>{{ t('composer.context.compactions') }}</dt>
        <dd>{{ usage.compactions }}</dd>
      </dl>
      <table v-if="parts.length" class="parts">
        <caption class="mh-hint">{{ t('aiInfo.breakdown', { total: formatTokens(detail!.estimated) }) }}</caption>
        <tbody>
          <tr v-for="p in parts" :key="p.key">
            <th scope="row">{{ t(`aiInfo.parts.${p.key}`) }}<span v-if="p.count" class="count"> · {{ p.count }}</span></th>
            <td class="num">{{ formatTokens(p.tokens) }}</td>
            <td class="bar"><span :style="{ width: `${share(p.tokens)}%` }" /></td>
            <td class="num pct">{{ share(p.tokens) }} %</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3><i class="pi pi-gauge" /> {{ t('aiInfo.speed') }}</h3>
      <p v-if="!speed" class="mh-muted">{{ t('aiInfo.noSpeed') }}</p>
      <div v-else class="cards">
        <div class="card"><span class="mh-hint">{{ t('aiInfo.min') }}</span><strong>{{ tps(speed.min) }}</strong></div>
        <div class="card"><span class="mh-hint">{{ t('aiInfo.avg') }}</span><strong>{{ tps(speed.avg) }}</strong></div>
        <div class="card"><span class="mh-hint">{{ t('aiInfo.max') }}</span><strong>{{ tps(speed.max) }}</strong></div>
        <div class="card"><span class="mh-hint">{{ t('aiInfo.last') }}</span><strong>{{ tps(speed.last) }}</strong></div>
      </div>
      <dl class="grid">
        <template v-if="speed">
          <dt>{{ t('aiInfo.replies') }}</dt>
          <dd>{{ speed.count }}</dd>
        </template>
        <template v-if="firstToken">
          <dt>{{ t('aiInfo.firstToken') }}</dt>
          <dd>{{ formatDuration(firstToken.min) }} / {{ formatDuration(firstToken.avg) }} / {{ formatDuration(firstToken.max) }}</dd>
        </template>
        <dt>{{ t('aiInfo.tokensIn') }}</dt>
        <dd>{{ formatTokens(totals.input) }}<template v-if="totals.cached"> ({{ formatTokens(totals.cached) }} {{ t('chat.cached') }})</template></dd>
        <dt>{{ t('aiInfo.tokensOut') }}</dt>
        <dd>{{ formatTokens(totals.output) }}</dd>
      </dl>
      <p class="mh-hint">{{ t('aiInfo.speedHint') }}<template v-if="totals.estimated"> {{ t('chat.estimatedHint') }}</template></p>
    </section>
  </div>
</template>

<style scoped>
.ai-info {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 14px 16px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
  font-size: 13px;
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 14px;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sec-head h3 {
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 8px 0 0;
}
.grid dt {
  color: var(--mh-muted);
}
.grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.meter {
  height: 6px;
  border-radius: 3px;
  background: var(--mh-hover);
  overflow: hidden;
}
.meter span {
  display: block;
  height: 100%;
  background: var(--mh-accent);
}
.meter span.warn {
  background: var(--mh-warning);
}
.meter span.danger {
  background: var(--mh-danger, #d93f3f);
}
.parts {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
}
.parts caption {
  text-align: left;
  padding-bottom: 6px;
}
.parts th {
  text-align: left;
  font-weight: normal;
  padding: 3px 8px 3px 0;
  white-space: nowrap;
}
.parts .count {
  color: var(--mh-muted);
}
.parts td {
  padding: 3px 0;
}
.parts .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding-left: 8px;
}
.parts .pct {
  color: var(--mh-muted);
  width: 52px;
}
.parts .bar {
  width: 40%;
  padding-left: 10px;
}
.parts .bar span {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--mh-accent) 70%, transparent);
  min-width: 2px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
}
.card strong {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
</style>
