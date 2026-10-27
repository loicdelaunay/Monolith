<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Popover from 'primevue/popover';
import Button from 'primevue/button';
import type { NotificationItem } from '@monolith/contracts';
import { api, host } from '../api.ts';
import { openConversation, store } from '../stores/app.ts';
import { playChime } from '../lib/chime.ts';

const { t, locale } = useI18n();
const items = ref<NotificationItem[]>([]);
const pop = ref<InstanceType<typeof Popover> | null>(null);
const unread = computed(() => items.value.filter((n) => !n.read).length);
const icons: Record<NotificationItem['level'], string> = { info: 'pi-info-circle', success: 'pi-check-circle ok', warning: 'pi-exclamation-triangle warn', error: 'pi-times-circle bad' };

const offs: (() => void)[] = [];
onMounted(async () => {
  items.value = await api.call('notifications.list', { limit: 100 }).catch(() => []);
  offs.push(
    api.on('notification.added', (n) => {
      items.value = [n, ...items.value].slice(0, 100);
      const s = store.settings?.notifications;
      if (s?.sound) playChime(n.level);
      if (s?.system) void host.notify(n.title, n.body, true);
    }),
    // Fin de génération dans une conversation non affichée (ou fenêtre inactive).
    api.on('generation.state', (state) => {
      const s = store.settings?.notifications;
      if (state.status !== 'finished' || !s?.onGeneration) return;
      if (state.conversationId === store.activeId && document.hasFocus()) return;
      const c = store.conversations.get(state.conversationId);
      if (!c || c.parentId !== null) return;
      void api.call('notifications.add', { level: 'success', title: t('notifications.generationDone'), body: c.title, conversationId: c.id });
    }),
    api.on('log.error', (e) => {
      if (store.settings?.notifications.onError) void api.call('notifications.add', { level: 'error', title: t(`errors.${e.code}`), body: e.message });
    }),
  );
});
onBeforeUnmount(() => offs.forEach((f) => f()));

async function open(e: Event) {
  pop.value?.toggle(e);
}
async function markAll() {
  await api.call('notifications.markRead', {});
  items.value = items.value.map((n) => ({ ...n, read: true }));
}
async function clear() {
  await api.call('notifications.clear');
  items.value = [];
}
async function go(n: NotificationItem) {
  if (!n.read) {
    await api.call('notifications.markRead', { ids: [n.id] });
    n.read = true;
  }
  if (n.conversationId && store.conversations.has(n.conversationId)) {
    pop.value?.hide();
    await openConversation(n.conversationId);
  }
}
const time = (iso: string) => new Date(iso).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' });
</script>

<template>
  <button type="button" class="mh-icon-btn bell" :aria-label="`${t('notifications.title')}${unread ? ` (${unread})` : ''}`" v-tooltip.top="t('notifications.title')" @click="open">
    <i class="pi pi-bell" />
    <span v-if="unread" class="badge" aria-hidden="true">{{ unread > 9 ? '9+' : unread }}</span>
  </button>
  <Popover ref="pop">
    <div class="notes">
      <div class="mh-row between head">
        <strong>{{ t('notifications.title') }}</strong>
        <span>
          <Button :label="t('notifications.markAll')" size="small" text :disabled="!unread" @click="markAll" />
          <Button :label="t('notifications.clear')" size="small" text severity="secondary" :disabled="!items.length" @click="clear" />
        </span>
      </div>
      <p v-if="!items.length" class="mh-hint">{{ t('notifications.empty') }}</p>
      <ul v-else>
        <li v-for="n in items" :key="n.id" :class="{ unread: !n.read }">
          <button type="button" class="item" @click="go(n)">
            <i class="pi" :class="icons[n.level]" />
            <span class="text">
              <span class="title">{{ n.title }}</span>
              <span v-if="n.body" class="mh-hint body">{{ n.body }}</span>
              <span class="mh-hint">{{ time(n.time) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  </Popover>
</template>

<style scoped>
.bell {
  position: relative;
}
.badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--mh-accent);
  color: var(--mh-accent-text);
  font-size: 9.5px;
  line-height: 15px;
  text-align: center;
  font-weight: 700;
}
.notes {
  width: min(380px, 86vw);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
}
.head {
  margin-bottom: 4px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
}
.item {
  display: flex;
  gap: 10px;
  width: 100%;
  border: 0;
  background: none;
  padding: 8px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--mh-text);
  font: inherit;
}
.item:hover {
  background: var(--mh-hover);
}
li.unread .title {
  font-weight: 600;
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.body {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pi.ok {
  color: #2f9e5b;
}
.pi.warn {
  color: var(--mh-warning);
}
.pi.bad {
  color: var(--mh-danger);
}
</style>
