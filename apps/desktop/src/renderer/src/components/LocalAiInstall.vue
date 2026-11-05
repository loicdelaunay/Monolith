<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import ProgressBar from 'primevue/progressbar';
import type { LocalAiComponent, LocalAiProgress, LocalAiStatus } from '@monolith/contracts';
import { api, errorMessage, host } from '../api.ts';

/** Installation d'un composant d'IA locale (téléchargement vérifié ou fichiers du poste), avec progression et erreurs. */
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
const counting = computed(() => progress.value?.stage === 'download' || progress.value?.stage === 'copy');
/** Modèle d'embeddings du RAG : remplaçable par des fichiers du poste. */
const fromDisk = computed(() => props.component === 'minilm');
const failedDownload = ref(false);
const copied = ref<string | null>(null);

const offs: (() => void)[] = [];
onMounted(async () => {
  status.value = await api.call('localai.status');
  if (status.value.busy?.component === props.component) progress.value = status.value.busy;
  offs.push(
    api.on('localai.changed', (s) => (status.value = s)),
    api.on('localai.progress', (p) => {
      if (p.component !== props.component) return;
      const previous = progress.value?.stage;
      progress.value = p;
      if (p.stage === 'error') {
        error.value = p.message;
        failedDownload.value = previous === 'download';
      }
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
async function installFromDisk() {
  const paths = await host.pickFiles(t('localAi.pickTitle'));
  if (!paths.length) return;
  error.value = null;
  try {
    status.value = await api.call('localai.installFrom', { component: props.component, paths });
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function cancel() {
  void api.call('localai.cancel');
}
async function copyLink(url: string) {
  await navigator.clipboard.writeText(url);
  copied.value = url;
  setTimeout(() => (copied.value = null), 1200);
}
const stageText = computed(() => (progress.value ? t(`localAi.stages.${progress.value.stage}`) : ''));
</script>

<template>
  <div class="lai">
    <template v-if="status && !status.supported">
      <p class="mh-hint warn">{{ status.unsupportedReason }}</p>
    </template>
    <template v-else-if="info?.installed && !busy">
      <span class="ok"><i class="pi pi-check-circle" /> {{ info.custom ? t('localAi.installedCustom', { name: info.custom }) : t('localAi.installed', { version: info.version }) }}</span>
      <div class="actions">
        <Button v-if="useLabel" :label="useLabel" icon="pi pi-check" size="small" @click="emit('use')" />
        <Button v-if="fromDisk" :label="t('localAi.changeModel')" icon="pi pi-folder-open" size="small" severity="secondary" text :disabled="otherBusy" @click="installFromDisk" />
        <Button v-if="info.custom" :label="t('localAi.downloadOfficial')" icon="pi pi-download" size="small" severity="secondary" text :disabled="otherBusy" @click="install" />
      </div>
    </template>
    <template v-else>
      <div v-if="!busy" class="actions">
        <Button :label="label ?? t(status?.runtime.installed ? 'localAi.download' : 'localAi.downloadWithRuntime', { size: sizeMb })" icon="pi pi-download" size="small" :disabled="otherBusy" @click="install" />
        <Button v-if="fromDisk" :label="t('localAi.useLocalFile')" icon="pi pi-folder-open" size="small" severity="secondary" outlined :disabled="otherBusy" @click="installFromDisk" />
      </div>
      <div v-if="busy && mine" class="prog" aria-live="polite">
        <span class="mh-hint">{{ stageText }}<template v-if="counting"> — {{ percent }} %</template></span>
        <ProgressBar :value="counting ? percent : undefined" :mode="counting ? 'determinate' : 'indeterminate'" class="bar" />
        <Button :label="t('common.cancel')" size="small" severity="secondary" text @click="cancel" />
      </div>
      <p v-if="otherBusy" class="mh-hint">{{ t('localAi.otherBusy') }}</p>
      <details v-if="fromDisk && !busy" class="manual" :open="failedDownload">
        <summary>{{ t('localAi.manualTitle') }}</summary>
        <p class="mh-hint">{{ t('localAi.manualHint') }}</p>
        <ul>
          <li v-for="f in info?.files" :key="f.path">
            <code>{{ f.path }}</code>
            <span class="mh-hint">{{ Math.round(f.bytes / 1048576) }} Mo</span>
            <button type="button" class="mh-icon-btn" :aria-label="t('localAi.copyLink', { name: f.path })" v-tooltip.top="t('localAi.copyLink', { name: f.path })" @click="copyLink(f.url)"><i class="pi" :class="copied === f.url ? 'pi-check' : 'pi-copy'" /></button>
          </li>
        </ul>
        <p class="mh-hint">{{ t('localAi.manualOther') }}</p>
      </details>
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
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.manual {
  width: 100%;
  font-size: 13px;
}
.manual summary {
  color: var(--mh-muted);
  cursor: pointer;
}
.manual ul {
  margin: 6px 0;
  padding: 0;
  list-style: none;
}
.manual li {
  display: flex;
  align-items: center;
  gap: 8px;
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
