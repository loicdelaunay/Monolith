<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Popover from 'primevue/popover';
import ToggleSwitch from 'primevue/toggleswitch';
import { useToast } from 'primevue/usetoast';
import { DEFAULT_SETTINGS, type Conversation, type PermissionPolicy, type SettingsPatch, type SkillInfo } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';
import { store } from '../stores/app.ts';
import { uiState } from '../ui-state.ts';

const props = defineProps<{ conversation: Conversation }>();
const { t, te } = useI18n();
const toast = useToast();
const pop = ref<InstanceType<typeof Popover> | null>(null);
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 });

// ---------- Mode de la conversation (Chat, ou Agent Plan / Proposition / Exécution) ----------
const MODES = [
  { key: 'chat', icon: 'pi-comment' },
  { key: 'plan', icon: 'pi-search' },
  { key: 'propose', icon: 'pi-file-edit' },
  { key: 'execute', icon: 'pi-play' },
] as const;
const mode = computed(() => (props.conversation.mode === 'chat' ? 'chat' : props.conversation.agentMode));
async function setMode(key: (typeof MODES)[number]['key']) {
  try {
    await api.call('conversations.update', { id: props.conversation.id, patch: key === 'chat' ? { mode: 'chat' } : { mode: 'agent', agentMode: key } });
  } catch (e) {
    fail(e);
  }
}

// ---------- Réglages globaux : politique d'autorisation et skills ----------
async function save(patch: SettingsPatch) {
  try {
    await api.call('settings.update', patch);
  } catch (e) {
    fail(e);
  }
}
const POLICIES: PermissionPolicy[] = ['rules', 'ask', 'deny_all'];
const policy = computed(() => store.settings?.permissions.policy ?? 'rules');

const skills = ref<SkillInfo[]>([]);
const skillName = (id: string) => (te(`skills.names.${id}`) ? t(`skills.names.${id}`) : id);
const sortedSkills = computed(() => [...skills.value].sort((a, b) => Number(b.available) - Number(a.available) || skillName(a.id).localeCompare(skillName(b.id))));
const isOn = (id: string) => store.settings?.skills.enabled[id] ?? DEFAULT_SETTINGS.skills.enabled[id] ?? false;
function setSkill(id: string, value: boolean) {
  if (!store.settings) return;
  void save({ skills: { enabled: { ...store.settings.skills.enabled, [id]: value } } });
}

async function open(e: Event) {
  pop.value?.toggle(e);
  skills.value = await api.call('skills.list').catch(() => skills.value);
}
function manage() {
  pop.value?.hide();
  uiState.settingsSection = 'skills';
  uiState.settingsOpen = true;
}
const summary = computed(() => `${t('composer.quick.title')} — ${t(`modes.${mode.value}`)} · ${t(`permissionsSettings.policies.${policy.value}`)}`);
</script>

<template>
  <button type="button" class="round-btn" :aria-label="summary" aria-haspopup="dialog" v-tooltip.top="summary" @click="open">
    <i class="pi pi-sliders-h" />
  </button>
  <Popover ref="pop">
    <div class="qs" role="dialog" :aria-label="t('composer.quick.title')">
      <div class="col">
        <section>
          <h4>{{ t('modes.label') }} <span class="mh-hint">(Ctrl+Maj+M)</span></h4>
          <div class="options" role="radiogroup" :aria-label="t('modes.label')">
            <button v-for="m in MODES" :key="m.key" type="button" class="opt" role="radio" :aria-checked="m.key === mode" :class="{ active: m.key === mode }" @click="setMode(m.key)">
              <i class="pi" :class="m.icon" />
              <span class="text">
                <span>{{ t(`modes.${m.key}`) }}</span>
                <span class="mh-hint">{{ t(`modes.hint.${m.key}`) }}</span>
              </span>
              <i v-if="m.key === mode" class="pi pi-check check" />
            </button>
          </div>
        </section>
        <section>
          <h4>{{ t('composer.quick.permissions') }} <span class="mh-hint">{{ t('composer.quick.global') }}</span></h4>
          <div class="segmented" role="radiogroup" :aria-label="t('composer.quick.permissions')">
            <button v-for="p in POLICIES" :key="p" type="button" role="radio" :aria-checked="p === policy" :class="{ active: p === policy }" :title="t(`permissionsSettings.policyHints.${p}`)" @click="save({ permissions: { policy: p } })">
              {{ t(`permissionsSettings.policies.${p}`) }}
            </button>
          </div>
          <p class="mh-hint hint">{{ t(`permissionsSettings.policyHints.${policy}`) }}</p>
        </section>
      </div>
      <section class="col skills">
        <h4>{{ t('composer.quick.skills') }} <span class="mh-hint">{{ t('composer.quick.global') }}</span></h4>
        <ul>
          <li v-for="s in sortedSkills" :key="s.id" :class="{ off: !s.available }" :title="s.available ? undefined : s.unavailableReason">
            <label :for="`qs-${s.id}`">{{ skillName(s.id) }}</label>
            <ToggleSwitch :input-id="`qs-${s.id}`" :model-value="isOn(s.id)" :disabled="!s.available" @update:model-value="(v: boolean) => setSkill(s.id, v)" />
          </li>
          <li v-if="!skills.length" class="mh-hint">…</li>
        </ul>
        <button type="button" class="manage" @click="manage"><i class="pi pi-cog" /> {{ t('composer.quick.allSkills') }}</button>
      </section>
    </div>
  </Popover>
</template>

<style scoped>
.round-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--mh-text);
  cursor: pointer;
  transition: background var(--mh-transition);
}
.round-btn:hover {
  background: var(--mh-hover);
}
.qs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  width: min(600px, 88vw);
}
.col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
section {
  min-width: 0;
}
h4 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mh-muted);
}
h4 .mh-hint {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 7px 8px;
  border-radius: var(--mh-radius-sm);
  text-align: left;
  cursor: pointer;
}
.opt:hover {
  background: var(--mh-hover);
}
.opt.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  color: var(--mh-accent);
}
.opt .pi {
  color: var(--mh-muted);
}
.opt.active .pi {
  color: var(--mh-accent);
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 13px;
}
.text .mh-hint {
  font-size: 11.5px;
  line-height: 1.3;
}
.check {
  margin-left: auto;
}
.segmented {
  display: flex;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  overflow: hidden;
}
.segmented button {
  flex: 1;
  border: 0;
  border-right: 1px solid var(--mh-border);
  background: transparent;
  padding: 6px 4px;
  font-size: 12.5px;
  cursor: pointer;
}
.segmented button:last-child {
  border-right: 0;
}
.segmented button:hover {
  background: var(--mh-hover);
}
.segmented button.active {
  background: color-mix(in srgb, var(--mh-accent) 18%, transparent);
  color: var(--mh-accent);
  font-weight: 600;
}
.hint {
  margin: 6px 0 0;
  font-size: 11.5px;
}
.skills ul {
  list-style: none;
  margin: 0;
  padding: 0 4px 0 0;
  max-height: 280px;
  overflow: auto;
}
.skills li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 2px;
  font-size: 13px;
}
.skills li.off {
  color: var(--mh-muted);
}
.skills label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.manage {
  margin-top: 6px;
  border: 0;
  border-top: 1px solid var(--mh-border);
  background: transparent;
  padding: 8px 2px 0;
  text-align: left;
  cursor: pointer;
  color: var(--mh-accent);
  font-size: 13px;
}
@media (max-width: 640px) {
  .qs {
    grid-template-columns: 1fr;
  }
}
</style>
