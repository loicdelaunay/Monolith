<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Popover from 'primevue/popover';
import Menu from 'primevue/menu';
import { useToast } from 'primevue/usetoast';
import { ATTACHMENT_LIMITS, type AttachmentRef, type Conversation, type ContextUsage } from '@monolith/contracts';
import { api, errorCode, errorMessage } from '../api.ts';
import { messagesOf, store } from '../stores/app.ts';
import { uploadFiles, formatSize } from '../lib/attachments.ts';
import { chatActions } from '../lib/chat-actions.ts';
import { formatTokens, throughput } from '../lib/format.ts';
import ModelPicker from './ModelPicker.vue';
import ModeSelect from './ModeSelect.vue';
import AttachmentChip from './AttachmentChip.vue';
import TemplatesDialog from './TemplatesDialog.vue';

const props = defineProps<{ conversation: Conversation }>();
const emit = defineEmits<{ sent: []; 'open-goal': [] }>();
const { t, te } = useI18n();
const toast = useToast();
const actions = chatActions(toast);

const text = ref(props.conversation.draft);
const attachments = ref<AttachmentRef[]>([...props.conversation.draftAttachments]);
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const expanded = ref(false);
const expandedArea = ref<HTMLTextAreaElement | null>(null);
const lines = computed(() => text.value.split('\n').length);
const generating = computed(() => props.conversation.generating);
const canSend = computed(() => (text.value.trim().length > 0 || attachments.value.length > 0) && !sending.value);
const MAX_VISIBLE_LINES = 10;

// ---------- Brouillon par conversation (texte et pièces jointes) ----------
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraft: { id: number; draft: string; attachmentIds: number[] } | null = null;
function flushDraft() {
  clearTimeout(saveTimer);
  if (!pendingDraft) return;
  const d = pendingDraft;
  pendingDraft = null;
  void api.call('conversations.saveDraft', { id: d.id, draft: d.draft, attachmentIds: d.attachmentIds }).catch(() => undefined);
  const c = store.conversations.get(d.id);
  if (c) {
    c.draft = d.draft;
    c.draftAttachments = attachments.value.filter((a) => d.attachmentIds.includes(a.id));
  }
}
function scheduleDraft() {
  pendingDraft = { id: props.conversation.id, draft: text.value, attachmentIds: attachments.value.map((a) => a.id) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDraft, 400);
}
watch(text, () => {
  scheduleDraft();
  autoSize();
});
watch(attachments, scheduleDraft, { deep: true });
watch(
  () => props.conversation.id,
  async () => {
    flushDraft();
    loadDraft();
    await nextTick();
    autoSize();
    textarea.value?.focus();
  },
);
// Brouillon remplacé par le moteur (« Reprendre ici »).
watch(
  () => [props.conversation.draft, props.conversation.draftAttachments.map((a) => a.id).join(',')] as const,
  () => {
    if (pendingDraft) return;
    if (props.conversation.draft !== text.value || props.conversation.draftAttachments.length !== attachments.value.length) loadDraft();
  },
);
function loadDraft() {
  text.value = props.conversation.draft;
  attachments.value = [...props.conversation.draftAttachments];
  pendingDraft = null;
}
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

// ---------- Envoi : direct, en file ou transmis pendant la génération ----------
const sending = ref(false);
async function send(mode: 'send' | 'queue' | 'steer' = generating.value ? 'queue' : 'send') {
  if (!canSend.value) return;
  sending.value = true;
  try {
    clearTimeout(saveTimer);
    pendingDraft = null;
    const r = await api.call('chat.send', { conversationId: props.conversation.id, input: { text: text.value, attachmentIds: attachments.value.map((a) => a.id), mode } });
    text.value = '';
    attachments.value = [];
    pendingDraft = null;
    clearTimeout(saveTimer);
    expanded.value = false;
    const c = store.conversations.get(props.conversation.id);
    if (c) {
      c.draft = '';
      c.draftAttachments = [];
    }
    if (r.status === 'queued') toast.add({ severity: 'info', summary: t('queue.added'), life: 2000 });
    if (r.status === 'steered') toast.add({ severity: 'info', summary: t('queue.steered'), life: 3000 });
    emit('sent');
  } catch (e) {
    const code = errorCode(e);
    toast.add({ severity: 'error', summary: t('chat.sendFailed'), detail: `${te(`errors.${code}`) ? t(`errors.${code}`) + ' — ' : ''}${errorMessage(e)}`, life: 7000 });
  } finally {
    sending.value = false;
    await nextTick();
    textarea.value?.focus();
  }
}

async function stop() {
  await api.call('chat.cancel', { conversationId: props.conversation.id }).catch(() => undefined);
}

// ---------- Commandes « / » ----------
interface SlashCommand {
  name: string;
  icon: string;
  run: () => unknown;
}
const COMMANDS: SlashCommand[] = [
  { name: 'compact', icon: 'pi-compress', run: () => actions.compact(props.conversation.id) },
  { name: 'export', icon: 'pi-download', run: () => actions.exportMarkdown(props.conversation.id, false) },
  { name: 'fork', icon: 'pi-clone', run: () => actions.fork(props.conversation.id) },
  { name: 'goal', icon: 'pi-flag', run: () => emit('open-goal') },
  { name: 'template', icon: 'pi-bookmark', run: () => (templatesOpen.value = true) },
];
const slashIndex = ref(0);
const slashMatches = computed(() => {
  const v = text.value;
  if (!v.startsWith('/') || /\s/.test(v)) return [];
  const q = v.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
});
watch(slashMatches, () => (slashIndex.value = 0));
function runSlash(cmd: SlashCommand) {
  text.value = '';
  void cmd.run();
}

function onKeydown(e: KeyboardEvent) {
  if (slashMatches.value.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = slashMatches.value.length;
      slashIndex.value = (slashIndex.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      runSlash(slashMatches.value[slashIndex.value]!);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      text.value = '';
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    // Pendant une génération : Entrée met en file, Alt+Entrée transmet à la prochaine frontière.
    void send(generating.value ? (e.altKey ? 'steer' : 'queue') : 'send');
  } else if (e.key === 'Escape' && generating.value) {
    e.preventDefault();
    void stop();
  }
}

// ---------- Pièces jointes : bouton, glisser-déposer, collage ----------
async function addFiles(files: File[]) {
  if (!files.length) return;
  const room = ATTACHMENT_LIMITS.perMessage - attachments.value.length;
  if (files.length > room) toast.add({ severity: 'warn', summary: t('composer.tooMany', { max: ATTACHMENT_LIMITS.perMessage }), life: 5000 });
  const { refs, errors } = await uploadFiles(files.slice(0, Math.max(0, room)));
  attachments.value = [...attachments.value, ...refs];
  for (const err of errors) toast.add({ severity: 'error', summary: t('composer.attachmentRejected'), detail: err, life: 8000 });
}
function onDrop(e: DragEvent) {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  void addFiles([...e.dataTransfer.files]);
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length === 0) return;
  e.preventDefault();
  void addFiles(files);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  void addFiles([...(input.files ?? [])]);
  input.value = '';
}
function removeAttachment(id: number) {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

// ---------- Modèles de messages ----------
const templatesPop = ref<InstanceType<typeof Popover> | null>(null);
const templatesOpen = ref(false);
function insertTemplate(content: string) {
  templatesPop.value?.hide();
  const el = textarea.value;
  const pos = el?.selectionStart ?? text.value.length;
  text.value = text.value.slice(0, pos) + content + text.value.slice(pos);
  void nextTick(() => {
    el?.focus();
    el?.setSelectionRange(pos + content.length, pos + content.length);
  });
}

// ---------- Utilisation du contexte (réglage) ----------
const context = ref<ContextUsage | null>(null);
const showContext = computed(() => store.settings?.chat.showContextUsage ?? false);
async function refreshContext() {
  if (!showContext.value) return;
  context.value = await api.call('conversations.contextUsage', { id: props.conversation.id }).catch(() => null);
}
// Mis à jour aux événements utiles (fin de génération, changement de conversation ou de modèle), jamais en boucle.
watch(() => [props.conversation.id, props.conversation.generating, props.conversation.model, props.conversation.providerId, showContext.value, store.compactions.get(props.conversation.id)?.length], refreshContext, { immediate: true });
const contextPercent = computed(() => (context.value?.contextWindow ? Math.min(100, Math.round((context.value.tokens / context.value.contextWindow) * 100)) : null));

// ---------- Vitesse (réglage « Afficher le débit ») ----------
// Pendant la génération : estimation en direct (≈ 4 caractères par token) ; ensuite : débit mesuré de la dernière réponse.
const showSpeed = computed(() => store.settings?.chat.showThroughput ?? false);
const liveSpeed = ref<number | null>(null);
const lastSpeed = computed(() => {
  void generating.value;
  const last = [...messagesOf(props.conversation.id).value].reverse().find((m) => m.role === 'assistant' && m.status !== 'streaming');
  return last ? throughput(last) : null;
});
let speedTimer: ReturnType<typeof setInterval> | undefined;
watch(
  () => [generating.value, showSpeed.value, props.conversation.id] as const,
  ([gen, show]) => {
    clearInterval(speedTimer);
    liveSpeed.value = null;
    if (!gen || !show) return;
    let start: number | null = null;
    speedTimer = setInterval(() => {
      const m = messagesOf(props.conversation.id).value.at(-1);
      if (!m || m.role !== 'assistant' || m.status !== 'streaming') return;
      const chars = m.parts.reduce((n, p) => n + (p.type === 'text' || p.type === 'reasoning' ? p.text.length : 0), 0);
      if (!chars) return;
      start ??= performance.now();
      const sec = (performance.now() - start) / 1000;
      if (sec > 0.5) liveSpeed.value = chars / 4 / sec;
    }, 500);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(speedTimer));
const speed = computed(() => (generating.value ? liveSpeed.value : lastSpeed.value));

// ---------- Menu « + » : pièces jointes et modèles de messages ----------
const plusMenu = ref<InstanceType<typeof Menu> | null>(null);
const plusBtn = ref<HTMLElement | null>(null);
const plusItems = computed(() => [
  { label: t('composer.attach'), icon: 'pi pi-paperclip', command: () => fileInput.value?.click() },
  { label: t('templates.title'), icon: 'pi pi-bookmark', command: () => setTimeout(() => templatesPop.value?.show({ currentTarget: plusBtn.value } as unknown as Event, plusBtn.value ?? undefined), 0) },
]);

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
      <ul v-if="slashMatches.length" class="slash" role="listbox" :aria-label="t('composer.commands')">
        <li v-for="(cmd, i) in slashMatches" :key="cmd.name" role="option" :aria-selected="i === slashIndex" :class="{ active: i === slashIndex }" @mousedown.prevent="runSlash(cmd)">
          <i class="pi" :class="cmd.icon" />
          <span class="slash-name">/{{ cmd.name }}</span>
          <span class="mh-hint">{{ t(`composer.slash.${cmd.name}`) }}</span>
        </li>
      </ul>

      <div v-if="attachments.length" class="chips">
        <AttachmentChip v-for="a in attachments" :key="a.id" :attachment="a" removable @remove="removeAttachment(a.id)" />
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        class="input"
        rows="1"
        :placeholder="generating ? t('composer.placeholderBusy') : t('chat.placeholder')"
        :aria-label="t('chat.placeholder')"
        spellcheck="true"
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <button v-if="lines > MAX_VISIBLE_LINES" type="button" class="mh-icon-btn expand" :aria-label="t('chat.expand')" v-tooltip.left="t('chat.expand')" @click="openExpanded">
        <i class="pi pi-window-maximize" />
      </button>

      <div class="toolbar">
        <div class="left">
          <button ref="plusBtn" type="button" class="round-btn" :aria-label="t('composer.more')" aria-haspopup="menu" v-tooltip.top="t('composer.attachHint', { image: formatSize(ATTACHMENT_LIMITS.imageBytes), text: formatSize(ATTACHMENT_LIMITS.textBytes) })" @click="plusMenu?.toggle($event)">
            <i class="pi pi-plus" />
          </button>
          <Menu ref="plusMenu" :model="plusItems" popup />
          <input ref="fileInput" type="file" multiple hidden @change="onPick" />
          <ModeSelect :conversation="conversation" />
        </div>
        <div class="right">
          <span v-if="(showContext && context) || (showSpeed && speed)" class="stats">
            <span v-if="showContext && context" class="stat" :class="{ warn: (contextPercent ?? 0) >= 80 }" v-tooltip.top="context.source === 'estimate' ? t('chat.estimatedHint') : t('chat.contextTitle')">
              <i class="pi pi-chart-pie" />{{ formatTokens(context.tokens) }} / {{ context.contextWindow ? formatTokens(context.contextWindow) : '?' }}<template v-if="contextPercent !== null"> · {{ contextPercent }} %</template><template v-if="context.source === 'estimate'">*</template>
            </span>
            <span v-if="showSpeed && speed" class="stat" v-tooltip.top="generating ? t('chat.speedLive') : t('chat.speedLast')">
              <i class="pi pi-gauge" />{{ t('chat.throughput', { value: speed.toFixed(speed < 10 ? 1 : 0) }) }}
            </span>
          </span>
          <ModelPicker :conversation="conversation" />
          <template v-if="generating">
            <button type="button" class="round-btn" :disabled="!canSend" :aria-label="t('queue.steer')" v-tooltip.top="t('queue.steerHint')" @click="send('steer')"><i class="pi pi-bolt" /></button>
            <button type="button" class="round-btn" :disabled="!canSend" :aria-label="t('queue.enqueue')" v-tooltip.top="t('queue.enqueueHint')" @click="send('queue')"><i class="pi pi-list" /></button>
            <button type="button" class="send stop" :aria-label="t('chat.stop')" v-tooltip.top="t('chat.stop')" @click="stop"><i class="pi pi-stop" /></button>
          </template>
          <button v-else type="button" class="send" :disabled="!canSend" :aria-label="t('chat.send')" v-tooltip.top="t('chat.send')" @click="send('send')"><i class="pi pi-arrow-up" /></button>
        </div>
      </div>
    </div>

    <Popover ref="templatesPop">
      <div class="templates">
        <button v-for="tpl in store.templates" :key="tpl.id" type="button" class="tpl" @click="insertTemplate(tpl.content)">
          <strong>{{ tpl.name }}</strong>
          <span class="mh-hint">{{ tpl.content.slice(0, 90) }}</span>
        </button>
        <p v-if="store.templates.length === 0" class="mh-hint">{{ t('templates.empty') }}</p>
        <Button :label="t('templates.manage')" icon="pi pi-cog" size="small" text @click="(templatesPop?.hide(), (templatesOpen = true))" />
      </div>
    </Popover>
    <TemplatesDialog v-model:visible="templatesOpen" :draft="text" @insert="insertTemplate" />

    <Dialog v-model:visible="expanded" modal maximizable :header="t('chat.expandedTitle')" :style="{ width: 'min(1100px, 94vw)', height: '86vh' }" :content-style="{ display: 'flex', flex: '1' }">
      <textarea ref="expandedArea" v-model="text" class="expanded-input" :aria-label="t('chat.expandedTitle')" @keydown.enter.ctrl.prevent="send()" />
      <template #footer>
        <span class="mh-hint">{{ t('composer.expandedHint') }}</span>
        <Button :label="t('chat.collapse')" severity="secondary" outlined @click="expanded = false" />
        <Button :label="generating ? t('queue.enqueue') : t('composer.sendShort')" icon="pi pi-arrow-up" :disabled="!canSend" @click="send()" />
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
  border: 1px solid color-mix(in srgb, var(--mh-border) 60%, transparent);
  border-radius: 20px;
  background: color-mix(in srgb, var(--mh-text) 5%, var(--mh-surface));
  box-shadow: 0 2px 10px rgb(0 0 0 / 8%);
  transition: border-color var(--mh-transition);
}
.box:focus-within {
  border-color: color-mix(in srgb, var(--mh-accent) 40%, var(--mh-border));
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}
.input {
  display: block;
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  padding: 16px 44px 4px 20px;
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
  gap: 6px;
  padding: 4px 10px 10px 10px;
  flex-wrap: wrap;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.right {
  margin-left: auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
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
.round-btn:hover:not(:disabled) {
  background: var(--mh-hover);
}
.round-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.round-btn .pi-plus {
  font-size: 15px;
}
.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin-left: 6px;
  border: 0;
  border-radius: 50%;
  background: var(--mh-accent);
  color: var(--mh-accent-text);
  cursor: pointer;
  transition: opacity var(--mh-transition), transform var(--mh-transition);
}
.send:hover:not(:disabled) {
  transform: scale(1.05);
}
.send:disabled {
  opacity: 0.35;
  cursor: default;
}
.send.stop {
  background: var(--mh-text);
  color: var(--mh-bg);
}
.stats {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-right: 6px;
  font-size: 12px;
  color: var(--mh-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.stat .pi {
  font-size: 11px;
}
.stat.warn {
  color: var(--mh-warning);
}
.slash {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  list-style: none;
  margin: 0;
  padding: 4px;
  background: var(--mh-elevated);
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  box-shadow: 0 6px 24px rgb(0 0 0 / 14%);
  z-index: 5;
}
.slash li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
}
.slash li.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
}
.slash-name {
  font-family: var(--mh-font-mono);
  font-size: 13px;
  min-width: 90px;
}
.templates {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: min(360px, 80vw);
}
.tpl {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 0;
  background: transparent;
  padding: 8px;
  border-radius: var(--mh-radius-sm);
  text-align: left;
  cursor: pointer;
}
.tpl:hover {
  background: var(--mh-hover);
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
