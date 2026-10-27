<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import ProgressBar from 'primevue/progressbar';
import type { LocalAiComponent, LocalAiProgress, LocalAiStatus } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';

/** Installation d'un composant d'IA locale (téléchargement vérifié), avec progression et erreurs. */
const props = defineProps<{ component: LocalAiComponent; label?: string; useLabel?: string }>();
const emit = defineEmits<{ installed: []; use: [] }>();
const { t } = useI18n();

const status = ref<LocalAiStatus | null>(null);
const progress = ref<LocalAiProgress | null>(null);
const error = ref<string | null>(null);
const info = computed(() => status.value?.components.find((c) => c.id === props.component) ?? null);
const mine = computed(() => progress.value?.component === props.component);
const busy = computed(() => !!status.value?.busy && status.value.busy.component === props.component && status.value.busy.stage !== 'ready' && status.value.busy.stage !== 'error');
const otherBusy = computed(() => !!status.value?.busy && status.value.busy.component !== props.component);
const percent = computed(() => (progress.value && progress.value.total ? Math.round((progress.value.received / progress.value.total) * 100) : 0));
const sizeMb = computed(() => Math.round((info.value?.bytes ?? 0) / 1048576));

const offs: (() => void)[] = [];
onMounted(async () => {
  status.value = await api.call('localai.status');
  if (status.value.busy?.component === props.component) progress.value = status.value.busy;
  offs.push(
    api.on('localai.changed', (s) => (status.value = s)),
    api.on('localai.progress', (p) => {
      if (p.component !== props.component) return;
      progress.value = p;
      if (p.stage === 'error') error.value = p.message;
      if (p.stage === 'ready') {
        error.value = null;
        void api.call('localai.status').then((s) => (status.value = s));
        emit('installed');
      }
    }),
  );
});
onUnmounted(() => offs.forEach((f) => f()));

async function install() {
  error.value = null;
  try {
    status.value = await api.call('localai.install', { component: props.component });
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function cancel() {
  void api.call('localai.cancel');
}
const stageText = computed(() => (progress.value ? t(`localAi.stages.${progress.value.stage}`) : ''));
</script>

<template>
  <div class="lai">
    <template v-if="status && !status.supported">
      <p class="mh-hint warn">{{ status.unsupportedReason }}</p>
    </template>
    <template v-else-if="info?.installed && !busy">
      <span class="ok"><i class="pi pi-check-circle" /> {{ t('localAi.installed', { version: info.version }) }}</span>
      <Button v-if="useLabel" :label="useLabel" icon="pi pi-check" size="small" @click="emit('use')" />
    </template>
    <template v-else>
      <Button v-if="!busy" :label="label ?? t(status?.runtime.installed ? 'localAi.download' : 'localAi.downloadWithRuntime', { size: sizeMb })" icon="pi pi-download" size="small" :disabled="otherBusy" @click="install" />
      <div v-if="busy && mine" class="prog" aria-live="polite">
        <span class="mh-hint">{{ stageText }}<template v-if="progress?.stage === 'download'"> — {{ percent }} %</template></span>
        <ProgressBar :value="progress?.stage === 'download' ? percent : undefined" :mode="progress?.stage === 'download' ? 'determinate' : 'indeterminate'" class="bar" />
        <Button :label="t('common.cancel')" size="small" severity="secondary" text @click="cancel" />
      </div>
      <p v-if="otherBusy" class="mh-hint">{{ t('localAi.otherBusy') }}</p>
    </template>
    <p v-if="error" class="mh-hint warn" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.lai {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.ok {
  color: var(--mh-success);
  font-size: 13px;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.prog {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: min(360px, 100%);
}
.bar {
  height: 6px;
}
.warn {
  color: var(--mh-warning);
}
</style>
