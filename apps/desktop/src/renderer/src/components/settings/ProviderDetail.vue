<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import InputNumber from 'primevue/inputnumber';
import ToggleSwitch from 'primevue/toggleswitch';
import Checkbox from 'primevue/checkbox';
import Textarea from 'primevue/textarea';
import Paginator from 'primevue/paginator';
import Message from 'primevue/message';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import { useToast } from 'primevue/usetoast';
import type { CatalogModel, ConnectionTestResult, Provider, ProviderModel, ReasoningLevel, Settings } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';
import { store } from '../../stores/app.ts';
import ProviderLogo from '../ProviderLogo.vue';
import { formatTokens } from '../../lib/format.ts';

const props = defineProps<{ provider: Provider; draft: Settings }>();
const emit = defineEmits<{ 'update:dirty': [value: boolean]; delete: []; duplicate: [] }>();
const { t } = useI18n();
const toast = useToast();

// ---------- Formulaire (enregistré par « Enregistrer la connexion ») ----------
function snapshot(p: Provider) {
  return {
    name: p.name,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    headers: Object.entries(p.options.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    connectTimeoutSec: p.options.connectTimeoutSec,
    idleTimeoutSec: p.options.idleTimeoutSec,
    streamUsage: p.options.streamUsage,
    temperature: p.options.temperature,
    maxOutputTokens: p.options.maxOutputTokens,
    google: { ...p.options.google },
    acpCommand: p.options.acp.command,
    acpArgs: p.options.acp.args.join('\n'),
    acpEnv: Object.entries(p.options.acp.env).map(([k, v]) => `${k}=${v}`).join('\n'),
    composite: JSON.parse(JSON.stringify(p.options.composite)) as Provider['options']['composite'],
    models: p.models.map((m) => ({ ...m, capabilities: { ...m.capabilities } })),
  };
}
const form = reactive(snapshot(props.provider));
let saved = JSON.stringify(form);
const dirty = computed(() => JSON.stringify(form) !== saved);
watch(dirty, (v) => emit('update:dirty', v), { immediate: true });

// Mise à jour externe (clé, duplication…) : on recale le formulaire s'il n'est pas modifié.
watch(
  () => props.provider,
  (p) => {
    if (dirty.value) return;
    Object.assign(form, snapshot(p));
    saved = JSON.stringify(form);
  },
);

const preset = computed(() => store.presets.find((p) => p.id === props.provider.preset));
const kind = computed(() => props.provider.kind);
const showBaseUrl = computed(() => !['acp', 'composite', 'opencode', 'local'].includes(kind.value));
const showKey = computed(() => preset.value?.keyKind !== 'none' && !(kind.value === 'vertex' && form.google.auth === 'adc'));
const jsonKey = computed(() => kind.value === 'vertex' && form.google.auth === 'service_account');
const authOptions = computed(() => (['adc', 'api_key', 'express', 'service_account'] as const).map((a) => ({ label: t(`settings.providers.google.auths.${a}`), value: a })));

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function kindOptions() {
  if (kind.value === 'vertex' || kind.value === 'gemini') return { google: { ...form.google } };
  if (kind.value === 'acp') return { acp: { command: form.acpCommand, args: form.acpArgs.split('\n').map((a) => a.trim()).filter(Boolean), env: parseEnv(form.acpEnv) } };
  if (kind.value === 'composite') return { composite: form.composite };
  return {};
}
// Modèle composé : connexions et modèles disponibles (hors modèles composés).
const refProviders = computed(() => store.providers.filter((p) => p.kind !== 'composite').map((p) => ({ label: p.name, value: p.id })));
const refModels = (providerId: number | null | undefined) => (store.providers.find((p) => p.id === providerId)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id }));
function setOrchestrator(providerId: number | null) {
  form.composite.orchestrator = providerId === null ? null : { providerId, model: refModels(providerId)[0]?.value ?? '' };
}
function addSpecialist() {
  const first = refProviders.value[0]?.value;
  if (first === undefined) return;
  form.composite.specialists.push({ name: `specialiste-${form.composite.specialists.length + 1}`, description: '', providerId: first, model: refModels(first)[0]?.value ?? '' });
}
const insecureHttp = computed(() => {
  try {
    const u = new URL(form.baseUrl);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
});

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const saving = ref(false);
async function save() {
  saving.value = true;
  try {
    await api.call('providers.update', {
      id: props.provider.id,
      patch: {
        name: form.name,
        baseUrl: form.baseUrl,
        enabled: form.enabled,
        options: {
          headers: parseHeaders(form.headers),
          connectTimeoutSec: form.connectTimeoutSec,
          idleTimeoutSec: form.idleTimeoutSec,
          streamUsage: form.streamUsage,
          temperature: form.temperature,
          maxOutputTokens: form.maxOutputTokens,
          ...kindOptions(),
        },
      },
    });
    const updated = await api.call('providers.setModels', { id: props.provider.id, models: form.models });
    Object.assign(form, snapshot(updated));
    saved = JSON.stringify(form);
    toast.add({ severity: 'success', summary: t('common.saved'), life: 2000 });
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 7000 });
  } finally {
    saving.value = false;
  }
}

function revert() {
  Object.assign(form, snapshot(props.provider));
  saved = JSON.stringify(form);
}

// ---------- Clé (enregistrement immédiat, chiffrée par le moteur) ----------
const replacingKey = ref(!props.provider.hasKey && (preset.value?.keyRequired ?? false));
const newKey = ref('');
const keyBusy = ref(false);
async function saveKey() {
  if (!newKey.value.trim()) return;
  keyBusy.value = true;
  try {
    await api.call('providers.setKey', { id: props.provider.id, apiKey: newKey.value });
    newKey.value = '';
    replacingKey.value = false;
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 7000 });
  } finally {
    keyBusy.value = false;
  }
}
async function clearKey() {
  await api.call('providers.clearKey', { id: props.provider.id }).catch((e) => toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 }));
}

// ---------- Test ----------
const testing = ref(false);
const testResult = ref<ConnectionTestResult | null>(null);
const allowCompletion = ref(false);
async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    const firstModel = form.models.find((m) => m.enabled)?.id;
    testResult.value = await api.call('providers.test', {
      providerId: props.provider.id,
      kind: props.provider.kind,
      baseUrl: form.baseUrl,
      ...(newKey.value.trim() ? { apiKey: newKey.value } : {}),
      options: { headers: parseHeaders(form.headers), connectTimeoutSec: form.connectTimeoutSec, ...kindOptions() },
      ...(firstModel ? { model: firstModel } : {}),
      allowCompletion: allowCompletion.value,
    });
  } catch (e) {
    testResult.value = { ok: false, status: null, latencyMs: 0, modelCount: null, code: 'internal', message: errorMessage(e), usedCompletion: false };
  } finally {
    testing.value = false;
  }
}
const testMessage = computed(() => {
  const r = testResult.value;
  if (!r) return '';
  if (r.ok) return r.usedCompletion ? t('settings.providers.testOkCompletion', { ms: r.latencyMs }) : t('settings.providers.testOk', { ms: r.latencyMs, count: r.modelCount ?? 0 });
  if (r.code === 'catalog_unavailable') return t('settings.providers.testCatalogMissing');
  return t('settings.providers.testFail', { message: r.message });
});

// ---------- Modèles ----------
const catalog = ref<CatalogModel[] | null>(null);
const fetching = ref(false);
const modelQuery = ref('');
const first = ref(0);
const PAGE = 50;
const manualId = ref('');

async function fetchCatalog() {
  fetching.value = true;
  try {
    catalog.value = await api.call('providers.fetchCatalog', { id: props.provider.id });
    // Fusion : les modèles du catalogue s'ajoutent, désactivés par défaut ; les choix existants sont conservés.
    const known = new Map(form.models.map((m) => [m.id, m]));
    for (const c of catalog.value) {
      const existing = known.get(c.id);
      if (existing) {
        existing.contextWindow ??= c.contextWindow;
        existing.maxOutputTokens ??= c.maxOutputTokens;
        // Réévaluation : les niveaux saisis par l'utilisateur restent, les refus sont oubliés.
        const user = existing.capabilities.reasoningSource === 'user';
        existing.capabilities = {
          ...c.capabilities,
          reasoningLevels: user ? existing.capabilities.reasoningLevels : c.capabilities.reasoningLevels,
          reasoningSource: user ? 'user' : c.capabilities.reasoningSource,
          rejectedLevels: [],
        };
        existing.source = 'catalog';
      } else {
        form.models.push({ id: c.id, label: c.label, enabled: false, contextWindow: c.contextWindow, maxOutputTokens: c.maxOutputTokens, source: 'catalog', capabilities: { ...c.capabilities } });
      }
    }
  } catch (e) {
    toast.add({ severity: 'error', summary: t('settings.providers.fetchCatalog'), detail: errorMessage(e), life: 7000 });
  } finally {
    fetching.value = false;
  }
}

const filteredModels = computed(() => {
  const q = modelQuery.value.trim().toLowerCase();
  return form.models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
});
const pageModels = computed(() => filteredModels.value.slice(first.value, first.value + PAGE));
watch(modelQuery, () => (first.value = 0));
const enabledCount = computed(() => form.models.filter((m) => m.enabled).length);

function setAll(value: boolean) {
  for (const m of filteredModels.value) m.enabled = value;
}
function addManual() {
  const id = manualId.value.trim();
  if (!id || form.models.some((m) => m.id === id)) return;
  form.models.unshift({ id, label: id, enabled: true, contextWindow: null, maxOutputTokens: null, source: 'manual', capabilities: { reasoningLevels: [], reasoningSource: 'unknown', rejectedLevels: [], vision: null, tools: null } });
  manualId.value = '';
}
// Édition des capacités d'un modèle (niveaux de réflexion déclarés, vision, limites).
const expandedModel = ref<string | null>(null);
const LEVELS: ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
const levelOptions = computed(() => LEVELS.map((l) => ({ label: t(`reasoningLevels.${l}`), value: l })));
const visionOptions = computed(() => [
  { label: t('settings.providers.visionUnknown'), value: null },
  { label: t('settings.providers.visionYes'), value: true },
  { label: t('settings.providers.visionNo'), value: false },
]);
function setLevels(m: ProviderModel, levels: ReasoningLevel[]) {
  m.capabilities.reasoningLevels = levels;
  m.capabilities.reasoningSource = levels.length ? 'user' : 'unknown';
}
const refreshing = ref(false);
async function refreshCapabilities() {
  refreshing.value = true;
  try {
    const updated = await api.call('providers.refreshModels', { id: props.provider.id });
    Object.assign(form, snapshot(updated));
    saved = JSON.stringify(form);
    toast.add({ severity: 'success', summary: t('settings.providers.capabilitiesRefreshed'), life: 2500 });
  } catch (e) {
    toast.add({ severity: 'error', summary: t('settings.providers.refreshCapabilities'), detail: errorMessage(e), life: 7000 });
  } finally {
    refreshing.value = false;
  }
}

function removeModel(m: ProviderModel) {
  form.models.splice(form.models.indexOf(m), 1);
}
</script>

<template>
  <div class="detail">
    <header class="head">
      <ProviderLogo :preset="provider.preset" :size="34" />
      <div class="head-text">
        <div class="title">{{ form.name || provider.name }}</div>
        <div class="mh-hint">{{ preset?.name }}</div>
      </div>
      <a v-if="preset?.docsUrl" href="#" class="link" @click.prevent="host.openExternal(preset.docsUrl)">{{ t('settings.providers.docs') }}</a>
      <Button icon="pi pi-copy" text rounded size="small" :aria-label="t('common.duplicate')" v-tooltip.bottom="t('common.duplicate')" @click="emit('duplicate')" />
      <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('common.delete')" v-tooltip.bottom="t('common.delete')" @click="emit('delete')" />
    </header>

    <Tabs value="connection" class="tabs">
      <TabList>
        <Tab value="connection">{{ t('settings.providers.tabs.connection') }}</Tab>
        <Tab value="models">{{ t('settings.providers.tabs.models') }} <span class="count">{{ enabledCount }}</span></Tab>
        <Tab value="advanced">{{ t('settings.providers.tabs.advanced') }}</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="connection">
          <div class="mh-field">
            <label :for="`pname-${provider.id}`">{{ t('settings.providers.name') }}</label>
            <InputText :id="`pname-${provider.id}`" v-model="form.name" maxlength="120" fluid />
          </div>
          <div v-if="showBaseUrl" class="mh-field">
            <label :for="`purl-${provider.id}`">{{ kind === 'vertex' ? t('settings.providers.google.endpoint') : t('settings.providers.baseUrl') }}</label>
            <InputText :id="`purl-${provider.id}`" v-model="form.baseUrl" fluid spellcheck="false" :placeholder="kind === 'vertex' ? t('settings.providers.google.endpointHint') : ''" />
            <Message v-if="insecureHttp" severity="warn" size="small" variant="simple">{{ t('settings.providers.httpWarning') }}</Message>
          </div>

          <!-- Vertex AI : projet, région, authentification -->
          <fieldset v-if="kind === 'vertex'" class="mh-field plain kind-box">
            <legend class="mh-label">{{ t('settings.providers.google.title') }}</legend>
            <div class="mh-field">
              <label :for="`gauth-${provider.id}`">{{ t('settings.providers.google.auth') }}</label>
              <Select :input-id="`gauth-${provider.id}`" v-model="form.google.auth" :options="authOptions" option-label="label" option-value="value" fluid />
              <p v-if="form.google.auth === 'adc'" class="mh-hint">{{ t('settings.providers.google.adcHint') }}</p>
              <p v-else-if="form.google.auth === 'api_key'" class="mh-hint">{{ t('settings.providers.google.apiKeyHint') }}</p>
              <p v-else-if="form.google.auth === 'express'" class="mh-hint">{{ t('settings.providers.google.expressHint') }}</p>
            </div>
            <div class="mh-row wrap">
              <div class="mh-field grow">
                <label :for="`gproj-${provider.id}`">{{ t('settings.providers.google.project') }}</label>
                <InputText :id="`gproj-${provider.id}`" v-model="form.google.project" spellcheck="false" fluid :disabled="form.google.auth === 'express'" :invalid="form.google.auth === 'api_key' && !form.google.project.trim()" placeholder="project-…" />
              </div>
              <div class="mh-field">
                <label :for="`gloc-${provider.id}`">{{ t('settings.providers.google.location') }}</label>
                <InputText :id="`gloc-${provider.id}`" v-model="form.google.location" spellcheck="false" :disabled="form.google.auth === 'express'" />
              </div>
            </div>
            <p class="mh-hint">{{ form.google.auth === 'api_key' ? t('settings.providers.google.projectRequired') : t('settings.providers.google.projectHint') }}</p>
          </fieldset>

          <!-- Agent externe ACP -->
          <fieldset v-if="kind === 'acp'" class="mh-field plain kind-box">
            <legend class="mh-label">{{ t('settings.providers.acp.title') }}</legend>
            <p class="mh-hint">{{ t('settings.providers.acp.hint') }}</p>
            <div class="mh-field">
              <label :for="`acmd-${provider.id}`">{{ t('settings.providers.acp.command') }}</label>
              <InputText :id="`acmd-${provider.id}`" v-model="form.acpCommand" spellcheck="false" fluid />
            </div>
            <div class="mh-field">
              <label :for="`aargs-${provider.id}`">{{ t('settings.providers.acp.args') }}</label>
              <Textarea :id="`aargs-${provider.id}`" v-model="form.acpArgs" rows="2" auto-resize spellcheck="false" fluid class="mono" />
            </div>
            <div class="mh-field">
              <label :for="`aenv-${provider.id}`">{{ t('settings.providers.acp.env') }}</label>
              <Textarea :id="`aenv-${provider.id}`" v-model="form.acpEnv" rows="2" auto-resize spellcheck="false" fluid class="mono" />
              <p class="mh-hint">{{ t('settings.providers.acp.envHint') }}</p>
            </div>
          </fieldset>

          <!-- Modèle composé -->
          <fieldset v-if="kind === 'composite'" class="mh-field plain kind-box">
            <legend class="mh-label">{{ t('settings.providers.composite.title') }}</legend>
            <p class="mh-hint">{{ t('settings.providers.composite.hint') }}</p>
            <span class="mh-label">{{ t('settings.providers.composite.orchestrator') }}</span>
            <div class="mh-row wrap">
              <Select :model-value="form.composite.orchestrator?.providerId ?? null" :options="refProviders" option-label="label" option-value="value" show-clear :placeholder="t('settings.providers.composite.connection')" :aria-label="t('settings.providers.composite.connection')" class="grow" @update:model-value="setOrchestrator" />
              <Select v-if="form.composite.orchestrator" v-model="form.composite.orchestrator.model" :options="refModels(form.composite.orchestrator.providerId)" option-label="label" option-value="value" filter :placeholder="t('settings.providers.composite.model')" :aria-label="t('settings.providers.composite.model')" class="grow" />
            </div>
            <p class="mh-hint">{{ t('settings.providers.composite.orchestratorHint') }}</p>
            <span class="mh-label">{{ t('settings.providers.composite.specialists') }}</span>
            <div v-for="(sp, i) in form.composite.specialists" :key="i" class="spec">
              <div class="mh-row wrap">
                <InputText v-model="sp.name" :placeholder="t('settings.providers.composite.specialistName')" :aria-label="t('settings.providers.composite.specialistName')" maxlength="40" class="name" />
                <Select v-model="sp.providerId" :options="refProviders" option-label="label" option-value="value" :aria-label="t('settings.providers.composite.connection')" class="grow" @update:model-value="(id: number) => (sp.model = refModels(id)[0]?.value ?? '')" />
                <Select v-model="sp.model" :options="refModels(sp.providerId)" option-label="label" option-value="value" filter :aria-label="t('settings.providers.composite.model')" class="grow" />
                <Button icon="pi pi-trash" text severity="danger" size="small" :aria-label="t('settings.providers.composite.removeSpecialist')" @click="form.composite.specialists.splice(i, 1)" />
              </div>
              <InputText v-model="sp.description" :placeholder="t('settings.providers.composite.specialistDesc')" :aria-label="t('settings.providers.composite.specialistDesc')" maxlength="500" fluid />
            </div>
            <Button :label="t('settings.providers.composite.addSpecialist')" icon="pi pi-plus" size="small" severity="secondary" outlined :disabled="!refProviders.length" @click="addSpecialist" />
            <div class="mh-field top">
              <label :for="`cmax-${provider.id}`">{{ t('settings.providers.composite.maxConsultations') }}</label>
              <InputNumber :input-id="`cmax-${provider.id}`" v-model="form.composite.maxConsultations" :min="1" :max="20" show-buttons :allow-empty="false" />
            </div>
          </fieldset>
          <div class="mh-switch-row">
            <label :for="`pen-${provider.id}`">{{ t('settings.providers.enabled') }}</label>
            <ToggleSwitch :input-id="`pen-${provider.id}`" v-model="form.enabled" />
          </div>

          <div v-if="showKey" class="mh-field key">
            <div class="mh-row between">
              <span class="mh-label">{{ t('settings.providers.apiKey') }}</span>
              <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
            </div>
            <Message v-if="provider.keyUnreadable" severity="warn" size="small">{{ t('settings.providers.keyUnreadable') }}</Message>
            <div v-if="provider.hasKey && !replacingKey" class="mh-row wrap">
              <i class="pi pi-lock" />
              <span>{{ provider.keyHint ? t('settings.providers.keySaved', { hint: provider.keyHint }) : t('settings.providers.keySavedNoHint') }}</span>
              <Button :label="t('settings.providers.keyReplace')" size="small" severity="secondary" outlined @click="replacingKey = true" />
              <Button :label="t('settings.providers.keyClear')" size="small" severity="danger" text @click="clearKey" />
            </div>
            <template v-else>
              <div class="mh-row">
                <Textarea v-if="jsonKey" v-model="newKey" rows="4" spellcheck="false" :placeholder="t('settings.providers.google.serviceAccount')" :aria-label="t('settings.providers.google.serviceAccount')" class="grow mono" fluid />
                <Password v-else v-model="newKey" :feedback="false" toggle-mask :placeholder="t('settings.providers.keyPlaceholder')" :input-props="{ autocomplete: 'off', spellcheck: false, 'aria-label': t('settings.providers.apiKey') }" class="grow" fluid @keydown.enter.prevent="saveKey" />
                <Button :label="t('common.save')" :loading="keyBusy" :disabled="!newKey.trim()" @click="saveKey" />
                <Button v-if="provider.hasKey" :label="t('common.cancel')" severity="secondary" text @click="(replacingKey = false), (newKey = '')" />
              </div>
              <p v-if="jsonKey" class="mh-hint">{{ t('settings.providers.google.serviceAccountHint') }}</p>
              <p v-else-if="!provider.hasKey" class="mh-hint">{{ preset?.keyRequired ? '' : t('settings.providers.keyOptional') }}</p>
            </template>
            <a v-if="preset?.keyUrl" href="#" class="link small" @click.prevent="host.openExternal(preset.keyUrl)">{{ t('settings.providers.getKey') }} <i class="pi pi-external-link" /></a>
          </div>

          <div class="test">
            <Button :label="t('settings.providers.test')" icon="pi pi-bolt" :loading="testing" severity="secondary" @click="test" />
            <div class="mh-row check">
              <Checkbox v-model="allowCompletion" binary :input-id="`pac-${provider.id}`" />
              <label :for="`pac-${provider.id}`">{{ t('settings.providers.allowCompletion') }}</label>
            </div>
            <p class="mh-hint">{{ t('settings.providers.allowCompletionHint') }}</p>
            <!-- Résultat directement sous le bouton. -->
            <Message v-if="testResult" :severity="testResult.ok ? 'success' : testResult.code === 'catalog_unavailable' ? 'warn' : 'error'" size="small" role="status">{{ testMessage }}</Message>
          </div>
        </TabPanel>

        <TabPanel value="models">
          <div class="mh-row wrap tools">
            <Button :label="t('settings.providers.fetchCatalog')" icon="pi pi-download" size="small" :loading="fetching" @click="fetchCatalog" />
            <span v-tooltip.top="dirty ? t('settings.providers.saveFirst') : t('settings.providers.refreshCapabilitiesHint')">
              <Button :label="t('settings.providers.refreshCapabilities')" icon="pi pi-refresh" size="small" severity="secondary" outlined :loading="refreshing" :disabled="dirty || form.models.length === 0" @click="refreshCapabilities" />
            </span>
            <span v-if="catalog" class="mh-hint">{{ t('settings.providers.catalogCount', { count: catalog.length }) }}</span>
            <span class="grow" />
            <span class="mh-hint">{{ t('settings.providers.enabledCount', { enabled: enabledCount, total: form.models.length }) }}</span>
          </div>
          <div class="mh-row tools">
            <InputText v-model="manualId" size="small" :placeholder="t('settings.providers.manualPlaceholder')" :aria-label="t('settings.providers.manualPlaceholder')" class="grow" @keydown.enter.prevent="addManual" />
            <Button :label="t('settings.providers.manualAdd')" icon="pi pi-plus" size="small" severity="secondary" outlined :disabled="!manualId.trim()" @click="addManual" />
          </div>
          <div class="mh-row tools">
            <InputText v-model="modelQuery" size="small" :placeholder="t('settings.providers.modelsSearch')" :aria-label="t('settings.providers.modelsSearch')" class="grow" />
            <Button :label="t('settings.providers.enableAll')" size="small" text @click="setAll(true)" />
            <Button :label="t('settings.providers.disableAll')" size="small" text @click="setAll(false)" />
          </div>
          <p v-if="form.models.length === 0" class="mh-hint">{{ t('settings.providers.modelsEmpty') }}</p>
          <ul v-else class="models">
            <li v-for="m in pageModels" :key="m.id" class="model-item">
              <div class="model-row">
                <Checkbox v-model="m.enabled" binary :input-id="`m-${provider.id}-${m.id}`" />
                <label :for="`m-${provider.id}-${m.id}`" class="model-id">{{ m.id }}</label>
                <span v-if="m.contextWindow" class="mh-hint">{{ t('settings.providers.contextWindow') }} {{ formatTokens(m.contextWindow) }}</span>
                <span v-if="m.capabilities.reasoningLevels.length" class="mh-hint" :title="t(`settings.providers.reasoningSources.${m.capabilities.reasoningSource}`)"><i class="pi pi-sparkles" /> {{ m.capabilities.reasoningLevels.length }}</span>
                <span v-if="m.capabilities.rejectedLevels.length" class="rejected" :title="t('settings.providers.rejectedHint')"><i class="pi pi-ban" /> {{ m.capabilities.rejectedLevels.length }}</span>
                <span class="src" :class="m.source">{{ m.source === 'catalog' ? t('settings.providers.catalog') : t('settings.providers.manual') }}</span>
                <button type="button" class="mh-icon-btn" :aria-expanded="expandedModel === m.id" :aria-label="t('settings.providers.capabilities')" v-tooltip.top="t('settings.providers.capabilities')" @click="expandedModel = expandedModel === m.id ? null : m.id"><i class="pi pi-sliders-h" /></button>
                <button v-if="m.source === 'manual'" type="button" class="mh-icon-btn" :aria-label="t('common.remove')" @click="removeModel(m)"><i class="pi pi-times" /></button>
              </div>
              <div v-if="expandedModel === m.id" class="caps">
                <div class="mh-field">
                  <label :for="`cw-${m.id}`">{{ t('settings.providers.contextWindow') }}</label>
                  <InputNumber :input-id="`cw-${m.id}`" v-model="m.contextWindow" :min="256" :max="20000000" :placeholder="t('settings.providers.unknown')" />
                </div>
                <div class="mh-field">
                  <label :for="`mo-${m.id}`">{{ t('settings.providers.maxOutput') }}</label>
                  <InputNumber :input-id="`mo-${m.id}`" v-model="m.maxOutputTokens" :min="1" :max="2000000" :placeholder="t('settings.providers.unknown')" />
                </div>
                <div class="mh-field">
                  <label :for="`vi-${m.id}`">{{ t('settings.providers.vision') }}</label>
                  <Select :input-id="`vi-${m.id}`" v-model="m.capabilities.vision" :options="visionOptions" option-label="label" option-value="value" />
                </div>
                <div class="mh-field wide">
                  <label :for="`rl-${m.id}`">{{ t('settings.providers.reasoningLevels') }}</label>
                  <MultiSelect :input-id="`rl-${m.id}`" :model-value="m.capabilities.reasoningLevels" :options="levelOptions" option-label="label" option-value="value" display="chip" :placeholder="t('settings.providers.reasoningUnknown')" @update:model-value="(v: ReasoningLevel[]) => setLevels(m, v)" />
                  <p class="mh-hint">{{ t(`settings.providers.reasoningSources.${m.capabilities.reasoningSource}`) }} — {{ t('settings.providers.reasoningLevelsHint') }}</p>
                  <p v-if="m.capabilities.rejectedLevels.length" class="mh-hint rejected">
                    {{ t('settings.providers.rejectedList', { levels: m.capabilities.rejectedLevels.map((l) => t(`reasoningLevels.${l}`)).join(', ') }) }}
                    <button type="button" class="link-btn" @click="m.capabilities.rejectedLevels = []">{{ t('settings.providers.clearRejected') }}</button>
                  </p>
                </div>
              </div>
            </li>
          </ul>
          <Paginator v-if="filteredModels.length > PAGE" v-model:first="first" :rows="PAGE" :total-records="filteredModels.length" template="PrevPageLink PageLinks NextPageLink" />
        </TabPanel>

        <TabPanel value="advanced">
          <div class="mh-field">
            <label :for="`ph-${provider.id}`">{{ t('settings.providers.headers') }}</label>
            <Textarea :id="`ph-${provider.id}`" v-model="form.headers" rows="3" auto-resize fluid class="mono" spellcheck="false" />
            <p class="mh-hint">{{ t('settings.providers.headersHint') }}</p>
          </div>
          <div class="grid">
            <div class="mh-field">
              <label :for="`pct-${provider.id}`">{{ t('settings.providers.connectTimeout') }}</label>
              <InputNumber :input-id="`pct-${provider.id}`" v-model="form.connectTimeoutSec" :min="5" :max="600" show-buttons :allow-empty="false" />
            </div>
            <div class="mh-field">
              <label :for="`pit-${provider.id}`">{{ t('settings.providers.idleTimeout') }}</label>
              <InputNumber :input-id="`pit-${provider.id}`" v-model="form.idleTimeoutSec" :min="10" :max="1800" show-buttons :allow-empty="false" />
            </div>
            <div class="mh-field">
              <label :for="`ptemp-${provider.id}`">{{ t('settings.providers.temperature') }}</label>
              <InputNumber :input-id="`ptemp-${provider.id}`" v-model="form.temperature" :min="0" :max="2" :step="0.1" :min-fraction-digits="1" :max-fraction-digits="2" :placeholder="t('settings.providers.temperatureDefault')" />
            </div>
            <div class="mh-field">
              <label :for="`pmax-${provider.id}`">{{ t('settings.providers.maxOutputTokens') }}</label>
              <InputNumber :input-id="`pmax-${provider.id}`" v-model="form.maxOutputTokens" :min="1" :max="1000000" :placeholder="t('settings.providers.temperatureDefault')" />
            </div>
          </div>
          <div class="mh-switch-row">
            <label :for="`psu-${provider.id}`">{{ t('settings.providers.streamUsage') }}</label>
            <ToggleSwitch :input-id="`psu-${provider.id}`" v-model="form.streamUsage" />
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <footer class="mh-actionbar">
      <span v-if="dirty" class="mh-actionbar-info"><i class="pi pi-circle-fill dot" /> {{ t('settings.providers.unsaved') }}</span>
      <Button :label="t('settings.providers.revert')" severity="secondary" text :disabled="!dirty" @click="revert" />
      <Button :label="t('settings.providers.saveConnection')" icon="pi pi-check" :loading="saving" :disabled="!dirty" @click="save" />
    </footer>
  </div>
</template>

<style scoped>
.kind-box {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 10px 12px;
}
.kind-box .spec {
  border-top: 1px dashed var(--mh-border);
  padding: 8px 0;
}
.kind-box .name {
  width: 160px;
}
.kind-box .top {
  margin-top: 10px;
}
.mono {
  font-family: var(--mh-font-mono);
}

.detail {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 6px;
}
.head-text {
  flex: 1;
  min-width: 0;
}
.title {
  font-weight: 650;
  font-size: 16px;
}
.tabs {
  flex: 1;
}
.count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--mh-muted);
}
.link {
  color: var(--mh-accent);
  font-size: 13px;
}
.link.small {
  font-size: 12.5px;
}
.key {
  margin-top: 14px;
}
.test {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
}
.check {
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.wrap {
  flex-wrap: wrap;
}
.tools {
  margin-bottom: 10px;
}
.models {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
}
.model-item {
  border-bottom: 1px solid var(--mh-border);
}
.model-item:last-child {
  border-bottom: 0;
}
.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
}
.caps {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 0 14px;
  padding: 6px 12px 4px 38px;
  background: var(--mh-bg);
}
.caps .wide {
  grid-column: 1 / -1;
}
.rejected {
  color: var(--mh-warning);
}
.link-btn {
  border: 0;
  background: transparent;
  color: var(--mh-accent);
  cursor: pointer;
  padding: 0 4px;
}
.model-id {
  flex: 1;
  min-width: 0;
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.src {
  font-size: 11px;
  color: var(--mh-muted);
  border: 1px solid var(--mh-border);
  border-radius: 999px;
  padding: 0 7px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0 16px;
}
.mono :deep(textarea),
textarea.mono {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.dot {
  font-size: 7px;
  color: var(--mh-warning);
}
.mh-actionbar {
  position: sticky;
  bottom: 0;
}
</style>
