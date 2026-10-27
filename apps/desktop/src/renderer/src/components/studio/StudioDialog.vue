<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import MultiSelect from 'primevue/multiselect';
import Checkbox from 'primevue/checkbox';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import type { AiDetectionResult, AttachmentRef, BenchmarkState, Id, TextTask, TextTaskResult } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';
import { previewUrl } from '../../lib/attachments.ts';
import DiffView from '../tools/DiffView.vue';
import TargetPicker from './TargetPicker.vue';
import AssetsView from './AssetsView.vue';
import DashboardView from './DashboardView.vue';

const { t } = useI18n();
const toast = useToast();
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 8000 });
const TABS = ['text', 'images', 'assets', 'benchmark', 'detect', 'dashboard'] as const;
const studio = computed(() => store.settings!.studio);
const saveStudio = (patch: Partial<typeof studio.value>) => api.call('settings.update', { studio: patch }).catch(fail);

// ---------- Texte ----------
const text = reactive({ task: 'translate' as TextTask, source: '', target: 'anglais', tone: '', instructions: '', busy: false, result: null as TextTaskResult | null, before: '' });
async function runText() {
  text.busy = true;
  try {
    text.before = text.source;
    text.result = await api.call('studio.text', { task: text.task, text: text.source, targetLanguage: text.target, tone: text.tone || undefined, instructions: text.instructions || undefined, providerId: studio.value.providerId, model: studio.value.model });
  } catch (e) {
    fail(e);
  } finally {
    text.busy = false;
  }
}
async function copy(value: string) {
  await navigator.clipboard.writeText(value);
  toast.add({ severity: 'success', summary: t('studio.copied'), life: 1500 });
}

// ---------- Images ----------
const img = reactive({ prompt: '', size: '1024x1024', busy: false, results: [] as { ref: AttachmentRef; url: string; revised: string | null }[] });
async function generate() {
  img.busy = true;
  try {
    const r = await api.call('images.generate', { prompt: img.prompt, size: img.size });
    for (const ref of r.attachments) img.results.unshift({ ref, url: await previewUrl(ref.id), revised: r.revisedPrompt });
  } catch (e) {
    fail(e);
  } finally {
    img.busy = false;
  }
}
async function saveImage(ref: AttachmentRef) {
  const r = await api.call('attachments.read', { id: ref.id }).catch((e) => (fail(e), null));
  if (r) await host.saveBinaryFile(ref.name, r.dataBase64, [{ name: 'Image', extensions: [ref.mime.split('/')[1] ?? 'png'] }]);
}

// ---------- Benchmark ----------
const bench = reactive({ targets: [] as string[], cases: '', repeat: 1, maxTokens: 512 as number | null, state: null as BenchmarkState | null });
const targetOptions = computed(() => store.providers.filter((p) => p.enabled).flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ label: `${p.name} · ${m.label}`, value: `${p.id}|${m.id}` }))));
let offBench: (() => void) | null = null;
onMounted(async () => {
  bench.state = await api.call('benchmark.state').catch(() => null);
  offBench = api.on('benchmark.progress', (s) => (bench.state = s));
});
onBeforeUnmount(() => offBench?.());
async function startBench() {
  const cases = bench.cases
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [prompt, expected] = l.split('=>').map((x) => x.trim());
      return { prompt: prompt!, ...(expected ? { expected } : {}) };
    });
  const targets = bench.targets.map((v) => ({ providerId: Number(v.split('|')[0]) as Id, model: v.split('|').slice(1).join('|') }));
  try {
    bench.state = await api.call('benchmark.start', { targets, cases, repeat: bench.repeat, maxOutputTokens: bench.maxTokens });
  } catch (e) {
    fail(e);
  }
}
const summary = computed(() => {
  const groups = new Map<string, NonNullable<typeof bench.state>['results']>();
  for (const r of bench.state?.results ?? []) groups.set(`${r.providerName} · ${r.model}`, [...(groups.get(`${r.providerName} · ${r.model}`) ?? []), r]);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return [...groups.entries()].map(([name, rs]) => {
    const checked = rs.filter((r) => r.passed !== null);
    return { name, ttft: avg(rs.map((r) => r.firstTokenMs)), duration: avg(rs.filter((r) => r.ok).map((r) => r.durationMs)), speed: avg(rs.map((r) => r.tokensPerSec)), passed: checked.length ? `${checked.filter((r) => r.passed).length}/${checked.length}` : '—', errors: rs.filter((r) => !r.ok).length };
  });
});

// ---------- Détection ----------
const det = reactive({ text: '', useModel: false, busy: false, result: null as AiDetectionResult | null });
async function analyze() {
  det.busy = true;
  try {
    det.result = await api.call('studio.detect', { text: det.text, useModel: det.useModel, providerId: studio.value.providerId, model: studio.value.model });
  } catch (e) {
    fail(e);
  } finally {
    det.busy = false;
  }
}
const fmt = (n: number | null, unit = '') => (n === null ? '—' : `${Math.round(n)}${unit}`);
</script>

<template>
  <Dialog v-model:visible="uiState.studio.open" modal :header="t('studio.title')" :style="{ width: 'min(1100px, 96vw)', height: '88vh' }" :content-style="{ display: 'flex', flexDirection: 'column', flex: '1', minHeight: 0 }">
    <nav class="tabs" role="tablist">
      <button v-for="tab in TABS" :key="tab" type="button" role="tab" :class="{ active: uiState.studio.tab === tab }" :aria-selected="uiState.studio.tab === tab" @click="uiState.studio.tab = tab">{{ t(`studio.tabs.${tab}`) }}</button>
    </nav>
    <div class="body">
      <!-- Texte -->
      <template v-if="uiState.studio.tab === 'text'">
        <div class="mh-row wrap bar">
          <Select v-model="text.task" :options="(['translate', 'proofread', 'rewrite'] as const).map((v) => ({ value: v, label: t(`studio.text.tasks.${v}`) }))" option-label="label" option-value="value" size="small" />
          <InputText v-if="text.task === 'translate'" v-model="text.target" :placeholder="t('studio.text.target')" :aria-label="t('studio.text.target')" size="small" />
          <InputText v-model="text.tone" :placeholder="t('studio.text.tone')" :aria-label="t('studio.text.tone')" size="small" />
          <span class="grow" />
          <TargetPicker :provider-id="studio.providerId" :model="studio.model" @change="(v) => saveStudio(v)" />
        </div>
        <InputText v-model="text.instructions" :placeholder="t('studio.text.instructions')" :aria-label="t('studio.text.instructions')" size="small" fluid />
        <div class="split">
          <Textarea v-model="text.source" :placeholder="t('studio.text.source')" :aria-label="t('studio.text.source')" class="area" />
          <div class="out">
            <div v-if="text.result" class="mh-row between">
              <span class="mh-hint">{{ t('studio.text.stats', { model: `${text.result.providerName} · ${text.result.model}`, ms: text.result.durationMs }) }}</span>
              <Button :label="t('studio.copy')" icon="pi pi-copy" size="small" text @click="copy(text.result.text)" />
            </div>
            <DiffView v-if="text.result && text.task === 'proofread'" :before="text.before" :after="text.result.text" />
            <pre v-else-if="text.result" class="result">{{ text.result.text }}</pre>
          </div>
        </div>
        <div class="mh-row end"><Button :label="t(`studio.text.tasks.${text.task}`)" icon="pi pi-play" :loading="text.busy" :disabled="!text.source.trim()" @click="runText" /></div>
      </template>

      <!-- Images et vision -->
      <template v-else-if="uiState.studio.tab === 'images'">
        <div class="mh-row wrap bar">
          <TargetPicker :provider-id="studio.imageProviderId" :model="studio.imageModel" :empty-label="t('studio.images.none')" :filter="(k) => k === 'openai-compatible' || k === 'gemini'" @change="(v) => saveStudio({ imageProviderId: v.providerId, imageModel: v.model })" />
          <Select v-model="img.size" :options="['1024x1024', '1536x1024', '1024x1536', '512x512']" size="small" :aria-label="t('studio.images.size')" />
        </div>
        <Textarea v-model="img.prompt" rows="3" auto-resize :placeholder="t('studio.images.prompt')" :aria-label="t('studio.images.prompt')" fluid />
        <div class="mh-row end"><Button :label="t('studio.images.generate')" icon="pi pi-image" :loading="img.busy" :disabled="!img.prompt.trim() || studio.imageProviderId === null" @click="generate" /></div>
        <div class="gallery">
          <figure v-for="r in img.results" :key="r.ref.id">
            <img :src="r.url" :alt="r.ref.name" />
            <figcaption>
              <span v-if="r.revised" class="mh-hint">{{ t('studio.images.revised', { text: r.revised }) }}</span>
              <Button :label="t('studio.images.save')" icon="pi pi-download" size="small" text @click="saveImage(r.ref)" />
            </figcaption>
          </figure>
        </div>
        <h3 class="mh-section-title">{{ t('studio.images.vision') }}</h3>
        <div class="mh-switch-row">
          <p class="mh-hint">{{ t('studio.images.visionHint') }}</p>
          <ToggleSwitch :model-value="studio.visionFallback" :aria-label="t('studio.images.vision')" @update:model-value="(v: boolean) => saveStudio({ visionFallback: v })" />
        </div>
        <TargetPicker :provider-id="studio.visionProviderId" :model="studio.visionModel" :empty-label="t('studio.images.visionModel')" @change="(v) => saveStudio({ visionProviderId: v.providerId, visionModel: v.model })" />
      </template>

      <AssetsView v-else-if="uiState.studio.tab === 'assets'" />
      <DashboardView v-else-if="uiState.studio.tab === 'dashboard'" />

      <!-- Benchmark -->
      <template v-else-if="uiState.studio.tab === 'benchmark'">
        <div class="mh-field">
          <label for="bm-t">{{ t('studio.benchmark.targets') }}</label>
          <MultiSelect input-id="bm-t" v-model="bench.targets" :options="targetOptions" option-label="label" option-value="value" filter display="chip" fluid />
        </div>
        <div class="mh-field">
          <label for="bm-c">{{ t('studio.benchmark.cases') }}</label>
          <Textarea id="bm-c" v-model="bench.cases" rows="4" auto-resize fluid placeholder="Combien font 17 × 23 ? => 391" />
        </div>
        <div class="mh-row wrap bar">
          <div class="mh-field"><label for="bm-r">{{ t('studio.benchmark.repeat') }}</label><InputNumber input-id="bm-r" v-model="bench.repeat" :min="1" :max="10" show-buttons :allow-empty="false" /></div>
          <div class="mh-field"><label for="bm-m">{{ t('studio.benchmark.maxTokens') }}</label><InputNumber input-id="bm-m" v-model="bench.maxTokens" :min="16" :max="32000" /></div>
          <span class="grow" />
          <Button v-if="bench.state?.running" :label="`${t('studio.benchmark.cancel')} (${t('studio.benchmark.progress', { done: bench.state.done, total: bench.state.total })})`" icon="pi pi-stop" severity="secondary" @click="api.call('benchmark.cancel')" />
          <Button v-else :label="t('studio.benchmark.start')" icon="pi pi-play" :disabled="!bench.targets.length || !bench.cases.trim()" @click="startBench" />
        </div>
        <p class="mh-hint">{{ t('studio.benchmark.cost') }}</p>
        <table v-if="summary.length" class="table">
          <thead><tr><th>{{ t('studio.model') }}</th><th>{{ t('studio.benchmark.ttft') }}</th><th>{{ t('studio.benchmark.duration') }}</th><th>{{ t('studio.benchmark.speed') }}</th><th>{{ t('studio.benchmark.passed') }}</th><th>{{ t('studio.benchmark.errors') }}</th></tr></thead>
          <tbody>
            <tr v-for="s in summary" :key="s.name"><td>{{ s.name }}</td><td>{{ fmt(s.ttft, ' ms') }}</td><td>{{ fmt(s.duration, ' ms') }}</td><td>{{ s.speed === null ? '—' : `${s.speed.toFixed(1)} tok/s` }}</td><td>{{ s.passed }}</td><td>{{ s.errors }}</td></tr>
          </tbody>
        </table>
        <details v-if="bench.state?.results.length">
          <summary>{{ t('studio.benchmark.details') }}</summary>
          <div v-for="(r, i) in bench.state.results" :key="i" class="detail">
            <strong>{{ r.providerName }} · {{ r.model }}</strong> — #{{ r.caseIndex + 1 }} ({{ r.run }}) {{ r.ok ? `${r.durationMs} ms` : r.error }}
            <span v-if="r.passed !== null">{{ r.passed ? '✓' : '✗' }}</span>
            <pre v-if="r.output" class="result small">{{ r.output }}</pre>
          </div>
        </details>
      </template>

      <!-- Détection -->
      <template v-else-if="uiState.studio.tab === 'detect'">
        <Message severity="warn" size="small">{{ t('studio.detect.disclaimer') }}</Message>
        <Textarea v-model="det.text" rows="8" :aria-label="t('studio.text.source')" :placeholder="t('studio.text.source')" fluid />
        <div class="mh-row wrap bar">
          <label class="check"><Checkbox v-model="det.useModel" binary /> {{ t('studio.detect.useModel') }}</label>
          <TargetPicker v-if="det.useModel" :provider-id="studio.providerId" :model="studio.model" @change="(v) => saveStudio(v)" />
          <span class="grow" />
          <Button :label="t('studio.detect.analyze')" icon="pi pi-search" :loading="det.busy" :disabled="!det.text.trim()" @click="analyze" />
        </div>
        <div v-if="det.result" class="detect">
          <p>
            <strong>{{ t(`studio.detect.labels.${det.result.heuristicLabel}`) }}</strong>
            <span v-if="det.result.heuristicLabel !== 'too_short'" class="mh-hint"> — {{ t('studio.detect.score', { value: Math.round(det.result.heuristicScore * 100) }) }}</span>
          </p>
          <ul class="metrics">
            <li v-for="(v, k) in det.result.metrics" :key="k">{{ t(`studio.detect.metrics.${k}`) }} : <strong>{{ v }}</strong></li>
          </ul>
          <template v-if="det.result.model">
            <p>{{ t('studio.detect.model', { model: `${det.result.model.providerName} · ${det.result.model.model}`, verdict: t(`studio.detect.verdicts.${det.result.model.verdict}`), confidence: Math.round(det.result.model.confidence * 100) }) }}</p>
            <ul class="metrics"><li v-for="r in det.result.model.reasons" :key="r">{{ r }}</li></ul>
          </template>
        </div>
      </template>
    </div>
  </Dialog>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--mh-border);
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.tabs button {
  border: 0;
  background: none;
  padding: 8px 12px;
  border-bottom: 2px solid transparent;
  color: var(--mh-muted);
  cursor: pointer;
  font: inherit;
}
.tabs button.active {
  color: var(--mh-text);
  border-bottom-color: var(--mh-accent);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bar {
  align-items: center;
  gap: 8px;
}
.grow {
  flex: 1;
}
.end {
  justify-content: flex-end;
}
.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  flex: 1;
  min-height: 240px;
}
.area {
  height: 100%;
  min-height: 240px;
  resize: none;
}
.out {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 8px;
  overflow: auto;
}
.result {
  white-space: pre-wrap;
  font-family: var(--mh-font-ui);
  margin: 0;
}
.result.small {
  font-size: 12px;
  max-height: 160px;
  overflow: auto;
}
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.gallery img {
  width: 100%;
  border-radius: var(--mh-radius);
  border: 1px solid var(--mh-border);
}
.gallery figure {
  margin: 0;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  border-bottom: 1px solid var(--mh-border);
  padding: 6px;
  text-align: left;
}
.detail {
  font-size: 12.5px;
  margin: 6px 0;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.metrics {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
@media (max-width: 760px) {
  .split {
    grid-template-columns: 1fr;
  }
}
</style>
