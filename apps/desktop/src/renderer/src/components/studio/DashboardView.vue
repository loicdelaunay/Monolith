<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { DashboardData, DashboardQuery, Id, UsageRecord } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { formatTokens } from '../../lib/format.ts';

const { t, locale } = useI18n();
const toast = useToast();
const filters = reactive({ days: 30, providerId: null as Id | null, kind: null as UsageRecord['kind'] | null });
const data = ref<DashboardData | null>(null);
const hover = ref<number | null>(null);

const query = computed<DashboardQuery>(() => {
  const to = new Date().toISOString().slice(0, 10);
  return { from: new Date(Date.now() - (filters.days - 1) * 86_400_000).toISOString().slice(0, 10), to, providerId: filters.providerId, kind: filters.kind };
});
async function load() {
  data.value = await api.call('dashboard.data', query.value).catch((e) => (toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 }), null));
}
onMounted(load);
watch(query, load);

async function exportCsv() {
  const csv = await api.call('dashboard.csv', query.value);
  await host.saveTextFile(`monolith-consommation-${query.value.from}-${query.value.to}.csv`, csv, [{ name: 'CSV', extensions: ['csv'] }]);
}

const periodOptions = computed(() => [7, 30, 90, 365].map((d) => ({ value: d, label: t(`dashboard.periods.${d}`) })));
const providerOptions = computed(() => [{ value: null, label: t('dashboard.allProviders') }, ...(data.value?.providers ?? []).map((p) => ({ value: p.id, label: p.name }))]);
const KINDS: UsageRecord['kind'][] = ['chat', 'naming', 'compaction', 'memory', 'vision', 'subagent', 'benchmark', 'tool', 'test', 'other'];
const kindOptions = computed(() => [{ value: null, label: t('dashboard.allKinds') }, ...KINDS.map((k) => ({ value: k, label: t(`dashboard.kinds.${k}`) }))]);

// Histogramme empilé (entrée / sortie) par jour, en SVG.
const W = 720;
const H = 180;
const bars = computed(() => {
  const days = data.value?.byDay ?? [];
  const max = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  const bw = W / Math.max(1, days.length);
  return days.map((d, i) => {
    const hi = ((d.inputTokens) / max) * (H - 16);
    const ho = ((d.outputTokens) / max) * (H - 16);
    return { i, x: i * bw + bw * 0.12, w: Math.max(1, bw * 0.76), hi, ho, d };
  });
});
const peak = computed(() => Math.max(0, ...(data.value?.byDay ?? []).map((d) => d.inputTokens + d.outputTokens)));
const dayLabel = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString(locale.value, { day: 'numeric', month: 'short' });
</script>

<template>
  <div class="dash">
    <div class="mh-row wrap bar">
      <Select v-model="filters.days" :options="periodOptions" option-label="label" option-value="value" size="small" :aria-label="t('dashboard.period')" />
      <Select v-model="filters.providerId" :options="providerOptions" option-label="label" option-value="value" size="small" :placeholder="t('dashboard.allProviders')" />
      <Select v-model="filters.kind" :options="kindOptions" option-label="label" option-value="value" size="small" :placeholder="t('dashboard.allKinds')" />
      <span class="grow" />
      <Button :label="t('dashboard.exportCsv')" icon="pi pi-download" size="small" severity="secondary" outlined :disabled="!data?.totals.requests" @click="exportCsv" />
    </div>
    <template v-if="data">
      <div class="cards">
        <div class="card"><span class="mh-hint">{{ t('dashboard.requests') }}</span><strong>{{ data.totals.requests }}</strong></div>
        <div class="card"><span class="mh-hint">{{ t('dashboard.input') }}</span><strong>{{ formatTokens(data.totals.inputTokens) }}</strong><span class="mh-hint">{{ t('dashboard.cached') }} {{ formatTokens(data.totals.cachedInputTokens) }}</span></div>
        <div class="card"><span class="mh-hint">{{ t('dashboard.output') }}</span><strong>{{ formatTokens(data.totals.outputTokens) }}</strong><span class="mh-hint">{{ t('dashboard.reasoning') }} {{ formatTokens(data.totals.reasoningTokens) }}</span></div>
        <div class="card"><span class="mh-hint">{{ t('dashboard.ttft') }}</span><strong>{{ data.totals.avgFirstTokenMs === null ? '—' : `${data.totals.avgFirstTokenMs} ms` }}</strong></div>
        <div class="card"><span class="mh-hint">{{ t('dashboard.errors') }}</span><strong>{{ data.totals.errors }}</strong><span class="mh-hint">{{ t('dashboard.estimated') }} {{ data.totals.estimated }}</span></div>
      </div>
      <p v-if="!data.totals.requests" class="mh-muted">{{ t('dashboard.empty') }}</p>
      <figure v-else class="chart">
        <figcaption class="mh-label">{{ t('dashboard.perDay') }} <span class="mh-hint">(max {{ formatTokens(peak) }})</span></figcaption>
        <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="t('dashboard.perDay')" preserveAspectRatio="none" @mouseleave="hover = null">
          <g v-for="b in bars" :key="b.i" @mouseenter="hover = b.i">
            <rect :x="b.x" :y="H - b.hi - b.ho" :width="b.w" :height="b.ho" class="out" />
            <rect :x="b.x" :y="H - b.hi" :width="b.w" :height="b.hi" class="in" />
            <rect :x="b.x" y="0" :width="b.w" :height="H" fill="transparent" />
          </g>
        </svg>
        <div class="legend">
          <span><i class="sw in" /> {{ t('dashboard.input') }}</span>
          <span><i class="sw out" /> {{ t('dashboard.output') }}</span>
          <span v-if="hover !== null && bars[hover]" class="tip">{{ dayLabel(bars[hover]!.d.key) }} : {{ bars[hover]!.d.requests }} {{ t('dashboard.requests').toLowerCase() }}, {{ formatTokens(bars[hover]!.d.inputTokens) }} / {{ formatTokens(bars[hover]!.d.outputTokens) }}</span>
        </div>
      </figure>
      <div class="tables">
        <table v-for="[title, rows] in [[t('dashboard.byModel'), data.byModel], [t('dashboard.byKind'), data.byKind]] as const" :key="title" class="table">
          <caption>{{ title }}</caption>
          <thead><tr><th /><th>{{ t('dashboard.requests') }}</th><th>{{ t('dashboard.input') }}</th><th>{{ t('dashboard.output') }}</th><th>{{ t('dashboard.errors') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.key"><td>{{ title === t('dashboard.byKind') ? t(`dashboard.kinds.${r.key}`) : r.key }}</td><td>{{ r.requests }}</td><td>{{ formatTokens(r.inputTokens) }}</td><td>{{ formatTokens(r.outputTokens) }}</td><td>{{ r.errors }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bar {
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}
.card {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card strong {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.chart {
  margin: 0;
}
.chart svg {
  width: 100%;
  height: 180px;
  display: block;
}
.in {
  fill: var(--mh-accent);
}
.out {
  fill: color-mix(in srgb, var(--mh-accent) 45%, var(--mh-surface));
}
.legend {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--mh-muted);
  margin-top: 4px;
  flex-wrap: wrap;
}
.sw {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  vertical-align: middle;
}
.sw.in {
  background: var(--mh-accent);
}
.sw.out {
  background: color-mix(in srgb, var(--mh-accent) 45%, var(--mh-surface));
}
.tip {
  color: var(--mh-text);
}
.tables {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.table caption {
  text-align: left;
  font-weight: 600;
  padding: 4px 0;
}
.table th,
.table td {
  border-bottom: 1px solid var(--mh-border);
  padding: 4px 6px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.table th:first-child,
.table td:first-child {
  text-align: left;
}
</style>
