<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import { api } from '../../api.ts';
import { store } from '../../stores/app.ts';

const { t } = useI18n();
const report = computed(() => store.loopReports[0] ?? null);

async function resolve(decision: 'stop' | 'continue') {
  const r = store.loopReports.shift();
  if (r) await api.call('loop.resolve', { conversationId: r.conversationId, decision }).catch(() => undefined);
}
</script>

<template>
  <Dialog :visible="report !== null" modal :closable="false" :header="t('loop.title')" :style="{ width: 'min(620px, 92vw)' }">
    <div v-if="report">
      <p>{{ t('loop.lead', { title: store.conversations.get(report.conversationId)?.title ?? '' }) }}</p>
      <ul class="calls">
        <li v-for="(c, i) in report.calls" :key="i">
          <strong>{{ c.name }}</strong> × {{ c.count }}
          <pre>{{ c.arguments }}</pre>
        </li>
      </ul>
      <p class="mh-hint">{{ t('loop.hint') }}</p>
    </div>
    <template #footer>
      <Button :label="t('loop.continue')" severity="secondary" outlined @click="resolve('continue')" />
      <Button :label="t('loop.stop')" icon="pi pi-stop-circle" severity="danger" @click="resolve('stop')" />
    </template>
  </Dialog>
</template>

<style scoped>
.calls {
  list-style: none;
  padding: 0;
}
.calls pre {
  margin: 4px 0 0;
  background: var(--mh-code-bg);
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
</style>
