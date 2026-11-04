<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Message } from '@monolith/contracts';

/** Erreur d'une réponse : résumé, puis détail complet au clic (fournisseur, adresse, réponse brute), à copier. */
const props = defineProps<{ message: Message }>();
const { t, te } = useI18n();
const error = computed(() => props.message.error!);
const title = computed(() => (te(`errors.${error.value.code}`) ? t(`errors.${error.value.code}`) : t('chat.status.error')));
const open = ref(false);
const copied = ref(false);

const rows = computed(() => {
  const e = error.value;
  const s = props.message.snapshot;
  const list: [string, string][] = [[t('chat.errorInfo.code'), e.code]];
  if (e.status) list.push([t('chat.errorInfo.status'), String(e.status)]);
  if (s) list.push([t('chat.errorInfo.model'), `${s.providerName} · ${s.model}`]);
  if (e.endpoint) list.push([t('chat.errorInfo.endpoint'), e.endpoint]);
  if (e.attempts) list.push([t('chat.errorInfo.attempts'), String(e.attempts)]);
  if (e.at) list.push([t('chat.errorInfo.at'), new Date(e.at).toLocaleString()]);
  return list;
});
/** Réponse du fournisseur, indentée si c'est du JSON. */
const body = computed(() => {
  const raw = error.value.body ?? '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
async function copy() {
  const lines = [`${title.value} — ${error.value.message}`, ...rows.value.map(([k, v]) => `${k} : ${v}`), ...(body.value ? ['', body.value] : [])];
  await navigator.clipboard.writeText(lines.join('\n'));
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <div class="error" role="alert">
    <i class="pi pi-times-circle" />
    <div class="main">
      <strong>{{ title }}</strong>
      <span v-if="error.status"> (HTTP {{ error.status }})</span>
      <div class="error-detail">{{ error.message }}</div>
      <div v-if="error.attempts && error.attempts > 1" class="mh-hint">{{ t('chat.attempts', { count: error.attempts }) }}</div>
      <button type="button" class="more" :aria-expanded="open" @click="open = !open">
        <i class="pi" :class="open ? 'pi-angle-down' : 'pi-angle-right'" />
        {{ t('chat.errorDetails') }}
      </button>
      <div v-if="open" class="details">
        <dl>
          <template v-for="[label, value] in rows" :key="label">
            <dt>{{ label }}</dt>
            <dd>{{ value }}</dd>
          </template>
        </dl>
        <pre v-if="body">{{ body }}</pre>
        <p v-else class="mh-hint">{{ t('chat.errorNoBody') }}</p>
        <button type="button" class="mh-pill" @click="copy"><i class="pi" :class="copied ? 'pi-check' : 'pi-copy'" /> {{ copied ? t('common.copied') : t('chat.errorCopy') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.error {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--mh-danger) 40%, var(--mh-border));
  background: color-mix(in srgb, var(--mh-danger) 8%, transparent);
  border-radius: var(--mh-radius);
  font-size: 13.5px;
}
.error > .pi {
  color: var(--mh-danger);
  margin-top: 2px;
}
.main {
  flex: 1;
  min-width: 0;
}
.error-detail {
  color: var(--mh-muted);
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mh-muted);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.more:hover {
  color: var(--mh-text);
}
.more .pi {
  font-size: 11px;
}
.details {
  margin-top: 8px;
}
dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 12px;
  margin: 0 0 8px;
  font-size: 12.5px;
}
dt {
  color: var(--mh-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
pre {
  max-height: 260px;
  margin: 0 0 8px;
  padding: 8px 10px;
  overflow: auto;
  border-radius: var(--mh-radius-sm);
  background: var(--mh-surface);
  font-family: var(--mh-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
