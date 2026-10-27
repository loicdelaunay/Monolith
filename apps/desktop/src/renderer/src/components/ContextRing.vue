<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ContextUsage } from '@monolith/contracts';
import { formatTokens } from '../lib/format.ts';

const props = defineProps<{ usage: ContextUsage }>();
const { t } = useI18n();

const R = 8;
const CIRC = 2 * Math.PI * R;
const ratio = computed(() => (props.usage.contextWindow ? Math.min(1, props.usage.tokens / props.usage.contextWindow) : null));
const percent = computed(() => (ratio.value === null ? null : Math.round(ratio.value * 100)));
const level = computed(() => (percent.value === null ? 'unknown' : percent.value >= 95 ? 'danger' : percent.value >= 80 ? 'warn' : 'ok'));
const label = computed(() =>
  percent.value === null
    ? t('composer.context.ariaUnknown', { used: formatTokens(props.usage.tokens) })
    : t('composer.context.aria', { used: formatTokens(props.usage.tokens), window: formatTokens(props.usage.contextWindow!), percent: percent.value }),
);
</script>

<template>
  <span class="ctx">
    <button type="button" class="ring" :class="level" :aria-label="label" aria-describedby="mh-ctx-card">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle class="track" cx="11" cy="11" :r="R" />
        <circle v-if="ratio !== null" class="bar" cx="11" cy="11" :r="R" :stroke-dasharray="`${Math.max(ratio * CIRC, ratio > 0 ? 1.2 : 0)} ${CIRC}`" transform="rotate(-90 11 11)" />
      </svg>
    </button>
    <!-- Détail au survol ou au focus du clavier. -->
    <div id="mh-ctx-card" class="card" role="tooltip">
      <div class="head">
        <strong>{{ t('composer.context.title') }}</strong>
        <span v-if="percent !== null" class="pct" :class="level">{{ percent }} %</span>
      </div>
      <div class="meter" aria-hidden="true"><span :class="level" :style="{ width: `${(ratio ?? 0) * 100}%` }" /></div>
      <dl>
        <dt>{{ t('composer.context.used') }}</dt>
        <dd>{{ formatTokens(usage.tokens) }}<template v-if="usage.source === 'estimate'">*</template></dd>
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
        <template v-if="usage.compactions">
          <dt>{{ t('composer.context.compactions') }}</dt>
          <dd>{{ usage.compactions }}</dd>
        </template>
      </dl>
      <p class="src">{{ usage.source === 'estimate' ? t('chat.estimatedHint') : t('composer.context.sourceApi') }}</p>
    </div>
  </span>
</template>

<style scoped>
.ctx {
  position: relative;
  display: inline-flex;
}
.ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: default;
}
.ring:hover {
  background: var(--mh-hover);
}
.track {
  fill: none;
  stroke: color-mix(in srgb, var(--mh-muted) 35%, transparent);
  stroke-width: 2.6;
}
.ring.unknown .track {
  stroke-dasharray: 2 3;
}
.bar {
  fill: none;
  stroke: var(--mh-accent);
  stroke-width: 2.6;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.ring.warn .bar {
  stroke: var(--mh-warning);
}
.ring.danger .bar {
  stroke: var(--mh-danger);
}
.card {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  translate: -50% 4px;
  z-index: 20;
  width: 240px;
  padding: 10px 12px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: var(--mh-elevated);
  box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
  color: var(--mh-text);
  font-size: 12.5px;
  text-align: left;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.12s ease,
    translate 0.12s ease,
    visibility 0.12s;
}
.ctx:hover .card,
.ctx:focus-within .card {
  opacity: 1;
  visibility: visible;
  translate: -50% 0;
  transition-delay: 0.12s;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}
.pct {
  font-variant-numeric: tabular-nums;
  color: var(--mh-accent);
}
.pct.warn {
  color: var(--mh-warning);
}
.pct.danger {
  color: var(--mh-danger);
}
.meter {
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--mh-muted) 25%, transparent);
  overflow: hidden;
  margin-bottom: 8px;
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
  background: var(--mh-danger);
}
dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 3px 12px;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
dt {
  color: var(--mh-muted);
}
dd {
  margin: 0;
  text-align: right;
}
.src {
  margin: 8px 0 0;
  color: var(--mh-muted);
  font-size: 11.5px;
  line-height: 1.35;
}
@media (prefers-reduced-motion: reduce) {
  .card,
  .bar {
    transition: none;
  }
}
</style>
