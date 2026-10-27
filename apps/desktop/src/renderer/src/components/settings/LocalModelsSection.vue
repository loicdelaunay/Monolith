<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Password from 'primevue/password';
import ProgressBar from 'primevue/progressbar';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { DownloadState, HardwareInfo, HfFile, HfModel, LocalEngineInfo, LocalModel, ModelEstimate, Settings } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';

defineProps<{ draft: Settings }>();
const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 8000 });
const gb = (mb: number) => (mb / 1024).toFixed(1);

const hw = ref<HardwareInfo | null>(null);
const engine = ref<LocalEngineInfo | null>(null);
const models = ref<LocalModel[]>([]);
const estimates = ref<Record<string, ModelEstimate>>({});
const downloads = ref<DownloadState[]>([]);
const busy = ref(false);

async function refresh() {
  [hw.value, engine.value, models.value, downloads.value] = await Promise.all([api.call('local.hardware'), api.call('local.engine'), api.call('local.models'), api.call('local.downloads')]);
  const entries = await Promise.all(models.value.map(async (m) => [m.id, await api.call('local.estimate', { id: m.id }).catch(() => null)] as const));
  estimates.value = Object.fromEntries(entries.filter((e): e is readonly [string, ModelEstimate] => e[1] !== null));
}
const offs: (() => void)[] = [];
onMounted(() => {
  void refresh().catch(fail);
  offs.push(
    api.on('local.changed', (e) => {
      engine.value = e.engine;
      models.value = e.models;
    }),
    api.on('local.download', (d) => {
      const i = downloads.value.findIndex((x) => x.id === d.id);
      if (i >= 0) downloads.value.splice(i, 1, d);
      else downloads.value.push(d);
      if (d.status === 'done') void refresh();
    }),
  );
});
onBeforeUnmount(() => offs.forEach((f) => f()));

// ---------- Moteur ----------
function install(backend: 'cpu' | 'cuda' | 'vulkan') {
  confirm.require({
    header: t('settings.localSettings.install', { backend: t(`settings.localSettings.backends.${backend}`) }),
    message: t('settings.localSettings.installConfirm', { backend: t(`settings.localSettings.backends.${backend}`) }),
    icon: 'pi pi-download',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('settings.localSettings.download') },
    accept: async () => {
      busy.value = true;
      try {
        engine.value = await api.call('local.installEngine', { backend });
      } catch (e) {
        fail(e);
      } finally {
        busy.value = false;
      }
    },
  });
}
async function choosePath() {
  const [path] = await host.pickFiles(t('settings.localSettings.choosePath'));
  if (path) engine.value = await api.call('local.setEnginePath', { path }).catch((e) => (fail(e), engine.value));
}

// ---------- Modèles ----------
async function importFile() {
  for (const path of await host.pickFiles(t('settings.localSettings.import'))) {
    await api.call('local.importFile', { path }).catch(fail);
  }
  await refresh();
}
function remove(m: LocalModel) {
  confirm.require({
    header: t('settings.localSettings.deleteTitle', { name: m.id }),
    message: '',
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('settings.localSettings.delete'), severity: 'danger' },
    accept: () => api.call('local.deleteModel', { id: m.id }).then(refresh).catch(fail),
  });
}

// ---------- Catalogue ----------
const query = ref('');
const results = ref<HfModel[]>([]);
const openRepo = ref<string | null>(null);
const files = ref<HfFile[]>([]);
async function search() {
  if (!query.value.trim()) return;
  busy.value = true;
  try {
    results.value = await api.call('local.hfSearch', { query: query.value });
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}
async function toggleRepo(repo: string) {
  if (openRepo.value === repo) {
    openRepo.value = null;
    return;
  }
  openRepo.value = repo;
  files.value = [];
  files.value = await api.call('local.hfFiles', { repo }).catch((e) => (fail(e), []));
}
async function download(file: HfFile) {
  if (!openRepo.value) return;
  await api.call('local.download', { repo: openRepo.value, file: file.name }).catch(fail);
}
const token = ref('');
async function saveToken(value: string | null) {
  try {
    await api.call('local.setHfToken', { token: value });
    token.value = '';
    toast.add({ severity: 'success', summary: value ? t('settings.localSettings.tokenSaved') : t('settings.localSettings.tokenClear'), life: 2500 });
  } catch (e) {
    fail(e);
  }
}
const fitLabel = (e: ModelEstimate | null) => (e ? t(`settings.localSettings.fits.${e.fits}`, { layers: e.gpuLayers }) : '');
</script>

<template>
  <p class="mh-hint">{{ t('settings.localSettings.intro') }}</p>

  <h3 class="mh-section-title">{{ t('settings.localSettings.hardware') }}</h3>
  <ul v-if="hw" class="kv">
    <li>{{ t('settings.localSettings.ram', { free: gb(hw.ramFreeMb), total: gb(hw.ramTotalMb) }) }}</li>
    <li>{{ t('settings.localSettings.cpu', { count: hw.cpus, model: hw.cpuModel }) }}</li>
    <li v-for="g in hw.gpus" :key="g.name">{{ t('settings.localSettings.gpu', { name: g.name, free: gb(g.vramFreeMb), total: gb(g.vramTotalMb) }) }}</li>
    <li v-if="!hw.gpus.length" class="mh-hint">{{ t('settings.localSettings.noGpu') }}</li>
  </ul>

  <h3 class="mh-section-title">{{ t('settings.localSettings.engine') }}</h3>
  <template v-if="engine">
    <p v-if="engine.installed"><i class="pi pi-check-circle ok" /> {{ t('settings.localSettings.engineInstalled', { version: engine.version ?? '?', source: engine.source ? t(`settings.localSettings.sources.${engine.source}`) : '' }) }} <code class="mh-hint">{{ engine.path }}</code></p>
    <p v-else class="mh-muted">{{ t('settings.localSettings.engineMissing') }}</p>
    <p v-if="engine.running">{{ t('settings.localSettings.running', { model: engine.running.model, ctx: engine.running.contextSize, ngl: engine.running.gpuLayers }) }} <Button :label="t('settings.localSettings.stop')" size="small" text @click="api.call('local.stop').then((e) => (engine = e))" /></p>
  </template>
  <div class="mh-row wrap">
    <Button v-for="b in (['cpu', 'cuda', 'vulkan'] as const)" :key="b" :label="t('settings.localSettings.install', { backend: t(`settings.localSettings.backends.${b}`) })" icon="pi pi-download" size="small" severity="secondary" outlined :loading="busy" @click="install(b)" />
    <Button :label="t('settings.localSettings.choosePath')" icon="pi pi-folder-open" size="small" text @click="choosePath" />
    <Button v-if="engine?.path" :label="t('settings.localSettings.clearPath')" size="small" text severity="secondary" @click="api.call('local.setEnginePath', { path: null }).then((e) => (engine = e))" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.localSettings.params') }}</h3>
  <div class="mh-row wrap">
    <div class="mh-field"><label for="lc-ctx">{{ t('settings.localSettings.contextSize') }}</label><InputNumber input-id="lc-ctx" v-model="draft.local.contextSize" :min="512" :max="262144" :step="1024" :allow-empty="false" /></div>
    <div class="mh-field"><label for="lc-ngl">{{ t('settings.localSettings.gpuLayers') }}</label><InputNumber input-id="lc-ngl" v-model="draft.local.gpuLayers" :min="-1" :max="999" :allow-empty="false" /></div>
    <div class="mh-field"><label for="lc-thr">{{ t('settings.localSettings.threads') }}</label><InputNumber input-id="lc-thr" v-model="draft.local.threads" :min="0" :max="256" :allow-empty="false" /></div>
    <div class="mh-field"><label for="lc-idle">{{ t('settings.localSettings.idle') }}</label><InputNumber input-id="lc-idle" v-model="draft.local.idleUnloadMin" :min="0" :max="1440" :allow-empty="false" /></div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.localSettings.installed') }}</h3>
  <Button :label="t('settings.localSettings.import')" icon="pi pi-upload" size="small" severity="secondary" outlined @click="importFile" />
  <p v-if="!models.length" class="mh-hint">{{ t('settings.localSettings.noModels') }}</p>
  <div v-for="m in models" :key="m.id" class="model">
    <div class="grow">
      <strong>{{ m.meta?.name ?? m.id }}</strong> <span v-if="m.quant" class="tag">{{ m.quant }}</span>
      <div class="mh-hint">{{ m.id }} · {{ gb(m.sizeBytes / 1048576) }} Go<template v-if="m.meta"> · {{ m.meta.architecture }} · ctx {{ m.meta.contextLength }} · {{ m.meta.blockCount }} couches</template><template v-if="m.repo"> · {{ m.repo }}</template></div>
      <div v-if="estimates[m.id]" class="mh-hint">{{ fitLabel(estimates[m.id]!) }} — {{ t('settings.localSettings.estimate', { total: gb(estimates[m.id]!.totalMb), weights: gb(estimates[m.id]!.weightsMb), kv: gb(estimates[m.id]!.kvCacheMb) }) }}</div>
    </div>
    <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('settings.localSettings.delete')" @click="remove(m)" />
  </div>

  <div v-for="d in downloads.filter((x) => x.status !== 'done')" :key="d.id" class="dl">
    <div class="mh-row between"><span>{{ d.file }} — {{ t(`settings.localSettings.status.${d.status}`) }}<span v-if="d.error" class="err"> : {{ d.error }}</span></span>
      <Button v-if="d.status === 'running'" :label="t('settings.localSettings.cancel')" size="small" text @click="api.call('local.cancelDownload', { id: d.id })" /></div>
    <ProgressBar v-if="d.status === 'running' || d.status === 'verifying'" :value="d.total ? Math.round((d.received / d.total) * 100) : 0" :show-value="true" style="height: 14px" />
    <span v-if="d.status === 'running'" class="mh-hint">{{ gb(d.received / 1048576) }} / {{ gb(d.total / 1048576) }} Go · {{ (d.speedBps / 1048576).toFixed(1) }} Mo/s</span>
  </div>

  <h3 class="mh-section-title">{{ t('settings.localSettings.catalog') }}</h3>
  <form class="mh-row" @submit.prevent="search">
    <InputText v-model="query" :placeholder="t('settings.localSettings.search')" :aria-label="t('settings.localSettings.search')" class="grow" />
    <Button type="submit" icon="pi pi-search" :loading="busy" :aria-label="t('settings.localSettings.search')" />
  </form>
  <div v-for="r in results" :key="r.id" class="repo">
    <button type="button" class="repo-head" @click="toggleRepo(r.id)">
      <i class="pi" :class="openRepo === r.id ? 'pi-angle-down' : 'pi-angle-right'" />
      <strong>{{ r.id }}</strong>
      <span class="mh-hint">{{ t('settings.localSettings.downloads', { count: r.downloads.toLocaleString() }) }}</span>
      <span v-if="r.gated" class="tag">{{ t('settings.localSettings.gated') }}</span>
    </button>
    <table v-if="openRepo === r.id" class="files">
      <tr v-for="f in files" :key="f.name">
        <td>{{ f.name }}</td>
        <td><span v-if="f.quant" class="tag">{{ f.quant }}</span></td>
        <td>{{ gb(f.size / 1048576) }} Go</td>
        <td class="mh-hint" :class="f.estimate?.fits">{{ fitLabel(f.estimate) }}</td>
        <td><Button :label="t('settings.localSettings.download')" icon="pi pi-download" size="small" text :disabled="models.some((m) => m.id === f.name.split('/').pop())" @click="download(f)" /></td>
      </tr>
    </table>
  </div>
  <div class="mh-field token">
    <label for="hf-token">{{ t('settings.localSettings.token') }}</label>
    <div class="mh-row">
      <Password v-model="token" input-id="hf-token" :feedback="false" toggle-mask placeholder="hf_…" class="grow" fluid />
      <Button :label="t('settings.localSettings.tokenSave')" size="small" :disabled="!token.trim()" @click="saveToken(token)" />
      <Button :label="t('settings.localSettings.tokenClear')" size="small" text severity="secondary" @click="saveToken(null)" />
    </div>
  </div>
</template>

<style scoped>
.kv {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 13px;
}
.ok {
  color: #2f9e5b;
}
.grow {
  flex: 1;
  min-width: 0;
}
.model,
.repo {
  border-bottom: 1px solid var(--mh-border);
  padding: 8px 0;
}
.model {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--mh-hover);
}
.dl {
  margin: 8px 0;
  font-size: 13px;
}
.err {
  color: var(--mh-danger);
}
.repo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: none;
  color: var(--mh-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
  padding: 2px 0;
}
.files {
  width: 100%;
  font-size: 12.5px;
  border-collapse: collapse;
  margin-top: 6px;
}
.files td {
  padding: 3px 6px;
  border-top: 1px solid var(--mh-border);
}
td.gpu {
  color: #2f9e5b;
}
td.too_large {
  color: var(--mh-danger);
}
.token {
  margin-top: 14px;
}
</style>
