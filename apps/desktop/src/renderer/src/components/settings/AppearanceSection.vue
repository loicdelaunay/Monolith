<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Select from 'primevue/select';
import SelectButton from 'primevue/selectbutton';
import Slider from 'primevue/slider';
import Tag from 'primevue/tag';
import type { Settings } from '@monolith/contracts';
import { FONT_CHOICES, MONO_CHOICES, THEMES, findTheme } from '../../theme/themes.ts';

const props = defineProps<{ draft: Settings }>();
const { t, locale } = useI18n();

const modes = ['system', 'light', 'dark'] as const;
const densities = ['compact', 'comfortable'] as const;
const titleBars = ['custom', 'system'] as const;
type BubbleKey = 'userBubble' | 'assistantBubble' | 'toolBubble';
const bubbles: BubbleKey[] = ['userBubble', 'assistantBubble', 'toolBubble'];

/** Accent affiché lorsque l'accent personnalisé est vide : celui du thème choisi. */
function themeAccent(): string {
  const th = findTheme(props.draft.appearance.theme);
  return (props.draft.appearance.mode === 'light' && th.light ? th.light : th.dark).accent;
}

function setColor(key: 'accent' | BubbleKey, e: Event) {
  props.draft.appearance[key] = (e.target as HTMLInputElement).value;
}
</script>

<template>
  <p class="mh-hint preview"><i class="pi pi-eye" /> {{ t('settings.appearance.previewHint') }}</p>

  <div class="mh-field">
    <span class="mh-label">{{ t('settings.appearance.mode') }}</span>
    <SelectButton v-model="draft.appearance.mode" :options="[...modes]" :option-label="(m: string) => t(`settings.appearance.modes.${m}`)" :allow-empty="false" :aria-label="t('settings.appearance.mode')" />
  </div>

  <div class="mh-field">
    <span class="mh-label">{{ t('settings.appearance.theme') }}</span>
    <div class="themes" role="radiogroup" :aria-label="t('settings.appearance.theme')">
      <button v-for="th in THEMES" :key="th.id" type="button" role="radio" :aria-checked="draft.appearance.theme === th.id" class="theme" :class="{ selected: draft.appearance.theme === th.id }" @click="draft.appearance.theme = th.id">
        <span class="swatch" :style="{ background: th.dark.bg, borderColor: th.dark.border }">
          <span class="bar" :style="{ background: th.dark.sidebar }" />
          <span class="dot" :style="{ background: th.dark.accent }" />
        </span>
        <span v-if="th.light" class="swatch" :style="{ background: th.light.bg, borderColor: th.light.border }">
          <span class="bar" :style="{ background: th.light.sidebar }" />
          <span class="dot" :style="{ background: th.light.accent }" />
        </span>
        <span class="theme-name">{{ th.name[locale === 'fr' ? 'fr' : 'en'] }}</span>
      </button>
    </div>
  </div>

  <div class="mh-field">
    <label for="accent">{{ t('settings.appearance.accent') }}</label>
    <div class="mh-row">
      <input id="accent" type="color" :value="draft.appearance.accent ?? themeAccent()" class="color" @input="setColor('accent', $event)" />
      <button v-if="draft.appearance.accent" type="button" class="link" @click="draft.appearance.accent = null">{{ t('settings.appearance.accentReset') }}</button>
      <span v-else class="mh-hint">{{ t('settings.appearance.accentReset') }}</span>
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.appearance.fonts') }}</h3>
  <div class="grid">
    <div class="mh-field">
      <label for="f-ui">{{ t('settings.appearance.uiFont') }}</label>
      <Select input-id="f-ui" v-model="draft.appearance.uiFont" :options="FONT_CHOICES" :option-label="(f: string) => t(`settings.appearance.fontNames.${f}`)" />
    </div>
    <div class="mh-field">
      <label for="f-in">{{ t('settings.appearance.inputFont') }}</label>
      <Select input-id="f-in" v-model="draft.appearance.inputFont" :options="FONT_CHOICES" :option-label="(f: string) => t(`settings.appearance.fontNames.${f}`)" />
    </div>
    <div class="mh-field">
      <label for="f-re">{{ t('settings.appearance.replyFont') }}</label>
      <Select input-id="f-re" v-model="draft.appearance.replyFont" :options="FONT_CHOICES" :option-label="(f: string) => t(`settings.appearance.fontNames.${f}`)" />
    </div>
    <div class="mh-field">
      <label for="f-mono">{{ t('settings.appearance.monoFont') }}</label>
      <Select input-id="f-mono" v-model="draft.appearance.monoFont" :options="MONO_CHOICES" :option-label="(f: string) => t(`settings.appearance.monoNames.${f}`)" />
    </div>
  </div>

  <div class="grid">
    <div class="mh-field">
      <label :id="'lbl-size'">{{ t('settings.appearance.readingSize') }} — {{ draft.appearance.readingSize }} px</label>
      <Slider v-model="draft.appearance.readingSize" :min="11" :max="24" :step="1" aria-labelledby="lbl-size" />
    </div>
    <div class="mh-field">
      <label :id="'lbl-zoom'">{{ t('settings.appearance.zoom') }} — {{ Math.round(draft.appearance.zoom * 100) }} %</label>
      <Slider v-model="draft.appearance.zoom" :min="0.7" :max="1.6" :step="0.05" aria-labelledby="lbl-zoom" />
    </div>
  </div>

  <div class="mh-field">
    <span class="mh-label">{{ t('settings.appearance.density') }}</span>
    <SelectButton v-model="draft.appearance.density" :options="[...densities]" :option-label="(d: string) => t(`settings.appearance.densities.${d}`)" :allow-empty="false" :aria-label="t('settings.appearance.density')" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.appearance.bubbles') }}</h3>
  <div class="bubbles">
    <div v-for="b in bubbles" :key="b" class="mh-row bubble">
      <input :id="b" type="color" :value="draft.appearance[b] ?? '#888888'" class="color" @input="setColor(b, $event)" />
      <label :for="b">{{ t(`settings.appearance.${b}`) }}</label>
      <button v-if="draft.appearance[b]" type="button" class="link" @click="draft.appearance[b] = null">{{ t('settings.appearance.bubbleDefault') }}</button>
      <span v-else class="mh-hint">{{ t('settings.appearance.bubbleDefault') }}</span>
    </div>
  </div>

  <h3 class="mh-section-title">{{ t('settings.appearance.titleBar') }}</h3>
  <div class="mh-row wrap">
    <SelectButton v-model="draft.appearance.titleBar" :options="[...titleBars]" :option-label="(m: string) => t(`settings.appearance.titleBars.${m}`)" :allow-empty="false" :aria-label="t('settings.appearance.titleBar')" />
    <Tag severity="secondary" icon="pi pi-replay" :value="t('settings.appearance.restartRequired')" />
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -6px 0 16px;
}
.themes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.theme {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: var(--mh-radius);
  padding: 8px;
  cursor: pointer;
  min-width: 150px;
}
.theme.selected {
  outline: 2px solid var(--mh-accent);
  outline-offset: 1px;
}
.theme > .swatch {
  position: relative;
  display: block;
  width: 64px;
  height: 40px;
  border-radius: 6px;
  border: 1px solid;
  overflow: hidden;
}
.theme {
  flex-direction: row;
  flex-wrap: wrap;
}
.theme-name {
  width: 100%;
  font-weight: 550;
  font-size: 13px;
  text-align: left;
}
.swatch .bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 18px;
}
.swatch .dot {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0 18px;
}
.color {
  width: 40px;
  height: 30px;
  padding: 0 2px;
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  background: var(--mh-surface);
  cursor: pointer;
}
.link {
  border: 0;
  background: transparent;
  color: var(--mh-accent);
  cursor: pointer;
  padding: 2px 4px;
}
.bubbles {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble label {
  min-width: 110px;
}
.wrap {
  flex-wrap: wrap;
}
</style>
