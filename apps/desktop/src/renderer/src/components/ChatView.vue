<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import ProgressSpinner from 'primevue/progressspinner';
import { useToast } from 'primevue/usetoast';
import { api, errorMessage } from '../api.ts';
import { activeConversation, messagesOf, openConversation, store } from '../stores/app.ts';
import { useFollowScroll } from '../lib/follow-scroll.ts';
import type { SettingsSectionId } from '../ui-state.ts';
import MessageItem from './MessageItem.vue';
import Composer from './Composer.vue';

const emit = defineEmits<{ 'open-settings': [section?: SettingsSectionId] }>();
const { t } = useI18n();
const toast = useToast();

const messages = computed(() => (activeConversation.value ? messagesOf(activeConversation.value.id).value : []));
const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const { following, scrollToBottom } = useFollowScroll(scroller, content);
const noProvider = computed(() => store.providers.length === 0);

watch(
  () => store.activeId,
  async () => {
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
</script>

<template>
  <main class="chat">
    <template v-if="activeConversation">
      <header class="chat-head">
        <h1 class="title">{{ activeConversation.title }}</h1>
        <button type="button" class="mh-icon-btn" :class="{ active: activeConversation.favorite }" :aria-pressed="activeConversation.favorite" :aria-label="activeConversation.favorite ? t('conversation.unfavorite') : t('conversation.favorite')" v-tooltip.bottom="activeConversation.favorite ? t('conversation.unfavorite') : t('conversation.favorite')" @click="toggleFavorite">
          <i class="pi" :class="activeConversation.favorite ? 'pi-star-fill' : 'pi-star'" />
        </button>
      </header>

      <div ref="scroller" class="scroller" tabindex="-1">
        <div ref="content" class="thread" role="log" aria-live="polite" :aria-busy="activeConversation.generating">
          <div v-if="store.loadingMessages && messages.length === 0" class="center"><ProgressSpinner style="width: 26px; height: 26px" stroke-width="5" /></div>
          <div v-else-if="messages.length === 0" class="empty">
            <h2>{{ noProvider ? t('chat.noProviderTitle') : t('chat.emptyTitle') }}</h2>
            <p class="mh-muted">{{ noProvider ? t('chat.noProviderHint') : t('chat.emptyHint') }}</p>
            <Button v-if="noProvider" :label="t('chat.openProviders')" icon="pi pi-plug" @click="emit('open-settings', 'providers')" />
          </div>
          <MessageItem v-for="m in messages" :key="m.id" :message="m" />
        </div>
      </div>

      <button v-if="!following" type="button" class="jump" :aria-label="t('chat.jumpToBottom')" @click="scrollToBottom(true)">
        <i class="pi pi-arrow-down" />
      </button>

      <Composer :conversation="activeConversation" @sent="scrollToBottom(true)" />
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
  flex: 1;
  min-width: 0;
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
@media (max-width: 760px) {
  .thread {
    padding: 8px 12px 16px;
  }
}
</style>
