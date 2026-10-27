<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Popover from 'primevue/popover';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { Conversation, ResourceScopeInfo } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';

const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const toast = useToast();
const pop = ref<InstanceType<typeof Popover> | null>(null);
const info = ref<ResourceScopeInfo | null>(null);

const label = computed(() => {
  const i = info.value;
  if (!i) return t('resources.title');
  if (i.roots.length === 1 && i.roots[0] === i.privateDir) return t('resources.private');
  return t('resources.count', { count: i.roots.length + i.files.length });
});

async function load() {
  info.value = await api.call('resources.get', { conversationId: props.conversation.id }).catch(() => null);
}
async function toggle(e: Event) {
  await load();
  pop.value?.toggle(e);
}
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

async function addFolder() {
  const path = await host.pickDirectory(t('resources.addFolder'));
  if (path) info.value = await api.call('resources.add', { conversationId: props.conversation.id, kind: 'folder', path }).catch((e) => (fail(e), info.value));
}
async function addFiles() {
  for (const path of await host.pickFiles(t('resources.addFile'))) {
    info.value = await api.call('resources.add', { conversationId: props.conversation.id, kind: 'file', path }).catch((e) => (fail(e), info.value));
  }
}
async function remove(id: number) {
  info.value = await api.call('resources.remove', { conversationId: props.conversation.id, resourceId: id }).catch((e) => (fail(e), info.value));
}
async function reset() {
  info.value = await api.call('resources.reset', { conversationId: props.conversation.id }).catch((e) => (fail(e), info.value));
}
void load();
</script>

<template>
  <button type="button" class="res-btn" :aria-label="t('resources.title')" @click="toggle">
    <i class="pi pi-folder" /> {{ label }}
  </button>
  <Popover ref="pop">
    <div v-if="info" class="res">
      <div class="mh-row between">
        <strong>{{ t('resources.title') }}</strong>
        <span class="mh-hint">{{ info.mode === 'inherit' ? t('resources.inherit') : t('resources.custom') }}</span>
      </div>
      <ul>
        <li v-for="r in info.roots" :key="r"><i class="pi pi-folder" /><code :title="r">{{ r }}</code><span v-if="r === info.privateDir" class="mh-hint">{{ t('resources.privateHint') }}</span></li>
        <li v-for="f in info.files" :key="f"><i class="pi pi-file" /><code :title="f">{{ f }}</code><span class="mh-hint">{{ t('resources.fileOnly') }}</span></li>
      </ul>
      <template v-if="info.mode === 'custom' && info.items.length">
        <div class="mh-label">{{ t('resources.ownItems') }}</div>
        <ul>
          <li v-for="r in info.items" :key="r.id" :class="{ missing: !r.available }">
            <i class="pi" :class="r.kind === 'file' ? 'pi-file' : 'pi-folder'" />
            <code :title="r.path">{{ r.path }}</code>
            <button type="button" class="mh-icon-btn small" :aria-label="t('common.remove')" @click="remove(r.id)"><i class="pi pi-times" /></button>
          </li>
        </ul>
      </template>
      <div v-if="info.instructionFiles.length">
        <div class="mh-label">{{ t('resources.instructions') }}</div>
        <ul>
          <li v-for="f in info.instructionFiles" :key="f.path"><i class="pi pi-book" /><code :title="f.path">{{ f.path }}</code><span class="mh-hint">{{ t('resources.scope', { scope: f.scope }) }}</span></li>
        </ul>
      </div>
      <div class="mh-row wrap">
        <Button :label="t('resources.addFolder')" icon="pi pi-folder-plus" size="small" severity="secondary" outlined @click="addFolder" />
        <Button :label="t('resources.addFile')" icon="pi pi-file-plus" size="small" severity="secondary" outlined @click="addFiles" />
        <Button v-if="info.mode === 'custom'" :label="t('resources.reset')" icon="pi pi-undo" size="small" text @click="reset" />
      </div>
      <p class="mh-hint">{{ t('resources.hint') }}</p>
    </div>
  </Popover>
</template>

<style scoped>
.res-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--mh-border);
  background: var(--mh-surface);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--mh-muted);
  cursor: pointer;
  flex: none;
}
.res {
  width: min(520px, 90vw);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
li code {
  font-family: var(--mh-font-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
li.missing code {
  color: var(--mh-warning);
}
.small {
  width: 22px;
  height: 22px;
}
.wrap {
  flex-wrap: wrap;
}
</style>
