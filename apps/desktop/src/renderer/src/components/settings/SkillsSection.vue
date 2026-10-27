<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import { DEFAULT_SETTINGS, type CustomSkill } from '@monolith/contracts';
import { store } from '../../stores/app.ts';
import { useI18n } from 'vue-i18n';
import ToggleSwitch from 'primevue/toggleswitch';
import Checkbox from 'primevue/checkbox';
import type { Settings, SkillInfo } from '@monolith/contracts';
import { api } from '../../api.ts';

const props = defineProps<{ draft: Settings }>();
const { t, te } = useI18n();
const skills = ref<SkillInfo[]>([]);
const custom = ref<CustomSkill[]>([]);
onMounted(async () => {
  [skills.value, custom.value] = await Promise.all([api.call('skills.list'), api.call('skills.custom', {}).catch(() => [])]);
});
const isOn = (id: string) => props.draft.skills.enabled[id] ?? DEFAULT_SETTINGS.skills.enabled[id] ?? false;
const providerOptions = computed(() => [{ label: t('skills.config.embeddingNone'), value: null }, ...store.providers.filter((p) => p.kind === 'openai-compatible').map((p) => ({ label: p.name, value: p.id }))]);
const searchOptions = computed(() => (['duckduckgo', 'searxng', 'none'] as const).map((v) => ({ label: t(`skills.config.providers.${v}`), value: v })));
const modeOptions = computed(() => (['smart', 'legacy'] as const).map((v) => ({ label: t(`skills.config.httpModes.${v}`), value: v })));
const inputOptions = computed(() => (['auto', 'uia', 'legacy'] as const).map((v) => ({ label: t(`skills.config.inputModes.${v}`), value: v })));
const desktopAvailable = computed(() => skills.value.find((s) => s.id === 'keyboard')?.available ?? false);

function setEnabled(id: string, value: boolean) {
  props.draft.skills.enabled = { ...props.draft.skills.enabled, [id]: value };
}
</script>

<template>
  <p class="mh-hint">{{ t('skills.hint') }}</p>
  <div class="list">
    <div v-for="s in skills" :key="s.id" class="mh-switch-row">
      <div class="text">
        <label :for="`sk-${s.id}`">{{ te(`skills.names.${s.id}`) ? t(`skills.names.${s.id}`) : s.id }}</label>
        <p class="mh-hint">{{ te(`skills.desc.${s.id}`) ? t(`skills.desc.${s.id}`) : '' }}</p>
        <p v-if="s.tools.length" class="tools">{{ s.tools.join(' · ') }}</p>
        <p v-if="!s.available" class="mh-hint warn">{{ s.unavailableReason }}</p>
      </div>
      <ToggleSwitch :input-id="`sk-${s.id}`" :model-value="isOn(s.id)" :disabled="!s.available" @update:model-value="(v: boolean) => setEnabled(s.id, v)" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('skills.config.web') }}</h3>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="web-prov">{{ t('skills.config.provider') }}</label>
      <Select input-id="web-prov" v-model="draft.web.searchProvider" :options="searchOptions" option-label="label" option-value="value" />
    </div>
    <div v-if="draft.web.searchProvider === 'searxng'" class="mh-field grow">
      <label for="web-sx">{{ t('skills.config.searxngUrl') }}</label>
      <InputText id="web-sx" v-model="draft.web.searxngUrl" placeholder="http://127.0.0.1:8888" fluid />
    </div>
    <div class="mh-field">
      <label for="web-max">{{ t('skills.config.maxPageChars') }}</label>
      <InputNumber input-id="web-max" v-model="draft.web.maxPageChars" :min="2000" :max="200000" :step="1000" :allow-empty="false" />
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('skills.config.http') }}</h3>
  <p class="mh-hint">{{ t('skills.config.httpHint') }}</p>
  <div class="mh-row wrap">
    <div class="mh-field grow">
      <label for="http-ua">{{ t('skills.config.httpUserAgent') }}</label>
      <InputText id="http-ua" v-model="draft.web.httpUserAgent" fluid />
    </div>
    <div class="mh-field grow">
      <label for="http-proxy">{{ t('skills.config.httpProxyUrl') }}</label>
      <InputText id="http-proxy" v-model="draft.web.httpProxyUrl" placeholder="http://127.0.0.1:3128" fluid />
    </div>
  </div>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="http-mode">{{ t('skills.config.httpResponseMode') }}</label>
      <Select input-id="http-mode" v-model="draft.web.httpResponseMode" :options="modeOptions" option-label="label" option-value="value" />
    </div>
    <div class="mh-field">
      <label for="http-to">{{ t('skills.config.httpTimeoutSec') }}</label>
      <InputNumber input-id="http-to" v-model="draft.web.httpTimeoutSec" :min="5" :max="300" :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="http-max">{{ t('skills.config.httpMaxResponseKb') }}</label>
      <InputNumber input-id="http-max" v-model="draft.web.httpMaxResponseKb" :min="16" :max="4096" :step="64" :allow-empty="false" />
    </div>
  </div>
  <div class="mh-switch-row">
    <label for="http-cookies">{{ t('skills.config.httpUseCookies') }}</label>
    <ToggleSwitch input-id="http-cookies" v-model="draft.web.httpUseCookies" />
  </div>
  <div class="mh-switch-row">
    <label for="http-redir">{{ t('skills.config.httpFollowRedirects') }}</label>
    <ToggleSwitch input-id="http-redir" v-model="draft.web.httpFollowRedirects" />
  </div>

  <h3 class="mh-section-title">{{ t('skills.config.desktop') }}</h3>
  <p class="mh-hint">{{ t('skills.config.desktopHint') }}</p>
  <p v-if="skills.length && !desktopAvailable" class="mh-hint warn">{{ t('skills.config.desktopUnavailable') }}</p>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="dk-kb">{{ t('skills.config.keyboardMode') }}</label>
      <Select input-id="dk-kb" v-model="draft.desktop.keyboardMode" :options="inputOptions" option-label="label" option-value="value" :disabled="!desktopAvailable" />
    </div>
    <div class="mh-field">
      <label for="dk-mouse">{{ t('skills.config.mouseMode') }}</label>
      <Select input-id="dk-mouse" v-model="draft.desktop.mouseMode" :options="inputOptions" option-label="label" option-value="value" :disabled="!desktopAvailable" />
    </div>
  </div>
  <div class="mh-switch-row">
    <label for="dk-ai">{{ t('skills.config.allowAiChoose') }}</label>
    <ToggleSwitch input-id="dk-ai" v-model="draft.desktop.allowAiChoose" :disabled="!desktopAvailable" />
  </div>
  <div class="mh-switch-row">
    <label for="dk-fb">{{ t('skills.config.legacyFallback') }}</label>
    <ToggleSwitch input-id="dk-fb" v-model="draft.desktop.legacyFallback" :disabled="!desktopAvailable" />
  </div>

  <h3 class="mh-section-title">{{ t('skills.config.rag') }}</h3>
  <div class="mh-row wrap">
    <div class="mh-field">
      <label for="rag-prov">{{ t('skills.config.embeddingProvider') }}</label>
      <Select input-id="rag-prov" v-model="draft.rag.embeddingProviderId" :options="providerOptions" option-label="label" option-value="value" />
    </div>
    <div v-if="draft.rag.embeddingProviderId !== null" class="mh-field">
      <label for="rag-model">{{ t('skills.config.embeddingModel') }}</label>
      <InputText id="rag-model" v-model="draft.rag.embeddingModel" placeholder="text-embedding-3-small" />
    </div>
    <div class="mh-field">
      <label for="rag-lines">{{ t('skills.config.chunkLines') }}</label>
      <InputNumber input-id="rag-lines" v-model="draft.rag.chunkLines" :min="10" :max="400" :allow-empty="false" />
    </div>
    <div class="mh-field">
      <label for="rag-k">{{ t('skills.config.topK') }}</label>
      <InputNumber input-id="rag-k" v-model="draft.rag.topK" :min="1" :max="50" :allow-empty="false" />
    </div>
  </div>
  <p class="mh-hint">{{ t('skills.config.ragHint') }}</p>

  <h3 class="mh-section-title">{{ t('skills.config.custom') }}</h3>
  <p v-if="!custom.length" class="mh-hint">{{ t('skills.config.customEmpty') }}</p>
  <div v-for="c in custom" :key="c.name" class="mh-switch-row">
    <div class="text">
      <label :for="`csk-${c.name}`">{{ c.name }}</label>
      <p class="mh-hint">{{ c.description }}</p>
      <p class="tools">{{ c.path }}</p>
    </div>
    <ToggleSwitch :input-id="`csk-${c.name}`" :model-value="isOn(`skill:${c.name}`) || draft.skills.enabled[`skill:${c.name}`] === undefined" @update:model-value="(v: boolean) => setEnabled(`skill:${c.name}`, v)" />
  </div>

  <h3 class="mh-section-title">{{ t('skills.infoTitle') }}</h3>
  <div class="mh-row wrap">
    <div v-for="k in ['date', 'system', 'conversation'] as const" :key="k" class="mh-row">
      <Checkbox v-model="draft.skills.info[k]" binary :input-id="`info-${k}`" />
      <label :for="`info-${k}`">{{ t(`skills.info.${k}`) }}</label>
    </div>
  </div>
  <p class="mh-hint">{{ t('skills.later') }}</p>
</template>

<style scoped>
.text {
  min-width: 0;
}
.tools {
  font-family: var(--mh-font-mono);
  font-size: 11.5px;
  color: var(--mh-muted);
  margin: 2px 0 0;
}
.warn {
  color: var(--mh-warning);
}
.wrap {
  flex-wrap: wrap;
  gap: 18px;
}
.grow {
  flex: 1;
  min-width: 200px;
}
</style>
