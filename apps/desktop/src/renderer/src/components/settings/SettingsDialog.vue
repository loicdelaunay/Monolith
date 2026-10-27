<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { Settings, SettingsPatch } from '@monolith/contracts';
import { api, errorMessage, host, plain } from '../../api.ts';
import { store } from '../../stores/app.ts';
import { uiState, type SettingsSectionId } from '../../ui-state.ts';
import GeneralSection from './GeneralSection.vue';
import ChatSection from './ChatSection.vue';
import AppearanceSection from './AppearanceSection.vue';
import ProvidersSection from './ProvidersSection.vue';
import ResetSection from './ResetSection.vue';
import AboutSection from './AboutSection.vue';
import PlannedSection from './PlannedSection.vue';
import SkillsSection from './SkillsSection.vue';
import AgentsSection from './AgentsSection.vue';
import PermissionsSection from './PermissionsSection.vue';
import LoopSection from './LoopSection.vue';
import ShortcutsSection from './ShortcutsSection.vue';
import McpSection from './McpSection.vue';
import MemorySection from './MemorySection.vue';
import NotificationsSection from './NotificationsSection.vue';
import SchedulerSection from './SchedulerSection.vue';
import AdvancedSection from './AdvancedSection.vue';
import LocalModelsSection from './LocalModelsSection.vue';

const { t, tm } = useI18n();
const confirm = useConfirm();
const toast = useToast();

/** Ordre imposé : Avancé juste avant Réinitialisation. */
const SECTIONS: { id: SettingsSectionId; icon: string; tranche?: string }[] = [
  { id: 'general', icon: 'pi-sliders-h' },
  { id: 'chat', icon: 'pi-comments' },
  { id: 'appearance', icon: 'pi-palette' },
  { id: 'providers', icon: 'pi-server' },
  { id: 'local', icon: 'pi-desktop' },
  { id: 'skills', icon: 'pi-bolt' },
  { id: 'agents', icon: 'pi-sitemap' },
  { id: 'mcp', icon: 'pi-link' },
  { id: 'memory', icon: 'pi-database' },
  { id: 'permissions', icon: 'pi-shield' },
  { id: 'loop', icon: 'pi-replay' },
  { id: 'shortcuts', icon: 'pi-key' },
  { id: 'scheduler', icon: 'pi-clock' },
  { id: 'notifications', icon: 'pi-bell' },
  { id: 'server', icon: 'pi-cloud', tranche: 'later' },
  { id: 'advanced', icon: 'pi-microchip' },
  { id: 'reset', icon: 'pi-refresh' },
  { id: 'about', icon: 'pi-info-circle' },
];

const draft = reactive({ value: null as Settings | null });
const initialJson = ref('');
const providersDirty = ref(false);
const query = ref('');

/** Recherche : libellé de la section et libellés de ses réglages. */
function sectionText(id: SettingsSectionId): string {
  const own = t(`settings.sections.${id}`);
  const nested = ['general', 'chat', 'appearance', 'providers', 'reset', 'about'].includes(id)
    ? JSON.stringify(tm(`settings.${id}`))
    : id === 'skills'
      ? JSON.stringify(tm('skills'))
      : id === 'permissions'
        ? JSON.stringify(tm('permissionsSettings'))
        : id === 'loop'
          ? JSON.stringify(tm('loopSettings'))
          : id === 'agents'
            ? JSON.stringify(tm('agentsSettings'))
            : '';
  return `${own} ${nested}`.toLowerCase();
}
const visibleSections = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? SECTIONS.filter((s) => sectionText(s.id).includes(q)) : SECTIONS;
});
const current = computed(() => SECTIONS.find((s) => s.id === uiState.settingsSection) ?? SECTIONS[0]!);
const dirty = computed(() => draft.value !== null && JSON.stringify(draft.value) !== initialJson.value);

function load() {
  draft.value = plain(store.settings!);
  initialJson.value = JSON.stringify(draft.value);
  uiState.appearancePreview = draft.value.appearance;
}

watch(
  () => uiState.settingsOpen,
  (open) => {
    if (open) load();
    else {
      uiState.appearancePreview = null;
      draft.value = null;
    }
  },
);

/** Réglages modifiés ailleurs (ou réinitialisés) : on recale les sections non modifiées du brouillon. */
watch(
  () => store.settings,
  (s) => {
    if (!s || !draft.value) return;
    const before = JSON.parse(initialJson.value) as Settings;
    for (const key of Object.keys(s) as (keyof Settings)[]) {
      if (JSON.stringify(draft.value[key]) === JSON.stringify(before[key])) (draft.value as Record<string, unknown>)[key] = plain(s[key]);
    }
    initialJson.value = JSON.stringify({ ...before, ...s });
    uiState.appearancePreview = draft.value.appearance;
  },
);

function close(force = false) {
  if (!force && (dirty.value || providersDirty.value)) {
    confirm.require({
      header: t('settings.discardTitle'),
      message: t('settings.discardMessage'),
      icon: 'pi pi-exclamation-triangle',
      rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
      acceptProps: { label: t('settings.discard'), severity: 'danger' },
      accept: () => close(true),
    });
    return;
  }
  providersDirty.value = false;
  uiState.settingsOpen = false;
}

const saving = ref(false);
async function save() {
  if (!draft.value) return;
  const before = JSON.parse(initialJson.value) as Settings;
  const patch: SettingsPatch = {};
  for (const key of Object.keys(draft.value) as (keyof Settings)[]) {
    if (JSON.stringify(draft.value[key]) !== JSON.stringify(before[key])) (patch as Record<string, unknown>)[key] = draft.value[key];
  }
  const restart = draft.value.appearance.titleBar !== before.appearance.titleBar;
  saving.value = true;
  try {
    // Enregistrement asynchrone dans le moteur : l'interface reste réactive.
    await api.call('settings.update', patch);
    toast.add({ severity: 'success', summary: t('settings.savedToast'), life: 2500 });
    close(true);
    if (restart) {
      confirm.require({
        header: t('settings.appearance.restartRequired'),
        message: t('settings.appearance.titleBar'),
        rejectProps: { label: t('common.close'), severity: 'secondary', outlined: true },
        acceptProps: { label: t('settings.appearance.restartNow') },
        accept: () => void host.relaunch(),
      });
    }
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 6000 });
  } finally {
    saving.value = false;
  }
}

function onVisible(v: boolean) {
  if (!v) close();
}
</script>

<template>
  <Dialog
    :visible="uiState.settingsOpen"
    modal
    :header="t('settings.title')"
    :style="{ width: 'min(1100px, 96vw)', height: 'min(820px, 92vh)' }"
    :content-style="{ padding: 0, display: 'flex', flex: '1', minHeight: 0 }"
    :close-on-escape="true"
    class="mh-settings-dialog"
    @update:visible="onVisible"
  >
    <div v-if="draft.value" class="layout">
      <nav class="nav" :aria-label="t('settings.title')">
        <IconField>
          <InputIcon class="pi pi-search" />
          <InputText v-model="query" size="small" :placeholder="t('settings.searchPlaceholder')" :aria-label="t('settings.searchPlaceholder')" fluid />
        </IconField>
        <ul role="list">
          <li v-for="s in visibleSections" :key="s.id">
            <button type="button" class="nav-item" :class="{ active: s.id === current.id }" :aria-current="s.id === current.id ? 'page' : undefined" @click="uiState.settingsSection = s.id">
              <i class="pi" :class="s.icon" />
              <span>{{ t(`settings.sections.${s.id}`) }}</span>
              <span v-if="s.tranche" class="soon">{{ s.tranche === 'later' ? t('settings.laterBadge') : s.tranche }}</span>
            </button>
          </li>
          <li v-if="visibleSections.length === 0" class="mh-hint">{{ t('settings.noMatch') }}</li>
        </ul>
      </nav>
      <section class="content" :aria-label="t(`settings.sections.${current.id}`)">
        <h2>{{ t(`settings.sections.${current.id}`) }}</h2>
        <GeneralSection v-if="current.id === 'general'" :draft="draft.value" />
        <ChatSection v-else-if="current.id === 'chat'" :draft="draft.value" />
        <AppearanceSection v-else-if="current.id === 'appearance'" :draft="draft.value" />
        <ProvidersSection v-else-if="current.id === 'providers'" :draft="draft.value" @update:dirty="(v: boolean) => (providersDirty = v)" />
        <SkillsSection v-else-if="current.id === 'skills'" :draft="draft.value" />
        <AgentsSection v-else-if="current.id === 'agents'" :draft="draft.value" />
        <PermissionsSection v-else-if="current.id === 'permissions'" :draft="draft.value" />
        <LoopSection v-else-if="current.id === 'loop'" :draft="draft.value" />
        <ShortcutsSection v-else-if="current.id === 'shortcuts'" :draft="draft.value" />
        <McpSection v-else-if="current.id === 'mcp'" />
        <MemorySection v-else-if="current.id === 'memory'" :draft="draft.value" />
        <NotificationsSection v-else-if="current.id === 'notifications'" :draft="draft.value" />
        <SchedulerSection v-else-if="current.id === 'scheduler'" />
        <AdvancedSection v-else-if="current.id === 'advanced'" :draft="draft.value" />
        <LocalModelsSection v-else-if="current.id === 'local'" :draft="draft.value" />
        <ResetSection v-else-if="current.id === 'reset'" />
        <AboutSection v-else-if="current.id === 'about'" :draft="draft.value" />
        <PlannedSection v-else :tranche="current.tranche ?? ''" />
      </section>
    </div>
    <template #footer>
      <div class="footer">
        <span v-if="dirty" class="state"><i class="pi pi-circle-fill" /> {{ t('common.unsaved') }}</span>
        <Button :label="t('common.cancel')" severity="secondary" text @click="close()" />
        <Button :label="t('common.save')" icon="pi pi-check" :loading="saving" :disabled="!dirty" @click="save" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  border-top: 1px solid var(--mh-border);
}
.nav {
  width: 230px;
  flex: none;
  padding: 12px 10px;
  border-right: 1px solid var(--mh-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  background: transparent;
  padding: 7px 10px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--mh-text);
}
.nav-item:hover {
  background: var(--mh-hover);
}
.nav-item.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
  color: var(--mh-text);
  font-weight: 600;
}
.nav-item .pi {
  width: 16px;
  color: var(--mh-muted);
}
.nav-item.active .pi {
  color: var(--mh-accent);
}
.soon {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--mh-muted);
  border: 1px solid var(--mh-border);
  border-radius: 999px;
  padding: 0 6px;
  font-weight: 500;
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 26px 28px;
}
.content h2 {
  margin: 0 0 16px;
  font-size: 18px;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: flex-end;
}
.state {
  margin-right: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--mh-muted);
}
.state .pi {
  font-size: 7px;
  color: var(--mh-warning);
}
@media (max-width: 760px) {
  .layout {
    flex-direction: column;
  }
  .nav {
    width: 100%;
    border-right: 0;
    border-bottom: 1px solid var(--mh-border);
    max-height: 34%;
  }
  .content {
    padding: 14px;
  }
}
</style>
