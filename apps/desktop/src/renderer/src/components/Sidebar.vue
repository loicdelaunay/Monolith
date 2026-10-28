<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ContextMenu from 'primevue/contextmenu';
import Popover from 'primevue/popover';
import InputText from 'primevue/inputtext';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import ProgressSpinner from 'primevue/progressspinner';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import type { MenuItem } from 'primevue/menuitem';
import type { Conversation, Id, Project, SearchHit } from '@monolith/contracts';
import { api, errorMessage, host } from '../api.ts';
import SubagentRows from './SubagentRows.vue';
import { activeConversation, conversationsIn, openConversation, store } from '../stores/app.ts';
import { chatActions } from '../lib/chat-actions.ts';
import NotificationsBell from './NotificationsBell.vue';
import { uiState, type SettingsSectionId } from '../ui-state.ts';

const emit = defineEmits<{ 'open-settings': [section?: SettingsSectionId] }>();
const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();
const actions = chatActions(toast);

const layout = computed(() => store.settings!.layout);
const showArchived = computed(() => layout.value.showArchived);
const width = ref(layout.value.sidebarWidth);
watch(() => layout.value.sidebarWidth, (w) => (width.value = w));

function fail(error: unknown) {
  toast.add({ severity: 'error', summary: t('errors.internal'), detail: errorMessage(error), life: 6000 });
}

// ---------- Recherche ----------
const query = ref('');
const hits = ref<SearchHit[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q) => {
  clearTimeout(searchTimer);
  if (!q.trim()) {
    hits.value = [];
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      hits.value = await api.call('conversations.search', { query: q, limit: 40 });
    } catch (e) {
      fail(e);
    }
  }, 180);
});
onBeforeUnmount(() => clearTimeout(searchTimer));

// ---------- Création ----------
async function newConversation(projectId: Id | null = activeConversation.value?.projectId ?? null) {
  try {
    const c = await api.call('conversations.create', { projectId });
    store.conversations.set(c.id, c);
    if (projectId !== null) setCollapsed(projectId, false);
    await openConversation(c.id);
  } catch (e) {
    fail(e);
  }
}

function newProject() {
  uiState.projectDialog = { open: true, projectId: null, focus: 'general' };
}

// ---------- Repli des projets ----------
const collapsed = computed(() => new Set(layout.value.collapsedProjects));
async function setCollapsed(projectId: Id, value: boolean) {
  const set = new Set(layout.value.collapsedProjects);
  if (value) set.add(projectId);
  else set.delete(projectId);
  if (set.size === layout.value.collapsedProjects.length && value === collapsed.value.has(projectId)) return;
  await api.call('settings.update', { layout: { collapsedProjects: [...set] } }).catch(fail);
}

// ---------- Renommage en ligne ----------
const renamingId = ref<Id | null>(null);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement[] | null>(null);
async function startRename(c: Conversation) {
  renamingId.value = c.id;
  renameValue.value = c.title;
  await nextTick();
  renameInput.value?.[0]?.select();
}
async function commitRename() {
  const id = renamingId.value;
  renamingId.value = null;
  if (id === null) return;
  const title = renameValue.value.trim();
  if (!title || title === store.conversations.get(id)?.title) return;
  await api.call('conversations.update', { id, patch: { title } }).catch(fail);
}

// ---------- Menus contextuels ----------
const menu = ref<InstanceType<typeof ContextMenu> | null>(null);
const menuItems = ref<MenuItem[]>([]);

function patch(c: Conversation, p: Parameters<typeof api.call<'conversations.update'>>[1]['patch']) {
  return api.call('conversations.update', { id: c.id, patch: p }).catch(fail);
}

function removeConversation(c: Conversation) {
  const run = async () => {
    try {
      await api.call('conversations.delete', { id: c.id });
    } catch (e) {
      fail(e);
    }
  };
  if (!store.settings!.general.confirmDelete) return void run();
  confirm.require({
    header: t('conversation.deleteTitle'),
    message: t('conversation.deleteMessage', { title: c.title }),
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: run,
  });
}

function conversationMenu(c: Conversation): MenuItem[] {
  const targets: MenuItem[] = [
    ...(c.projectId !== null ? [{ label: t('sidebar.personal'), icon: 'pi pi-user', command: () => patch(c, { projectId: null }) }] : []),
    ...store.projects.filter((p) => p.id !== c.projectId).map((p) => ({ label: p.name, icon: `pi pi-${p.icon}`, command: () => patch(c, { projectId: p.id }) })),
  ];
  return [
    { label: t('conversation.rename'), icon: 'pi pi-pencil', command: () => startRename(c) },
    { label: c.favorite ? t('conversation.unfavorite') : t('conversation.favorite'), icon: c.favorite ? 'pi pi-star-fill' : 'pi pi-star', command: () => patch(c, { favorite: !c.favorite }) },
    { label: c.pinned ? t('conversation.unpin') : t('conversation.pin'), icon: 'pi pi-thumbtack', command: () => patch(c, { pinned: !c.pinned }) },
    { label: c.archived ? t('conversation.unarchive') : t('conversation.archive'), icon: 'pi pi-inbox', command: () => patch(c, { archived: !c.archived }) },
    ...(targets.length ? [{ label: t('conversation.moveTo'), icon: 'pi pi-arrow-right-arrow-left', items: targets }] : []),
    { label: t('actions.duplicate'), icon: 'pi pi-clone', command: () => actions.fork(c.id) },
    { label: t('actions.exportMarkdown'), icon: 'pi pi-download', command: () => actions.exportMarkdown(c.id, false) },
    { separator: true },
    { label: t('conversation.delete'), icon: 'pi pi-trash', class: 'mh-danger-item', command: () => removeConversation(c) },
  ];
}

function projectMenu(p: Project): MenuItem[] {
  return [
    { label: t('project.newConversation'), icon: 'pi pi-plus', command: () => newConversation(p.id) },
    { label: t('project.edit'), icon: 'pi pi-pencil', command: () => (uiState.projectDialog = { open: true, projectId: p.id, focus: 'general' }) },
    { label: t('project.editInstructions'), icon: 'pi pi-file-edit', command: () => (uiState.projectDialog = { open: true, projectId: p.id, focus: 'instructions' }) },
    { separator: true },
    { label: t('project.delete'), icon: 'pi pi-trash', command: () => removeProject(p) },
  ];
}

const projectToDelete = ref<Project | null>(null);
function removeProject(p: Project) {
  projectToDelete.value = p;
}
async function confirmProjectDelete(deleteConversations: boolean) {
  const p = projectToDelete.value;
  projectToDelete.value = null;
  if (p) await api.call('projects.delete', { id: p.id, deleteConversations }).catch(fail);
}

// ---------- Sélection multiple : Ctrl+clic (ajouter / retirer), Maj+clic (plage) ----------
const selected = ref(new Set<Id>());
const selectionAnchor = ref<Id | null>(null);
/** Ordre affiché (espace personnel puis projets dépliés) : base des plages Maj+clic. */
const visibleOrder = computed(() => [...conversationsIn(null, showArchived.value), ...store.projects.flatMap((p) => (collapsed.value.has(p.id) ? [] : conversationsIn(p.id, showArchived.value)))].map((c) => c.id));
const selectedList = computed(() => [...selected.value].map((id) => store.conversations.get(id)).filter((c): c is Conversation => !!c));
function clearSelection() {
  selected.value = new Set();
}
function onConversationClick(e: MouseEvent, c: Conversation) {
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(selected.value);
    // Première sélection : la conversation ouverte en fait partie, comme dans l'explorateur.
    if (next.size === 0 && store.activeId !== null && store.activeId !== c.id && visibleOrder.value.includes(store.activeId)) next.add(store.activeId);
    if (next.has(c.id)) next.delete(c.id);
    else next.add(c.id);
    selected.value = next;
    selectionAnchor.value = c.id;
    return;
  }
  if (e.shiftKey) {
    const order = visibleOrder.value;
    const from = order.indexOf(selectionAnchor.value ?? store.activeId ?? c.id);
    const to = order.indexOf(c.id);
    if (from >= 0 && to >= 0) selected.value = new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    return;
  }
  clearSelection();
  selectionAnchor.value = c.id;
  openConversation(c.id);
}
function onConversationMenu(e: MouseEvent | KeyboardEvent, c: Conversation) {
  if (selected.value.size > 1 && selected.value.has(c.id)) return openMenu(e, selectionMenu());
  clearSelection();
  openMenu(e, conversationMenu(c));
}
function selectionMenu(): MenuItem[] {
  const list = [...selected.value].map((id) => store.conversations.get(id)).filter((c): c is Conversation => !!c);
  const allArchived = list.every((c) => c.archived);
  return [
    { label: t('sidebar.selection', { count: list.length }), icon: 'pi pi-check-square', disabled: true },
    { separator: true },
    { label: allArchived ? t('sidebar.unarchiveSelection', { count: list.length }) : t('sidebar.archiveSelection', { count: list.length }), icon: 'pi pi-inbox', command: () => archiveSelection(list, !allArchived) },
    { label: t('sidebar.deleteSelection', { count: list.length }), icon: 'pi pi-trash', class: 'mh-danger-item', command: () => deleteSelection(list) },
    { separator: true },
    { label: t('sidebar.clearSelection'), icon: 'pi pi-times', command: clearSelection },
  ];
}
async function archiveSelection(list: Conversation[], archived: boolean) {
  await Promise.all(list.map((c) => api.call('conversations.update', { id: c.id, patch: { archived } }).catch(fail)));
  clearSelection();
}
function deleteSelection(list: Conversation[]) {
  // Suppression groupée : toujours confirmée, quel que soit le réglage.
  confirm.require({
    header: t('sidebar.deleteSelectionTitle', { count: list.length }),
    message: t('sidebar.deleteSelectionMessage', { titles: list.slice(0, 5).map((c) => `« ${c.title} »`).join(', ') + (list.length > 5 ? '…' : '') }),
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: async () => {
      for (const c of list) await api.call('conversations.delete', { id: c.id }).catch(fail);
      clearSelection();
    },
  });
}
const onSelectionKey = (e: KeyboardEvent) => e.key === 'Escape' && selected.value.size > 0 && clearSelection();
window.addEventListener('keydown', onSelectionKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onSelectionKey));

function openMenu(event: MouseEvent | KeyboardEvent, items: MenuItem[]) {
  menuItems.value = items;
  if (event instanceof KeyboardEvent) {
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.value?.show(new MouseEvent('contextmenu', { clientX: r.left + 24, clientY: r.bottom }));
  } else {
    menu.value?.show(event);
  }
}

// ---------- Glisser-déposer ----------
type Drag = { kind: 'conversation'; id: Id; projectId: Id | null } | { kind: 'project'; id: Id };
const drag = ref<Drag | null>(null);
const dropTarget = ref<string | null>(null);

function onDragStart(e: DragEvent, d: Drag) {
  drag.value = d;
  e.dataTransfer?.setData('text/plain', String(d.id));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragEnd() {
  drag.value = null;
  dropTarget.value = null;
}
async function dropOnConversation(target: Conversation) {
  const d = drag.value;
  onDragEnd();
  if (!d || d.kind !== 'conversation' || d.id === target.id) return;
  if (d.projectId !== target.projectId) {
    await patch(store.conversations.get(d.id)!, { projectId: target.projectId });
    return;
  }
  const list = conversationsIn(target.projectId, showArchived.value).map((c) => c.id).filter((id) => id !== d.id);
  list.splice(list.indexOf(target.id), 0, d.id);
  list.forEach((id, i) => {
    const c = store.conversations.get(id);
    if (c) c.sortOrder = i + 1;
  });
  await api.call('conversations.reorder', { projectId: target.projectId, ids: list }).catch(fail);
}
async function dropOnGroup(projectId: Id | null) {
  const d = drag.value;
  onDragEnd();
  if (!d) return;
  if (d.kind === 'conversation' && d.projectId !== projectId) await patch(store.conversations.get(d.id)!, { projectId });
  if (d.kind === 'project' && projectId !== null && d.id !== projectId) {
    const ids = store.projects.map((p) => p.id).filter((id) => id !== d.id);
    ids.splice(ids.indexOf(projectId), 0, d.id);
    store.projects = ids.map((id) => store.projects.find((p) => p.id === id)!);
    await api.call('projects.reorder', { ids }).catch(fail);
  }
}

// ---------- Redimensionnement ----------
function startResize(e: PointerEvent) {
  const startX = e.clientX;
  const startW = width.value;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => (width.value = Math.min(520, Math.max(200, startW + ev.clientX - startX)));
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    void api.call('settings.update', { layout: { sidebarWidth: width.value } }).catch(fail);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}
function resizeKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
  if (!step) return;
  width.value = Math.min(520, Math.max(200, width.value + step));
  void api.call('settings.update', { layout: { sidebarWidth: width.value } }).catch(fail);
}

const tools = ref<InstanceType<typeof Popover> | null>(null);
const STUDIO_TOOLS = [
  { id: 'text', icon: 'pi-language' },
  { id: 'images', icon: 'pi-image' },
  { id: 'assets', icon: 'pi-palette' },
  { id: 'benchmark', icon: 'pi-gauge' },
  { id: 'detect', icon: 'pi-search' },
  { id: 'dashboard', icon: 'pi-chart-bar' },
] as const;
function openStudio(tab: (typeof STUDIO_TOOLS)[number]['id']) {
  tools.value?.hide();
  void host.openToolWindow(tab, t(`studio.tabs.${tab}`));
}
const projectTitle = (id: Id | null) => (id === null ? t('sidebar.personal') : (store.projects.find((p) => p.id === id)?.name ?? ''));
</script>

<template>
  <nav class="mh-sidebar" :style="{ width: `${width}px` }" :aria-label="t('sidebar.projects')">
    <div class="top">
      <button type="button" class="new-chat" @click="newConversation()">
        <i class="pi pi-pen-to-square" />
        <span>{{ t('sidebar.newChat') }}</span>
      </button>
      <IconField class="search">
        <InputIcon class="pi pi-search" />
        <InputText v-model="query" size="small" :placeholder="t('sidebar.searchPlaceholder')" :aria-label="t('common.search')" fluid @keydown.esc="query = ''" />
      </IconField>
    </div>

    <div class="scroll">
      <!-- Résultats de recherche -->
      <template v-if="query.trim()">
        <div v-if="hits.length === 0" class="empty">{{ t('sidebar.noResults') }}</div>
        <button v-for="h in hits" :key="`${h.conversationId}-${h.messageId}`" type="button" class="hit" @click="openConversation(h.conversationId)">
          <span class="hit-title">{{ h.title }}</span>
          <span class="hit-meta">{{ projectTitle(h.projectId) }}</span>
          <span v-if="h.snippet" class="hit-snippet">{{ h.snippet }}</span>
        </button>
      </template>

      <template v-else>
        <div v-if="selected.size > 0" class="selection-bar" role="status">
          <span>{{ t('sidebar.selection', { count: selected.size }) }}</span>
          <button type="button" class="mh-icon-btn small" :aria-label="t('sidebar.archiveSelection', { count: selected.size })" v-tooltip="t('sidebar.archiveSelection', { count: selected.size })" @click="archiveSelection(selectedList, true)"><i class="pi pi-inbox" /></button>
          <button type="button" class="mh-icon-btn small danger" :aria-label="t('sidebar.deleteSelection', { count: selected.size })" v-tooltip="t('sidebar.deleteSelection', { count: selected.size })" @click="deleteSelection(selectedList)"><i class="pi pi-trash" /></button>
          <button type="button" class="mh-icon-btn small" :aria-label="t('sidebar.clearSelection')" v-tooltip="t('sidebar.clearSelection')" @click="clearSelection"><i class="pi pi-times" /></button>
        </div>
        <!-- Espace personnel -->
        <section class="group" :class="{ drop: dropTarget === 'personal' }" @dragover.prevent="dropTarget = 'personal'" @dragleave="dropTarget = null" @drop.prevent="dropOnGroup(null)">
          <div class="group-head">
            <i class="pi pi-user" />
            <span class="group-name">{{ t('sidebar.personal') }}</span>
            <button type="button" class="mh-icon-btn small" :aria-label="t('sidebar.newChat')" v-tooltip="t('sidebar.newChat')" @click="newConversation(null)"><i class="pi pi-plus" /></button>
          </div>
          <ul class="conversations">
            <li v-for="c in conversationsIn(null, showArchived)" :key="c.id">
              <div
                class="conv"
                :class="{ active: store.activeId === c.id, selected: selected.has(c.id), archived: c.archived, 'drop-before': dropTarget === `c${c.id}` }"
                draggable="true"
                @dragstart="onDragStart($event, { kind: 'conversation', id: c.id, projectId: c.projectId })"
                @dragend="onDragEnd"
                @dragover.prevent.stop="dropTarget = `c${c.id}`"
                @drop.prevent.stop="dropOnConversation(c)"
                @contextmenu.prevent="onConversationMenu($event, c)"
              >
                <input v-if="renamingId === c.id" ref="renameInput" v-model="renameValue" class="rename" :aria-label="t('conversation.rename')" @keydown.enter.prevent="commitRename" @keydown.esc.prevent="renamingId = null" @blur="commitRename" />
                <button v-else type="button" class="conv-main" :aria-current="store.activeId === c.id ? 'page' : undefined" :aria-selected="selected.has(c.id) || undefined" @click="onConversationClick($event, c)" @dblclick="startRename(c)" @keydown.f2.prevent="startRename(c)" @keydown.shift.f10.prevent="onConversationMenu($event, c)">
                  <i v-if="c.pinned" class="pi pi-thumbtack flag" :aria-label="t('conversation.pin')" />
                  <i v-else-if="c.favorite" class="pi pi-star-fill flag fav" :aria-label="t('conversation.favorite')" />
                  <span class="conv-title">{{ c.title }}</span>
                  <ProgressSpinner v-if="c.generating" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
                </button>
                <button type="button" class="mh-icon-btn small more" :aria-label="t('sidebar.actions')" @click.stop="openMenu($event, conversationMenu(c))"><i class="pi pi-ellipsis-h" /></button>
              </div>
              <SubagentRows :parent="c" />
            </li>
            <li v-if="conversationsIn(null, showArchived).length === 0" class="empty compact">{{ t('sidebar.noConversations') }}</li>
          </ul>
        </section>

        <!-- Projets -->
        <div class="projects-head">
          <span>{{ t('sidebar.projects') }}</span>
          <button type="button" class="mh-icon-btn small" :aria-label="t('sidebar.newProject')" v-tooltip="t('sidebar.newProject')" @click="newProject"><i class="pi pi-folder-plus" /></button>
        </div>
        <section
          v-for="p in store.projects"
          :key="p.id"
          class="group"
          :class="{ drop: dropTarget === `p${p.id}` }"
          @dragover.prevent="dropTarget = `p${p.id}`"
          @dragleave="dropTarget = null"
          @drop.prevent="dropOnGroup(p.id)"
        >
          <div class="group-head project" draggable="true" @dragstart="onDragStart($event, { kind: 'project', id: p.id })" @dragend="onDragEnd" @contextmenu.prevent="openMenu($event, projectMenu(p))">
            <button type="button" class="toggle" :aria-expanded="!collapsed.has(p.id)" @click="setCollapsed(p.id, !collapsed.has(p.id))" @keydown.shift.f10.prevent="openMenu($event, projectMenu(p))">
              <i class="pi chevron" :class="collapsed.has(p.id) ? 'pi-angle-right' : 'pi-angle-down'" />
              <i class="pi" :class="`pi-${p.icon}`" :style="p.color ? { color: p.color } : undefined" />
              <span class="group-name">{{ p.name }}</span>
            </button>
            <button type="button" class="mh-icon-btn small" :aria-label="t('project.newConversation')" v-tooltip="t('project.newConversation')" @click="newConversation(p.id)"><i class="pi pi-plus" /></button>
            <button type="button" class="mh-icon-btn small more" :aria-label="t('sidebar.actions')" @click.stop="openMenu($event, projectMenu(p))"><i class="pi pi-ellipsis-h" /></button>
          </div>
          <ul v-if="!collapsed.has(p.id)" class="conversations">
            <li v-for="c in conversationsIn(p.id, showArchived)" :key="c.id">
              <div
                class="conv"
                :class="{ active: store.activeId === c.id, selected: selected.has(c.id), archived: c.archived, 'drop-before': dropTarget === `c${c.id}` }"
                draggable="true"
                @dragstart="onDragStart($event, { kind: 'conversation', id: c.id, projectId: c.projectId })"
                @dragend="onDragEnd"
                @dragover.prevent.stop="dropTarget = `c${c.id}`"
                @drop.prevent.stop="dropOnConversation(c)"
                @contextmenu.prevent="onConversationMenu($event, c)"
              >
                <input v-if="renamingId === c.id" ref="renameInput" v-model="renameValue" class="rename" :aria-label="t('conversation.rename')" @keydown.enter.prevent="commitRename" @keydown.esc.prevent="renamingId = null" @blur="commitRename" />
                <button v-else type="button" class="conv-main" :aria-current="store.activeId === c.id ? 'page' : undefined" :aria-selected="selected.has(c.id) || undefined" @click="onConversationClick($event, c)" @dblclick="startRename(c)" @keydown.f2.prevent="startRename(c)" @keydown.shift.f10.prevent="onConversationMenu($event, c)">
                  <i v-if="c.pinned" class="pi pi-thumbtack flag" />
                  <i v-else-if="c.favorite" class="pi pi-star-fill flag fav" />
                  <span class="conv-title">{{ c.title }}</span>
                  <ProgressSpinner v-if="c.generating" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
                </button>
                <button type="button" class="mh-icon-btn small more" :aria-label="t('sidebar.actions')" @click.stop="openMenu($event, conversationMenu(c))"><i class="pi pi-ellipsis-h" /></button>
              </div>
              <SubagentRows :parent="c" />
            </li>
            <li v-if="conversationsIn(p.id, showArchived).length === 0" class="empty compact">{{ t('sidebar.noConversations') }}</li>
          </ul>
        </section>
      </template>
    </div>

    <div class="bottom">
      <button type="button" class="foot-btn" @click="emit('open-settings')">
        <i class="pi pi-cog" />
        <span>{{ t('sidebar.settings') }}</span>
      </button>
      <NotificationsBell />
      <button type="button" class="mh-icon-btn" :aria-label="t('sidebar.tools')" v-tooltip.top="t('sidebar.tools')" @click="tools?.toggle($event)"><i class="pi pi-th-large" /></button>
      <button type="button" class="mh-icon-btn" :class="{ active: showArchived }" :aria-pressed="showArchived" :aria-label="showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')" v-tooltip.top="showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')" @click="api.call('settings.update', { layout: { showArchived: !showArchived } })"><i class="pi pi-inbox" /></button>
    </div>

    <div class="resizer" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="t('sidebar.resize')" :aria-valuenow="width" aria-valuemin="200" aria-valuemax="520" @pointerdown="startResize" @keydown="resizeKey" />

    <ContextMenu ref="menu" :model="menuItems" />
    <Dialog :visible="projectToDelete !== null" modal :header="projectToDelete ? t('project.deleteTitle', { name: projectToDelete.name }) : ''" :style="{ width: 'min(480px, 92vw)' }" @update:visible="(v: boolean) => !v && (projectToDelete = null)">
      <p>{{ t('project.deleteMessage', { count: projectToDelete ? conversationsIn(projectToDelete.id, true).length : 0 }) }}</p>
      <template #footer>
        <Button :label="t('common.cancel')" severity="secondary" text @click="projectToDelete = null" />
        <Button :label="t('project.deleteKeep')" severity="secondary" outlined @click="confirmProjectDelete(false)" />
        <Button :label="t('project.deleteAll')" severity="danger" @click="confirmProjectDelete(true)" />
      </template>
    </Dialog>
    <Popover ref="tools">
      <div class="tools-pop">
        <strong>{{ t('sidebar.tools') }}</strong>
        <button v-for="x in STUDIO_TOOLS" :key="x.id" type="button" class="tool-item" @click="openStudio(x.id)">
          <i class="pi" :class="x.icon" />
          <span class="tool-text"><span>{{ t(`studio.tabs.${x.id}`) }}</span><span class="mh-hint">{{ t(`studio.hints.${x.id}`) }}</span></span>
        </button>
      </div>
    </Popover>
  </nav>
</template>

<style scoped>
.conv.selected {
  background: color-mix(in srgb, var(--mh-accent) 16%, transparent);
  box-shadow: inset 2px 0 0 var(--mh-accent);
}
.selection-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 8px 6px;
  padding: 4px 6px 4px 10px;
  border-radius: var(--mh-radius-sm);
  background: color-mix(in srgb, var(--mh-accent) 12%, transparent);
  font-size: 12.5px;
}
.selection-bar span {
  flex: 1;
}
.selection-bar .danger:hover {
  color: var(--mh-danger);
}
.mh-sidebar {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--mh-sidebar);
  border-right: 1px solid var(--mh-border);
  min-width: 200px;
  max-width: 520px;
}
.top {
  padding: 10px 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.new-chat {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: var(--mh-radius-sm);
  padding: 7px 10px;
  cursor: pointer;
  font-weight: 550;
  transition: background var(--mh-transition), border-color var(--mh-transition);
}
.new-chat:hover {
  border-color: color-mix(in srgb, var(--mh-accent) 45%, var(--mh-border));
}
.new-chat .pi {
  color: var(--mh-accent);
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px 10px;
}
.group {
  border-radius: var(--mh-radius-sm);
  margin-bottom: 2px;
}
.group.drop {
  background: color-mix(in srgb, var(--mh-accent) 10%, transparent);
}
.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 4px 8px;
  font-size: 12.5px;
  color: var(--mh-muted);
  font-weight: 600;
}
.group-head.project {
  padding-left: 2px;
}
.group-head .toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--mh-text);
  font-weight: 600;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.group-head .toggle:hover {
  background: var(--mh-hover);
}
.chevron {
  font-size: 11px;
  color: var(--mh-muted);
}
.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.projects-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 6px 2px 10px;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--mh-muted);
  font-weight: 600;
}
.conversations {
  list-style: none;
  margin: 0;
  padding: 0 0 4px;
}
.conv {
  display: flex;
  align-items: center;
  border-radius: var(--mh-radius-sm);
  transition: background var(--mh-transition);
  position: relative;
}
.conv:hover {
  background: var(--mh-hover);
}
.conv.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, var(--mh-sidebar));
}
.conv.archived .conv-title {
  font-style: italic;
  opacity: 0.7;
}
.conv.drop-before::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 6px;
  right: 6px;
  height: 2px;
  background: var(--mh-accent);
  border-radius: 2px;
}
.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  padding: calc(7px * var(--mh-density)) 4px calc(7px * var(--mh-density)) 12px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--mh-radius-sm);
}
.conv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flag {
  font-size: 11px;
  color: var(--mh-muted);
}
.flag.fav {
  color: #e0a43a;
}
.spin {
  width: 14px !important;
  height: 14px !important;
  flex: none;
  margin: 0;
}
.more {
  opacity: 0;
}
.conv:hover .more,
.conv:focus-within .more,
.group-head:hover .more,
.group-head:focus-within .more {
  opacity: 1;
}
.small {
  width: 24px;
  height: 24px;
  font-size: 12px;
}
.rename {
  flex: 1;
  margin: 3px 6px;
  padding: 4px 6px;
  border: 1px solid var(--mh-accent);
  border-radius: 6px;
  background: var(--mh-surface);
  outline: none;
}
.empty {
  color: var(--mh-muted);
  padding: 10px 12px;
  font-size: 12.5px;
}
.empty.compact {
  padding: 4px 12px 6px;
}
.hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 8px 10px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
}
.hit:hover {
  background: var(--mh-hover);
}
.hit-title {
  font-weight: 550;
}
.hit-meta {
  font-size: 11.5px;
  color: var(--mh-muted);
}
.hit-snippet {
  font-size: 12px;
  color: var(--mh-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bottom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-top: 1px solid var(--mh-border);
}
.foot-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 7px 10px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  text-align: left;
}
.foot-btn:hover {
  background: var(--mh-hover);
}
.resizer {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}
.resizer:hover,
.resizer:focus-visible {
  background: color-mix(in srgb, var(--mh-accent) 40%, transparent);
}
.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  border: 0;
  background: none;
  padding: 7px 8px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  color: var(--mh-text);
  font: inherit;
  text-align: left;
}
.tool-item:hover {
  background: var(--mh-hover);
}
.tool-item .pi {
  margin-top: 3px;
  color: var(--mh-muted);
}
.tool-text {
  display: flex;
  flex-direction: column;
}
.tools-pop {
  max-width: 280px;
}
</style>
