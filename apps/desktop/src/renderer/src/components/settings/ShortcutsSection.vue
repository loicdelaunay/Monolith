<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import { comboFromEvent, RESERVED_COMBOS, validCombo, type ReasoningLevel, type Settings, type ShortcutItem } from '@monolith/contracts';
import { store } from '../../stores/app.ts';

const props = defineProps<{ draft: Settings }>();
const { t } = useI18n();

const items = computed(() => props.draft.shortcuts.items);
const recording = ref<string | null>(null);
const conflict = ref<string | null>(null);

function add() {
  const used = new Set([...RESERVED_COMBOS, ...items.value.map((i) => i.keys)]);
  const free = [...'123456789'].map((d) => `Alt+${d}`).find((k) => !used.has(k)) ?? 'Alt+0';
  items.value.push({ id: `sc-${Date.now().toString(36)}`, keys: free, label: '', providerId: null, model: null, mode: null, agentMode: null, reasoningLevel: null });
}
function remove(item: ShortcutItem) {
  items.value.splice(items.value.indexOf(item), 1);
}
function record(item: ShortcutItem, e: KeyboardEvent) {
  if (e.key === 'Tab') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    recording.value = null;
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo || !validCombo(combo)) return;
  if (RESERVED_COMBOS.includes(combo) || items.value.some((i) => i !== item && i.keys === combo)) {
    conflict.value = item.id;
    return;
  }
  conflict.value = null;
  item.keys = combo;
  recording.value = null;
}

const providerOptions = computed(() => [{ label: t('settings.shortcutsSettings.unchanged'), value: null }, ...store.providers.map((p) => ({ label: p.name, value: p.id }))]);
const modelOptions = (item: ShortcutItem) => (store.providers.find((p) => p.id === item.providerId)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id }));
function setProvider(item: ShortcutItem, id: number | null) {
  item.providerId = id;
  item.model = store.providers.find((p) => p.id === id)?.models.find((m) => m.enabled)?.id ?? null;
}
const modeOptions = computed(() => [
  { label: t('settings.shortcutsSettings.unchanged'), value: null },
  { label: t('modes.chat'), value: 'chat' },
  { label: t('modes.plan'), value: 'plan' },
  { label: t('modes.propose'), value: 'propose' },
  { label: t('modes.execute'), value: 'execute' },
]);
const modeValue = (i: ShortcutItem) => (i.agentMode ?? i.mode ?? null);
function setMode(i: ShortcutItem, v: string | null) {
  i.mode = v === null ? null : v === 'chat' ? 'chat' : 'agent';
  i.agentMode = v === 'plan' || v === 'propose' || v === 'execute' ? v : null;
}
const LEVELS: ReasoningLevel[] = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
const reasoningOptions = computed(() => [{ label: t('settings.shortcutsSettings.unchanged'), value: null }, ...LEVELS.map((l) => ({ label: t(`reasoningLevels.${l}`), value: l }))]);
</script>

<template>
  <div class="mh-switch-row">
    <div>
      <label for="sc-builtin">{{ t('settings.shortcutsSettings.builtin') }}</label>
      <p class="mh-hint">{{ t('settings.shortcutsSettings.builtinHint') }}</p>
    </div>
    <ToggleSwitch input-id="sc-builtin" v-model="draft.shortcuts.builtin" />
  </div>

  <h3 class="mh-section-title">{{ t('settings.shortcutsSettings.items') }}</h3>
  <p class="mh-hint">{{ t('settings.shortcutsSettings.itemsHint') }}</p>
  <p v-if="!items.length" class="mh-muted">{{ t('settings.shortcutsSettings.empty') }}</p>
  <div v-for="item in items" :key="item.id" class="item">
    <div class="mh-row wrap">
      <button type="button" class="keys" :class="{ rec: recording === item.id, bad: conflict === item.id }" :aria-label="t('settings.shortcutsSettings.keys')" @click="recording = item.id" @keydown="recording === item.id && record(item, $event)" @blur="recording = null">
        <kbd>{{ recording === item.id ? t('settings.shortcutsSettings.record') : item.keys }}</kbd>
      </button>
      <InputText v-model="item.label" :placeholder="t('settings.shortcutsSettings.label')" :aria-label="t('settings.shortcutsSettings.label')" maxlength="60" class="label" />
      <Button icon="pi pi-trash" text severity="danger" size="small" :aria-label="t('settings.shortcutsSettings.remove')" @click="remove(item)" />
    </div>
    <small v-if="conflict === item.id" class="err">{{ t('settings.shortcutsSettings.conflict') }}</small>
    <div class="mh-row wrap fields">
      <Select :model-value="item.providerId" :options="providerOptions" option-label="label" option-value="value" :aria-label="t('settings.shortcutsSettings.provider')" :placeholder="t('settings.shortcutsSettings.provider')" class="sel" @update:model-value="(v: number | null) => setProvider(item, v)" />
      <Select v-model="item.model" :options="modelOptions(item)" option-label="label" option-value="value" filter :disabled="item.providerId === null" :aria-label="t('settings.shortcutsSettings.model')" :placeholder="t('settings.shortcutsSettings.model')" class="sel" />
      <Select :model-value="modeValue(item)" :options="modeOptions" option-label="label" option-value="value" :aria-label="t('settings.shortcutsSettings.mode')" :placeholder="t('settings.shortcutsSettings.mode')" class="sel" @update:model-value="(v: string | null) => setMode(item, v)" />
      <Select v-model="item.reasoningLevel" :options="reasoningOptions" option-label="label" option-value="value" :aria-label="t('settings.shortcutsSettings.reasoning')" :placeholder="t('settings.shortcutsSettings.reasoning')" class="sel" />
    </div>
  </div>
  <Button :label="t('settings.shortcutsSettings.add')" icon="pi pi-plus" severity="secondary" outlined size="small" @click="add" />
</template>

<style scoped>
.item {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.keys {
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: var(--mh-radius-sm);
  padding: 4px 10px;
  cursor: pointer;
  min-width: 110px;
}
.keys.rec {
  border-color: var(--mh-accent);
}
.keys.bad {
  border-color: var(--mh-danger);
}
kbd {
  font-family: var(--mh-font-mono);
  font-size: 12px;
}
.label {
  flex: 1;
  min-width: 160px;
}
.fields {
  margin-top: 8px;
}
.sel {
  min-width: 160px;
  flex: 1;
}
.err {
  color: var(--mh-danger);
}
</style>
