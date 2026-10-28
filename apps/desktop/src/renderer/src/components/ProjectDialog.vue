<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { useToast } from 'primevue/usetoast';
import { api, errorMessage, host } from '../api.ts';
import { store } from '../stores/app.ts';
import { uiState } from '../ui-state.ts';
import { ATTACHMENT_LIMITS, type AttachmentRef } from '@monolith/contracts';
import { uploadFiles } from '../lib/attachments.ts';
import AttachmentChip from './AttachmentChip.vue';

const { t } = useI18n();
const toast = useToast();

const ICONS = ['folder', 'code', 'book', 'briefcase', 'globe', 'database', 'server', 'mobile', 'palette', 'chart-bar', 'cog', 'star', 'heart', 'bolt', 'flag', 'shield'];
const COLORS = ['', '#5b5bd6', '#1D6FC8', '#0f8a7a', '#2b8a4e', '#c27c0e', '#d93f3f', '#b4369b', '#6b7280'];

const form = reactive({ name: '', icon: 'folder', color: '', instructions: '' });
const initial = ref('');
const nameInput = ref<{ $el: HTMLInputElement } | null>(null);
const instructionsInput = ref<{ $el: HTMLTextAreaElement } | null>(null);
const saving = ref(false);

const project = computed(() => (uiState.projectDialog.projectId !== null ? (store.projects.find((p) => p.id === uiState.projectDialog.projectId) ?? null) : null));
const dirty = computed(() => JSON.stringify(form) !== initial.value);

watch(
  () => uiState.projectDialog.open,
  async (open) => {
    if (!open) return;
    const p = project.value;
    Object.assign(form, { name: p?.name ?? '', icon: p?.icon ?? 'folder', color: p?.color ?? '', instructions: p?.instructions ?? '' });
    pending.value = [];
    initial.value = JSON.stringify(form);
    await nextTick();
    if (uiState.projectDialog.focus === 'instructions') instructionsInput.value?.$el.focus();
    else nameInput.value?.$el.focus();
  },
);

function fail(e: unknown) {
  toast.add({ severity: 'error', summary: t('errors.invalid_argument'), detail: errorMessage(e), life: 6000 });
}

async function save() {
  if (!form.name.trim()) return;
  saving.value = true;
  try {
    if (project.value) {
      await api.call('projects.update', { id: project.value.id, patch: { ...form } });
      uiState.projectDialog.open = false;
    } else {
      // Après création, la fenêtre reste ouverte pour ajouter les dossiers sources.
      const p = await api.call('projects.create', { ...form, attachmentIds: pending.value.map((a) => a.id) });
      pending.value = [];
      if (!store.projects.some((x) => x.id === p.id)) store.projects = [...store.projects, p];
      uiState.projectDialog.projectId = p.id;
      initial.value = JSON.stringify(form);
    }
  } catch (e) {
    fail(e);
  } finally {
    saving.value = false;
  }
}

// Pièces jointes du projet : envoyées à chaque conversation du projet. Avant la création, gardées en attente
// et rattachées à la création ; ensuite, ajout et retrait immédiats (comme les dossiers).
const pending = ref<AttachmentRef[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const projectAttachments = computed(() => (project.value ? project.value.attachments : pending.value));
async function addAttachments(files: File[]) {
  if (!files.length) return;
  const room = ATTACHMENT_LIMITS.perProject - projectAttachments.value.length;
  if (files.length > room) toast.add({ severity: 'warn', summary: t('project.tooManyAttachments', { max: ATTACHMENT_LIMITS.perProject }), life: 5000 });
  const { refs, errors } = await uploadFiles(files.slice(0, Math.max(0, room)));
  for (const err of errors) toast.add({ severity: 'error', summary: t('composer.attachmentRejected'), detail: err, life: 8000 });
  if (!refs.length) return;
  if (project.value) await api.call('projects.addAttachments', { id: project.value.id, attachmentIds: refs.map((r) => r.id) }).catch(fail);
  else pending.value = [...pending.value, ...refs];
}
async function removeAttachment(id: number) {
  if (project.value) await api.call('projects.removeAttachment', { id: project.value.id, attachmentId: id }).catch(fail);
  else pending.value = pending.value.filter((a) => a.id !== id);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  void addAttachments([...(input.files ?? [])]);
  input.value = '';
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  void addAttachments([...(e.dataTransfer?.files ?? [])]);
}

// Import d'un permission.json : aperçu des règles, puis import explicite (opération immédiate).
const importJson = ref('');
const importPreview = ref<{ rules: { decision: string; tool: string; family: string; resource: string }[]; errors: string[] } | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
async function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file || !project.value) return;
  importJson.value = await file.text();
  importPreview.value = await api.call('permissions.previewImport', { projectId: project.value.id, json: importJson.value }).catch((err) => ({ rules: [], errors: [errorMessage(err)] }));
}
async function applyImport() {
  if (!project.value) return;
  try {
    const rules = await api.call('permissions.import', { projectId: project.value.id, json: importJson.value });
    toast.add({ severity: 'success', summary: t('project.imported', { count: rules.length }), life: 3000 });
    importPreview.value = null;
  } catch (e) {
    fail(e);
  }
}

// Dossiers : opérations immédiates (ajout/retrait), signalées comme telles.
async function addFolder() {
  if (!project.value) return;
  const path = await host.pickDirectory(t('project.addFolder'));
  if (!path) return;
  await api.call('projects.addFolder', { id: project.value.id, path }).catch(fail);
}
async function removeFolder(folderId: number) {
  await api.call('projects.removeFolder', { folderId }).catch(fail);
}
</script>

<template>
  <Dialog v-model:visible="uiState.projectDialog.open" modal :header="project ? t('project.edit') : t('project.new')" :style="{ width: 'min(640px, 94vw)' }">
    <form class="form" @submit.prevent="save">
      <div class="mh-field">
        <label for="project-name">{{ t('project.name') }}</label>
        <InputText id="project-name" ref="nameInput" v-model="form.name" maxlength="120" fluid />
      </div>

      <div class="mh-field">
        <span class="mh-label">{{ t('project.icon') }}</span>
        <div class="icons" role="radiogroup" :aria-label="t('project.icon')">
          <button v-for="icon in ICONS" :key="icon" type="button" role="radio" :aria-checked="form.icon === icon" :aria-label="icon" class="icon-choice" :class="{ selected: form.icon === icon }" @click="form.icon = icon">
            <i class="pi" :class="`pi-${icon}`" :style="form.color ? { color: form.color } : undefined" />
          </button>
        </div>
      </div>

      <div class="mh-field">
        <span class="mh-label">{{ t('project.color') }}</span>
        <div class="colors" role="radiogroup" :aria-label="t('project.color')">
          <button v-for="color in COLORS" :key="color || 'none'" type="button" role="radio" :aria-checked="form.color === color" :aria-label="color || t('project.noColor')" class="color-choice" :class="{ selected: form.color === color, none: !color }" :style="color ? { background: color } : undefined" @click="form.color = color" />
        </div>
      </div>

      <div class="mh-field">
        <label for="project-instructions">{{ t('project.instructions') }}</label>
        <Textarea id="project-instructions" ref="instructionsInput" v-model="form.instructions" rows="7" auto-resize fluid class="mono" />
        <p class="mh-hint">{{ t('project.instructionsHint') }}</p>
      </div>

      <div class="mh-field">
        <div class="mh-row between">
          <span class="mh-label">{{ t('project.attachments') }}</span>
          <span v-if="project" class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
        </div>
        <div class="drop" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
          <div v-if="projectAttachments.length" class="chips">
            <AttachmentChip v-for="a in projectAttachments" :key="a.id" :attachment="a" removable @remove="removeAttachment(a.id)" />
          </div>
          <p v-else class="mh-muted">{{ t('project.noAttachments') }}</p>
          <div><Button :label="t('project.addAttachments')" icon="pi pi-paperclip" size="small" severity="secondary" outlined @click="fileInput?.click()" /></div>
        </div>
        <input ref="fileInput" type="file" multiple hidden @change="onPick" />
        <p class="mh-hint">{{ t('project.attachmentsHint', { max: ATTACHMENT_LIMITS.perProject }) }}</p>
      </div>

      <div v-if="project" class="mh-field">
        <div class="mh-row between">
          <span class="mh-label">{{ t('project.folders') }}</span>
          <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
        </div>
        <ul class="folders">
          <li v-for="f in project.folders" :key="f.id" :class="{ missing: !f.available }">
            <i class="pi" :class="f.available ? 'pi-folder' : 'pi-exclamation-triangle'" />
            <span class="path" :title="f.path">{{ f.path }}</span>
            <span v-if="!f.available" class="missing-label">{{ t('project.folderMissing') }}</span>
            <button type="button" class="mh-icon-btn" :aria-label="t('common.remove')" @click="removeFolder(f.id)"><i class="pi pi-times" /></button>
          </li>
          <li v-if="project.folders.length === 0" class="mh-muted">{{ t('project.noFolders') }}</li>
        </ul>
        <div><Button :label="t('project.addFolder')" icon="pi pi-folder-plus" size="small" severity="secondary" outlined @click="addFolder" /></div>
        <p class="mh-hint">{{ t('project.foldersHint') }}</p>
      </div>

      <div v-if="project" class="mh-field">
        <div class="mh-row between">
          <span class="mh-label">{{ t('project.importPermissions') }}</span>
          <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
        </div>
        <p class="mh-hint">{{ t('project.importHint') }}</p>
        <div><Button :label="t('project.chooseJson')" icon="pi pi-upload" size="small" severity="secondary" outlined @click="importInput?.click()" /></div>
        <input ref="importInput" type="file" accept=".json,application/json" hidden @change="onImportFile" />
        <div v-if="importPreview" class="import">
          <p v-for="(err, i) in importPreview.errors" :key="i" class="err">{{ err }}</p>
          <p class="mh-hint">{{ t('project.previewRules', { count: importPreview.rules.length }) }}</p>
          <ul>
            <li v-for="(r, i) in importPreview.rules" :key="i"><strong>{{ t(`permissionsSettings.decisions.${r.decision}`) }}</strong> <code>{{ r.tool }}</code><code v-if="r.resource"> ({{ r.resource }})</code></li>
          </ul>
          <Button :label="t('project.importApply')" size="small" :disabled="importPreview.errors.length > 0 || importPreview.rules.length === 0" @click="applyImport" />
        </div>
      </div>
    </form>
    <template #footer>
      <span v-if="dirty" class="mh-hint unsaved"><i class="pi pi-circle-fill" /> {{ t('common.unsaved') }}</span>
      <Button :label="t('common.cancel')" severity="secondary" text @click="uiState.projectDialog.open = false" />
      <Button :label="project ? t('common.save') : t('common.create')" :loading="saving" :disabled="!form.name.trim()" @click="save" />
    </template>
  </Dialog>
</template>

<style scoped>
.icons,
.colors {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.icon-choice {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  cursor: pointer;
}
.icon-choice.selected,
.color-choice.selected {
  outline: 2px solid var(--mh-accent);
  outline-offset: 1px;
}
.color-choice {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 1px solid var(--mh-border);
  cursor: pointer;
}
.color-choice.none {
  background: repeating-linear-gradient(45deg, var(--mh-surface), var(--mh-surface) 4px, var(--mh-hover) 4px, var(--mh-hover) 8px);
}
.drop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--mh-border);
  border-radius: var(--mh-radius-sm);
}
.drop.dragging {
  border-color: var(--mh-accent);
  background: color-mix(in srgb, var(--mh-accent) 6%, transparent);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.folders {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.folders li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
}
.folders li.missing {
  border-color: color-mix(in srgb, var(--mh-warning) 50%, var(--mh-border));
}
.folders .path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.import {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  padding: 8px 10px;
}
.import ul {
  margin: 4px 0 8px;
  padding-left: 18px;
  font-size: 12.5px;
}
.import code {
  font-family: var(--mh-font-mono);
}
.err {
  color: var(--mh-danger);
  margin: 0 0 4px;
}
.missing-label {
  font-size: 12px;
  color: var(--mh-warning);
}
.mono :deep(textarea),
textarea.mono {
  font-family: var(--mh-font-mono);
  font-size: 13px;
}
.unsaved {
  margin-right: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.unsaved .pi {
  font-size: 7px;
  color: var(--mh-warning);
}
</style>
