<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Select from 'primevue/select';
import ProgressBar from 'primevue/progressbar';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { APP_VERSION, UPDATE_REPOSITORY, type CapabilityId, type Settings, type UpdateState } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';
import logo from '../../assets/logo.png';

const props = defineProps<{ draft: Settings }>();
const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 8000 });

// ---------- Mises à jour ----------
const update = ref<UpdateState | null>(null);
const modeOptions = computed(() => (['off', 'notify', 'auto'] as const).map((v) => ({ label: t(`settings.about.updates.modes.${v}`), value: v })));
const statusText = computed(() => {
  const u = update.value;
  if (!u) return '';
  return t(`settings.about.updates.status.${u.status}`, { current: u.current, version: u.release?.version ?? '', percent: Math.round((u.progress ?? 0) * 100), error: u.error ?? '' });
});
let off: (() => void) | null = null;
onMounted(async () => {
  off = api.on('updates.changed', (s) => (update.value = s));
  update.value = await api.call('updates.status').catch(() => null);
});
onUnmounted(() => off?.());
async function run(method: 'updates.check' | 'updates.download') {
  try {
    update.value = await api.call(method);
  } catch (e) {
    fail(e);
  }
}
function install() {
  const version = update.value?.release?.version ?? '';
  confirm.require({
    header: t('settings.about.updates.install'),
    message: t('settings.about.updates.installConfirm', { version }),
    icon: 'pi pi-refresh',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('settings.about.updates.install') },
    accept: async () => {
      try {
        update.value = await api.call('updates.install');
      } catch (e) {
        fail(e);
      }
    },
  });
}

const caps = computed(() => (store.info ? (Object.entries(store.info.capabilities) as [CapabilityId, (typeof store.info.capabilities)[CapabilityId]][]) : []));
const severity = (state: string) => (state === 'available' ? 'success' : state === 'planned' ? 'secondary' : 'warn');
</script>

<template>
  <div class="head">
    <img :src="logo" alt="" width="56" height="56" />
    <div>
      <div class="name">Monolith Harness</div>
      <div class="mh-muted">{{ t('settings.about.version') }} {{ APP_VERSION }}</div>
    </div>
    <Button :label="t('settings.about.changelog')" icon="pi pi-list" size="small" severity="secondary" outlined class="push" @click="uiState.changelogOpen = true" />
  </div>
  <p>{{ t('settings.about.license') }}</p>
  <p class="mh-hint">{{ t('settings.about.network') }}</p>

  <dl v-if="store.info" class="facts">
    <dt>{{ t('settings.about.data') }}</dt>
    <dd><code>{{ store.info.dataDir }}</code></dd>
    <dt>{{ t('settings.about.database') }}</dt>
    <dd><code>{{ store.info.databasePath }}</code> — {{ t('settings.about.schema', { version: store.info.schemaVersion }) }}</dd>
    <dt>{{ t('settings.about.runtime') }}</dt>
    <dd>{{ store.info.platform }} {{ store.info.arch }} · Node {{ store.info.nodeVersion }} · SQLite {{ store.info.sqliteVersion }}</dd>
  </dl>

  <h3 class="mh-section-title">{{ t('settings.about.updates.title') }}</h3>
  <p class="mh-hint">{{ t('settings.about.updates.hint', { repo: UPDATE_REPOSITORY }) }}</p>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="upd-mode">{{ t('settings.about.updates.mode') }}</label>
      <Select input-id="upd-mode" :aria-label="t('settings.about.updates.mode')" v-model="props.draft.updates.mode" :options="modeOptions" option-label="label" option-value="value" />
    </div>
    <Button :label="t('settings.about.updates.check')" icon="pi pi-sync" size="small" severity="secondary" outlined :loading="update?.status === 'checking'" @click="run('updates.check')" />
  </div>
  <div v-if="update" class="update" aria-live="polite">
    <p>{{ statusText }}</p>
    <ProgressBar v-if="update.status === 'downloading'" :value="Math.round((update.progress ?? 0) * 100)" class="bar" />
    <p v-if="update.checkedAt" class="mh-hint">{{ t('settings.about.updates.checkedAt', { date: new Date(update.checkedAt).toLocaleString() }) }}</p>
    <p v-if="update.release && !update.installable" class="mh-hint warn">{{ t('settings.about.updates.notInstallable', { reason: update.installReason ?? '' }) }}</p>
    <p v-if="update.lastResult" class="mh-hint" :class="{ warn: !update.lastResult.ok }">{{ t('settings.about.updates.last', { message: update.lastResult.message }) }}</p>
    <div v-if="update.release" class="mh-row wrap">
      <Button v-if="update.installable && update.status === 'available'" :label="t('settings.about.updates.download')" icon="pi pi-download" size="small" @click="run('updates.download')" />
      <Button v-if="update.installable && update.status === 'ready'" :label="t('settings.about.updates.install')" icon="pi pi-refresh" size="small" @click="install" />
      <Button :label="t('settings.about.updates.page')" icon="pi pi-external-link" size="small" severity="secondary" text @click="host.openExternal(update.release.url)" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.about.capabilities') }}</h3>
  <table class="caps">
    <tbody>
      <tr v-for="[id, cap] in caps" :key="id">
        <td><code>{{ id }}</code></td>
        <td><Tag :severity="severity(cap.state)" :value="t(`settings.about.states.${cap.state}`)" /></td>
        <td class="mh-muted">{{ cap.backend ? `${cap.backend} — ` : '' }}{{ cap.reason ?? '' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
}
.head img {
  border-radius: 12px;
}
.name {
  font-size: 18px;
  font-weight: 650;
}
.push {
  margin-left: auto;
}
.wrap {
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.update p {
  margin: 6px 0;
}
.bar {
  height: 6px;
  max-width: 420px;
}
.warn {
  color: var(--mh-warning);
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 16px 0;
}
.facts dt {
  font-weight: 600;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
code {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.caps {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
.caps td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--mh-border);
  vertical-align: top;
}
</style>
