<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import InputNumber from 'primevue/inputnumber';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { BackupInfo, DiagnosticsInfo, Settings } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import type { GpuInfo, LaunchSettingsInfo } from '../../../../shared/bridge.ts';
import { formatSize } from '../../lib/attachments.ts';

defineProps<{ draft: Settings }>();
const { t, locale } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 7000 });

// ---------- Rendu ----------
const launch = reactive<LaunchSettingsInfo>({ hardwareAcceleration: true, angle: 'default', vsync: true });
const applied = ref<LaunchSettingsInfo | null>(null);
const gpu = ref<GpuInfo | null>(null);
const launchDirty = ref(false);
const angles = (['default', 'd3d11', 'd3d9', 'gl', 'vulkan', 'swiftshader'] as const).map((v) => ({ value: v, label: t(`settings.advancedSettings.angles.${v}`) }));
async function saveLaunch() {
  const r = await host.launch({ ...launch });
  if (r) {
    Object.assign(launch, r.saved);
    launchDirty.value = JSON.stringify(r.saved) !== JSON.stringify(applied.value);
    toast.add({ severity: 'info', summary: t('settings.advancedSettings.saved'), life: 3000 });
  }
}

// ---------- Diagnostics ----------
const diag = ref<DiagnosticsInfo | null>(null);
const processes = ref<Awaited<ReturnType<typeof host.metrics>>>([]);
async function refresh() {
  [diag.value, processes.value, gpu.value] = await Promise.all([api.call('diagnostics.info').catch((e) => (fail(e), null)), host.metrics().catch(() => []), host.gpuInfo().catch(() => null)]);
}
async function exportDiag() {
  try {
    const text = await api.call('diagnostics.export', { extra: { gpu: gpu.value, processes: processes.value } });
    await host.saveTextFile(`monolith-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, text, [{ name: 'JSON', extensions: ['json'] }]);
  } catch (e) {
    fail(e);
  }
}

// ---------- Sauvegardes ----------
const backups = ref<BackupInfo[]>([]);
const loadBackups = async () => (backups.value = await api.call('backup.list').catch(() => []));
async function createBackup() {
  try {
    await api.call('backup.create');
    await loadBackups();
  } catch (e) {
    fail(e);
  }
}
function restore(b: BackupInfo) {
  confirm.require({
    header: t('settings.advancedSettings.backupRestoreTitle', { name: b.name }),
    message: t('settings.advancedSettings.backupRestoreMessage'),
    icon: 'pi pi-history',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('settings.advancedSettings.restart'), severity: 'warn' },
    accept: async () => {
      try {
        await api.call('backup.restore', { name: b.name });
        await host.relaunch();
      } catch (e) {
        fail(e);
      }
    },
  });
}
async function show(b: BackupInfo) {
  await host.showItemInFolder(await api.call('backup.path', { name: b.name }));
}
async function runMaintenance() {
  try {
    const r = await api.call('maintenance.run');
    toast.add({ severity: 'success', summary: t('settings.advancedSettings.maintenanceDone', { ...r }), life: 4000 });
  } catch (e) {
    fail(e);
  }
}

onMounted(async () => {
  const r = await host.launch();
  if (r) {
    Object.assign(launch, r.saved);
    applied.value = r.applied;
    launchDirty.value = JSON.stringify(r.saved) !== JSON.stringify(r.applied);
  }
  await Promise.all([refresh(), loadBackups()]);
});
const date = (iso: string) => new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<template>
  <h3 class="mh-section-title first">{{ t('settings.advancedSettings.gpu') }}</h3>
  <p class="mh-hint">{{ t('settings.advancedSettings.gpuHint') }}</p>
  <div class="mh-switch-row">
    <label for="adv-hw">{{ t('settings.advancedSettings.hardware') }}</label>
    <ToggleSwitch input-id="adv-hw" v-model="launch.hardwareAcceleration" @update:model-value="saveLaunch" />
  </div>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="adv-angle">{{ t('settings.advancedSettings.angle') }}</label>
      <Select input-id="adv-angle" v-model="launch.angle" :options="angles" option-label="label" option-value="value" :disabled="!launch.hardwareAcceleration" @update:model-value="saveLaunch" />
    </div>
  </div>
  <div class="mh-switch-row">
    <label for="adv-vsync">{{ t('settings.advancedSettings.vsync') }}</label>
    <ToggleSwitch input-id="adv-vsync" v-model="launch.vsync" @update:model-value="saveLaunch" />
  </div>
  <Message v-if="launchDirty" severity="info" size="small">
    {{ t('settings.advancedSettings.saved') }}
    <Button :label="t('settings.advancedSettings.restart')" size="small" text @click="host.relaunch()" />
  </Message>
  <details v-if="gpu" class="box">
    <summary>{{ t('settings.advancedSettings.actual') }}</summary>
    <ul class="kv">
      <li>{{ t('settings.advancedSettings.hardware') }} : <strong>{{ gpu.hardwareAcceleration ? '✓' : '✗' }}</strong></li>
      <li>{{ t('settings.advancedSettings.angle') }} : <strong>{{ gpu.angle }}</strong></li>
      <li>{{ t('settings.advancedSettings.vsync') }} : <strong>{{ gpu.vsyncDisabled ? '✗' : '✓' }}</strong></li>
      <li>GL : <strong>{{ gpu.glRenderer ?? '—' }}</strong></li>
      <li>{{ gpu.displayHz }} Hz · ×{{ gpu.scaleFactor }} · Electron {{ gpu.versions.electron }} · Chromium {{ gpu.versions.chrome }}</li>
      <li v-for="(v, k) in gpu.featureStatus" :key="k" class="mh-hint">{{ k }} : {{ v }}</li>
    </ul>
  </details>

  <h3 class="mh-section-title">{{ t('settings.advancedSettings.diagnostics') }}</h3>
  <div class="mh-row wrap">
    <Button :label="t('settings.advancedSettings.refresh')" icon="pi pi-refresh" size="small" severity="secondary" outlined @click="refresh" />
    <Button :label="t('settings.advancedSettings.export')" icon="pi pi-download" size="small" severity="secondary" outlined @click="exportDiag" />
  </div>
  <template v-if="diag">
    <ul class="kv">
      <li>{{ diag.app.version }} · {{ diag.app.platform }} {{ diag.app.arch }} · Node {{ diag.app.node }} · schéma v{{ diag.app.schemaVersion }}{{ diag.app.portable ? ' · portable' : '' }}</li>
      <li class="mh-hint">{{ diag.app.dataDir }}</li>
    </ul>
    <div class="grid">
      <div>
        <div class="mh-label">{{ t('settings.advancedSettings.processes') }}</div>
        <ul class="kv">
          <li>moteur : {{ diag.engine.rssMb }} Mo · {{ diag.engine.cpuPercent }} % CPU · {{ Math.round(diag.engine.uptimeSec / 60) }} min</li>
          <li v-for="p in processes" :key="p.pid">{{ p.type }}{{ p.name ? ` (${p.name})` : '' }} : {{ p.memoryMb }} Mo · {{ p.cpu }} % CPU</li>
        </ul>
      </div>
      <div>
        <div class="mh-label">{{ t('settings.advancedSettings.storage') }}</div>
        <ul class="kv">
          <li>base : {{ diag.storage.databaseMb }} Mo</li>
          <li>pièces jointes : {{ diag.storage.attachmentsMb }} Mo</li>
          <li>espace de travail : {{ diag.storage.workspaceMb }} Mo</li>
          <li>journaux : {{ diag.storage.logsMb }} Mo · sauvegardes : {{ diag.storage.backupsMb }} Mo</li>
        </ul>
      </div>
    </div>
    <details class="box">
      <summary>{{ t('settings.advancedSettings.logs') }} ({{ diag.logs.length }})</summary>
      <pre class="logs">{{ diag.logs.slice(-150).map((l) => `${l.time.slice(11, 19)} ${l.level.padEnd(5)} [${l.category}] ${l.message}`).join('\n') }}</pre>
    </details>
  </template>

  <h3 class="mh-section-title">{{ t('settings.advancedSettings.backups') }}</h3>
  <Button :label="t('settings.advancedSettings.backupCreate')" icon="pi pi-save" size="small" @click="createBackup" />
  <table v-if="backups.length" class="table">
    <tbody>
      <tr v-for="b in backups" :key="b.name">
        <td>{{ date(b.createdAt) }}</td>
        <td class="mh-hint">{{ t(`settings.advancedSettings.backupKinds.${b.kind}`) }} · {{ formatSize(b.size) }}</td>
        <td class="actions">
          <Button :label="t('settings.advancedSettings.backupRestore')" size="small" text @click="restore(b)" />
          <Button icon="pi pi-folder-open" text rounded size="small" :aria-label="t('settings.advancedSettings.backupShow')" @click="show(b)" />
        </td>
      </tr>
    </tbody>
  </table>

  <h3 class="mh-section-title">{{ t('settings.advancedSettings.maintenance') }}</h3>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="mt-arch">{{ t('settings.advancedSettings.autoArchive') }}</label>
      <InputNumber input-id="mt-arch" v-model="draft.maintenance.autoArchiveDays" :min="0" :max="3650" :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="mt-del">{{ t('settings.advancedSettings.autoDelete') }}</label>
      <InputNumber input-id="mt-del" v-model="draft.maintenance.autoDeleteArchivedDays" :min="0" :max="3650" :allow-empty="false" />
    </div>
  </div>
  <div class="mh-switch-row">
    <label for="mt-att">{{ t('settings.advancedSettings.cleanAttachments') }}</label>
    <ToggleSwitch input-id="mt-att" v-model="draft.maintenance.cleanAttachments" />
  </div>
  <Button :label="t('settings.advancedSettings.runMaintenance')" icon="pi pi-wrench" size="small" severity="secondary" outlined @click="runMaintenance" />
</template>

<style scoped>
.first {
  margin-top: 0;
}
.box {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 8px 12px;
  margin: 8px 0;
}
.kv {
  margin: 6px 0;
  padding-left: 18px;
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}
.logs {
  max-height: 300px;
  overflow: auto;
  font-family: var(--mh-font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  margin: 6px 0 0;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-top: 8px;
}
.table td {
  border-bottom: 1px solid var(--mh-border);
  padding: 4px 6px;
}
.actions {
  text-align: right;
}
</style>
