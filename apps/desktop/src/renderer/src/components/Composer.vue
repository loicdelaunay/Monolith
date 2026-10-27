<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { Conversation } from '@monolith/contracts';
import { api, errorCode, errorMessage } from '../api.ts';
import { store } from '../stores/app.ts';
import ModelPicker from './ModelPicker.vue';

const props = defineProps<{ conversation: Conversation }>();
const emit = defineEmits<{ sent: [] }>();
const { t, te } = useI18n();
const toast = useToast();

const text = ref(props.conversation.draft);
const textarea = ref<HTMLTextAreaElement | null>(null);
const expanded = ref(false);
const expandedArea = ref<HTMLTextAreaElement | null>(null);
const lines = computed(() => text.value.split('\n').length);
const generating = computed(() => props.conversation.generating);
const MAX_VISIBLE_LINES = 10;

// ---------- Brouillon par conversation ----------
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraft: { id: number; draft: string } | null = null;
function flushDraft() {
  clearTimeout(saveTimer);
  if (!pendingDraft) return;
  const d = pendingDraft;
  pendingDraft = null;
  void api.call('conversations.saveDraft', { id: d.id, draft: d.draft }).catch(() => undefined);
  const c = store.conversations.get(d.id);
  if (c) c.draft = d.draft;
}
watch(text, (value) => {
  pendingDraft = { id: props.conversation.id, draft: value };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDraft, 400);
  autoSize();
});
watch(
  () => props.conversation.id,
  async () => {
    flushDraft();
    text.value = props.conversation.draft;
    await nextTick();
    autoSize();
    textarea.value?.focus();
  },
);
onBeforeUnmount(flushDraft);
window.addEventListener('beforeunload', flushDraft);
onBeforeUnmount(() => window.removeEventListener('beforeunload', flushDraft));

function autoSize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = 'auto';
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
  const max = lineHeight * MAX_VISIBLE_LINES + 16;
  const next = `${Math.min(el.scrollHeight, max)}px`;
  if (el.style.height !== next) el.style.height = next;
}

// ---------- Envoi ----------
const sending = ref(false);
async function send() {
  const value = text.value;
  if (!value.trim() || sending.value || generating.value) return;
  sending.value = true;
  try {
    clearTimeout(saveTimer);
    pendingDraft = null;
    await api.call('chat.send', { conversationId: props.conversation.id, input: { text: value } });
    text.value = '';
    expanded.value = false;
    const c = store.conversations.get(props.conversation.id);
    if (c) c.draft = '';
    emit('sent');
  } catch (e) {
    const code = errorCode(e);
    toast.add({
      severity: 'error',
      summary: t('chat.sendFailed'),
      detail: code === 'busy' ? t('chat.busy') : `${te(`errors.${code}`) ? t(`errors.${code}`) + ' — ' : ''}${errorMessage(e)}`,
      life: 7000,
    });
  } finally {
    sending.value = false;
    await nextTick();
    textarea.value?.focus();
  }
}

async function stop() {
  await api.call('chat.cancel', { conversationId: props.conversation.id }).catch(() => undefined);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    void send();
  } else if (e.key === 'Escape' && generating.value) {
    e.preventDefault();
    void stop();
  }
}

// ---------- Fichiers déposés : pièces jointes en tranche T2 ----------
function onDrop(e: DragEvent) {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  toast.add({ severity: 'info', summary: t('composer.attachmentsTitle'), detail: t('composer.attachmentsPlanned'), life: 6000 });
}

async function openExpanded() {
  expanded.value = true;
  await nextTick();
  expandedArea.value?.focus();
}

defineExpose({ focus: () => textarea.value?.focus() });
</script>

<template>
  <div class="composer" @dragover.prevent @drop="onDrop">
    <div class="box">
      <textarea
        ref="textarea"
        v-model="text"
        class="input"
        rows="1"
        :placeholder="t('chat.placeholder')"
        :aria-label="t('chat.placeholder')"
        spellcheck="true"
        @keydown="onKeydown"
      />
      <button v-if="lines > MAX_VISIBLE_LINES" type="button" class="mh-icon-btn expand" :aria-label="t('chat.expand')" v-tooltip.left="t('chat.expand')" @click="openExpanded">
        <i class="pi pi-window-maximize" />
      </button>
      <div class="toolbar">
        <ModelPicker :conversation="conversation" />
        <div class="send-zone">
          <Button v-if="generating" severity="secondary" rounded :aria-label="t('chat.stop')" v-tooltip.top="t('chat.stop')" @click="stop">
            <template #icon><i class="pi pi-stop-circle" /></template>
          </Button>
          <Button v-else rounded :disabled="!text.trim() || sending" :aria-label="t('chat.send')" v-tooltip.top="t('chat.send')" @click="send">
            <template #icon><i class="pi pi-arrow-up" /></template>
          </Button>
        </div>
      </div>
    </div>

    <Dialog v-model:visible="expanded" modal maximizable :header="t('chat.expandedTitle')" :style="{ width: 'min(1100px, 94vw)', height: '86vh' }" :content-style="{ display: 'flex', flex: '1' }">
      <textarea ref="expandedArea" v-model="text" class="expanded-input" :aria-label="t('chat.expandedTitle')" @keydown.enter.ctrl.prevent="send" />
      <template #footer>
        <span class="mh-hint">{{ t('composer.expandedHint') }}</span>
        <Button :label="t('chat.collapse')" severity="secondary" outlined @click="expanded = false" />
        <Button :label="t('composer.sendShort')" icon="pi pi-arrow-up" :disabled="!text.trim() || generating" @click="send" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.composer {
  padding: 0 20px 16px;
}
.box {
  position: relative;
  max-width: 900px;
  margin: 0 auto;
  border: 1px solid var(--mh-border);
  border-radius: 16px;
  background: var(--mh-surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%), 0 4px 18px rgb(0 0 0 / 4%);
  transition: border-color var(--mh-transition);
}
.box:focus-within {
  border-color: color-mix(in srgb, var(--mh-accent) 55%, var(--mh-border));
}
.input {
  display: block;
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  padding: 14px 44px 6px 16px;
  font-family: var(--mh-font-input);
  font-size: var(--mh-reading-size);
  line-height: 1.5;
  max-height: calc(1.5em * 10 + 20px);
  overflow-y: auto;
}
.input:focus-visible {
  outline: none;
}
.expand {
  position: absolute;
  top: 8px;
  right: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 8px 10px;
  flex-wrap: wrap;
}
.send-zone {
  margin-left: auto;
  flex: none;
}
.expanded-input {
  flex: 1;
  width: 100%;
  resize: none;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 14px 16px;
  background: var(--mh-surface);
  font-family: var(--mh-font-input);
  font-size: var(--mh-reading-size);
  line-height: 1.55;
}
@media (max-width: 760px) {
  .composer {
    padding: 0 10px 10px;
  }
}
</style>
