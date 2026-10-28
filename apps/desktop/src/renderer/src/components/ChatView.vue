<script setup lang="ts">
import PlanDock from './PlanDock.vue';
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import Popover from 'primevue/popover';
import Textarea from 'primevue/textarea';
import ProgressSpinner from 'primevue/progressspinner';
import { useToast } from 'primevue/usetoast';
import type { MenuItem } from 'primevue/menuitem';
import type { Compaction, Id, Message } from '@monolith/contracts';
import { api, errorMessage } from '../api.ts';
import { activeConversation, messagesOf, openConversation, store } from '../stores/app.ts';
import { useFollowScroll } from '../lib/follow-scroll.ts';
import { chatActions } from '../lib/chat-actions.ts';
import type { SettingsSectionId } from '../ui-state.ts';
import MessageItem from './MessageItem.vue';
import Composer from './Composer.vue';
import QueuePanel from './QueuePanel.vue';
import ResourcesButton from './tools/ResourcesButton.vue';
import ProposalsPanel from './tools/ProposalsPanel.vue';
import SandboxDialog from './tools/SandboxDialog.vue';

const emit = defineEmits<{ 'open-settings': [section?: SettingsSectionId] }>();
const { t } = useI18n();
const toast = useToast();
const actions = chatActions(toast);

const messages = computed(() => (activeConversation.value ? messagesOf(activeConversation.value.id).value : []));
const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const { following, scrollToBottom } = useFollowScroll(scroller, content);
const noProvider = computed(() => store.providers.length === 0);

// ---------- Fenêtre de rendu : les longues conversations chargent les messages anciens à la demande ----------
const WINDOW = 80;
const visibleCount = ref(WINDOW);
const shown = computed(() => messages.value.slice(-visibleCount.value));
const hiddenCount = computed(() => Math.max(0, messages.value.length - visibleCount.value));
async function showEarlier() {
  const el = scroller.value;
  const before = el?.scrollHeight ?? 0;
  visibleCount.value += WINDOW;
  await nextTick();
  // Position conservée : le contenu ajouté au-dessus ne fait pas sauter la lecture.
  if (el) el.scrollTop += el.scrollHeight - before;
}
function onScroll() {
  const el = scroller.value;
  if (el && el.scrollTop < 120 && hiddenCount.value > 0) void showEarlier();
}

const compactionsBySeq = computed(() => {
  const map = new Map<number, Compaction>();
  for (const c of store.compactions.get(activeConversation.value?.id ?? -1) ?? []) map.set(c.upToSeq, c);
  return map;
});

watch(
  () => store.activeId,
  async () => {
    visibleCount.value = WINDOW;
    await nextTick();
    scrollToBottom(true);
  },
);

async function newConversation() {
  try {
    const c = await api.call('conversations.create', { projectId: null });
    store.conversations.set(c.id, c);
    await openConversation(c.id);
  } catch (e) {
    toast.add({ severity: 'error', summary: t('errors.internal'), detail: errorMessage(e), life: 5000 });
  }
}

async function toggleFavorite() {
  const c = activeConversation.value;
  if (c) await api.call('conversations.update', { id: c.id, patch: { favorite: !c.favorite } }).catch(() => undefined);
}

// ---------- Objectif persistant ----------
const goalPop = ref<InstanceType<typeof Popover> | null>(null);
const goalText = ref('');
const goalAnchor = ref<HTMLElement | null>(null);
function openGoal(event?: Event) {
  goalText.value = activeConversation.value?.goal ?? '';
  goalPop.value?.show(event ?? ({ currentTarget: goalAnchor.value, target: goalAnchor.value } as unknown as Event), goalAnchor.value ?? undefined);
}
async function saveGoal() {
  const c = activeConversation.value;
  goalPop.value?.hide();
  if (c) await api.call('conversations.update', { id: c.id, patch: { goal: goalText.value.trim() } }).catch((e) => toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 }));
}

// ---------- Menu de la conversation ----------
const menu = ref<InstanceType<typeof Menu> | null>(null);
const menuItems = computed<MenuItem[]>(() => {
  const c = activeConversation.value;
  if (!c) return [];
  return [
    { label: t('actions.goal'), icon: 'pi pi-flag', command: () => openGoal() },
    { label: t('actions.exportMarkdown'), icon: 'pi pi-download', command: () => actions.exportMarkdown(c.id, false) },
    { label: t('actions.exportWithReasoning'), icon: 'pi pi-download', command: () => actions.exportMarkdown(c.id, true) },
    { label: t('actions.duplicate'), icon: 'pi pi-clone', command: () => actions.fork(c.id) },
    { label: t('actions.compact'), icon: 'pi pi-compress', disabled: c.generating, command: () => actions.compact(c.id) },
    { label: t('sandbox.menu'), icon: 'pi pi-box', command: () => (sandboxOpen.value = true) },
  ];
});

async function resume(m: Message) {
  const c = activeConversation.value;
  if (c) await actions.resumeFrom(c.id, m.id);
}
function fork(m: Message) {
  const c = activeConversation.value;
  if (c) void actions.fork(c.id, m.id);
}
const generationStatus = computed(() => (activeConversation.value ? store.generations.get(activeConversation.value.id)?.status : undefined));
const openSource = (id: Id) => openConversation(id);
const sandboxOpen = ref(false);
</script>

<template>
  <main class="chat">
    <template v-if="activeConversation">
      <header class="chat-head">
        <h1 class="title">{{ activeConversation.title }}</h1>
        <button v-if="activeConversation.forkedFrom && store.conversations.has(activeConversation.forkedFrom.conversationId)" type="button" class="origin-link" @click="openSource(activeConversation.forkedFrom.conversationId)">
          <i class="pi pi-clone" /> {{ t('actions.forkedFrom', { title: store.conversations.get(activeConversation.forkedFrom.conversationId)!.title }) }}
        </button>
        <button v-if="activeConversation.parentId !== null && store.conversations.has(activeConversation.parentId)" type="button" class="origin-link" @click="openSource(activeConversation.parentId)">
          <i class="pi pi-sitemap" /> {{ t('subagents.parentOf', { title: store.conversations.get(activeConversation.parentId)!.title }) }}
        </button>
        <ResourcesButton :key="activeConversation.id" :conversation="activeConversation" />
        <span ref="goalAnchor" class="goal-anchor">
          <button v-if="activeConversation.goal" type="button" class="goal-chip" :title="activeConversation.goal" @click="openGoal($event)"><i class="pi pi-flag" /> {{ activeConversation.goal }}</button>
        </span>
        <button type="button" class="mh-icon-btn" :class="{ active: activeConversation.favorite }" :aria-pressed="activeConversation.favorite" :aria-label="activeConversation.favorite ? t('conversation.unfavorite') : t('conversation.favorite')" v-tooltip.bottom="activeConversation.favorite ? t('conversation.unfavorite') : t('conversation.favorite')" @click="toggleFavorite">
          <i class="pi" :class="activeConversation.favorite ? 'pi-star-fill' : 'pi-star'" />
        </button>
        <button type="button" class="mh-icon-btn" :class="{ active: store.settings?.layout.panelOpen }" :aria-pressed="!!store.settings?.layout.panelOpen" :aria-label="`${t('panel.open')} (Ctrl+J)`" v-tooltip.bottom="`${t('panel.open')} (Ctrl+J)`" @click="api.call('settings.update', { layout: { panelOpen: !store.settings?.layout.panelOpen } })"><i class="pi pi-objects-column" /></button>
        <button type="button" class="mh-icon-btn" :aria-label="t('actions.menu')" v-tooltip.bottom="t('actions.menu')" @click="menu?.toggle($event)"><i class="pi pi-ellipsis-v" /></button>
        <Menu ref="menu" :model="menuItems" popup />
        <SandboxDialog v-if="sandboxOpen" v-model:visible="sandboxOpen" :conversation-id="activeConversation.id" />
      </header>

      <div ref="scroller" class="scroller" tabindex="-1" @scroll.passive="onScroll">
        <div ref="content" class="thread" role="log" aria-live="polite" :aria-busy="activeConversation.generating">
          <div v-if="store.loadingMessages && messages.length === 0" class="center"><ProgressSpinner style="width: 26px; height: 26px" stroke-width="5" /></div>
          <div v-else-if="messages.length === 0" class="empty">
            <h2>{{ noProvider ? t('chat.noProviderTitle') : t('chat.emptyTitle') }}</h2>
            <p class="mh-muted">{{ noProvider ? t('chat.noProviderHint') : t('chat.emptyHint') }}</p>
            <Button v-if="noProvider" :label="t('chat.openProviders')" icon="pi pi-plug" @click="emit('open-settings', 'providers')" />
          </div>
          <button v-if="hiddenCount > 0" type="button" class="earlier" @click="showEarlier">{{ t('chat.showEarlier', { count: hiddenCount }) }}</button>
          <template v-for="m in shown" :key="m.id">
            <MessageItem :message="m" :busy="activeConversation.generating" @resume="resume(m)" @fork="fork(m)" />
            <details v-if="compactionsBySeq.get(m.seq)" class="compaction">
              <summary>
                <i class="pi pi-compress" />
                {{ t(compactionsBySeq.get(m.seq)!.trigger === 'auto' ? 'chat.compactedAuto' : 'chat.compactedManual', { date: new Date(compactionsBySeq.get(m.seq)!.createdAt).toLocaleString() }) }}
              </summary>
              <div class="compaction-text">{{ compactionsBySeq.get(m.seq)!.summary }}</div>
            </details>
          </template>
          <div v-if="generationStatus === 'compacting'" class="compacting" role="status"><ProgressSpinner style="width: 14px; height: 14px" stroke-width="6" /> {{ t('chat.compactingNow') }}</div>
        </div>
      </div>

      <button v-if="!following" type="button" class="jump" :aria-label="t('chat.jumpToBottom')" @click="scrollToBottom(true)">
        <i class="pi pi-arrow-down" />
      </button>

      <div class="bottom">
        <ProposalsPanel :conversation="activeConversation" />
        <QueuePanel :conversation="activeConversation" />
        <PlanDock :conversation="activeConversation" />
        <Composer :conversation="activeConversation" @sent="scrollToBottom(true)" @open-goal="openGoal()" />
      </div>

      <Popover ref="goalPop">
        <div class="goal-editor">
          <label for="goal-text" class="mh-label">{{ t('actions.goal') }}</label>
          <Textarea id="goal-text" v-model="goalText" rows="4" auto-resize fluid :placeholder="t('actions.goalPlaceholder')" />
          <p class="mh-hint">{{ t('actions.goalHint') }}</p>
          <div class="mh-row between">
            <Button v-if="activeConversation.goal" :label="t('common.remove')" severity="danger" text size="small" @click="((goalText = ''), saveGoal())" />
            <span />
            <Button :label="t('common.save')" size="small" @click="saveGoal" />
          </div>
        </div>
      </Popover>
    </template>

    <div v-else class="welcome">
      <h1>{{ t('chat.welcomeTitle') }}</h1>
      <p class="mh-muted">{{ noProvider ? t('chat.noProviderHint') : t('chat.welcomeHint') }}</p>
      <div class="mh-row">
        <Button :label="t('sidebar.newChat')" icon="pi pi-pen-to-square" @click="newConversation" />
        <Button v-if="noProvider" :label="t('chat.openProviders')" icon="pi pi-plug" severity="secondary" outlined @click="emit('open-settings', 'providers')" />
      </div>
    </div>
  </main>
</template>

<style scoped>
.chat {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--mh-bg);
}
.chat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px 6px;
  min-height: 46px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
}
.goal-anchor {
  flex: 1;
  min-width: 0;
  display: flex;
}
.goal-chip,
.origin-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--mh-muted);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.goal-chip .pi {
  color: var(--mh-accent);
}
.origin-link {
  flex: none;
  max-width: 260px;
}
.scroller {
  flex: 1;
  overflow-y: auto;
  overflow-anchor: none;
  outline: none;
}
.thread {
  max-width: 900px;
  margin: 0 auto;
  padding: 8px 24px 24px;
}
.earlier {
  display: block;
  margin: 4px auto 10px;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: 999px;
  padding: 4px 14px;
  font-size: 12.5px;
  color: var(--mh-muted);
  cursor: pointer;
}
.compaction {
  margin: 6px 0 10px;
  border-top: 1px dashed var(--mh-border);
  border-bottom: 1px dashed var(--mh-border);
  font-size: 12.5px;
  color: var(--mh-muted);
}
.compaction summary {
  padding: 6px 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
}
.compaction-text {
  white-space: pre-wrap;
  padding: 0 4px 10px;
}
.compacting {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--mh-muted);
  font-size: 13px;
  padding: 6px 0;
}
.bottom {
  padding: 0 20px;
}
.bottom :deep(.composer) {
  padding-left: 0;
  padding-right: 0;
}
.center {
  display: flex;
  justify-content: center;
  padding: 40px;
}
.empty,
.welcome {
  text-align: center;
  padding: 12vh 24px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.welcome {
  flex: 1;
  justify-content: center;
  padding-top: 0;
}
.empty h2,
.welcome h1 {
  margin: 0;
  font-size: 20px;
}
.welcome h1 {
  font-size: 24px;
}
.empty p,
.welcome p {
  max-width: 520px;
  margin: 0 0 12px;
}
.jump {
  position: absolute;
  left: 50%;
  bottom: 150px;
  transform: translateX(-50%);
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--mh-border);
  background: var(--mh-elevated);
  color: var(--mh-text);
  cursor: pointer;
  box-shadow: 0 2px 10px rgb(0 0 0 / 12%);
  z-index: 3;
}
.goal-editor {
  width: min(420px, 86vw);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
@media (max-width: 760px) {
  .thread {
    padding: 8px 12px 16px;
  }
  .bottom {
    padding: 0 10px;
  }
}
</style>
