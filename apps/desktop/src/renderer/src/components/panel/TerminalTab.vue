<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { Id, TerminalInfo } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { stripAnsi } from '../../lib/format.ts';

const props = defineProps<{ conversationId: Id }>();
const { t } = useI18n();
const toast = useToast();

const terminals = ref<TerminalInfo[]>([]);
const selected = ref<string | null>(null);
const output = ref('');
const command = ref('');
const out = ref<HTMLElement | null>(null);
const MAX = 400_000;
const current = computed(() => terminals.value.find((x) => x.id === selected.value) ?? null);

const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

async function refresh() {
  terminals.value = await api.call('terminals.list', { conversationId: props.conversationId }).catch(() => []);
  if (!selected.value && terminals.value.length) await pick(terminals.value.at(-1)!.id);
}
async function pick(id: string) {
  selected.value = id;
  const r = await api.call('terminals.output', { terminalId: id }).catch((e) => (fail(e), null));
  output.value = r ? stripAnsi(r.output).slice(-MAX) : '';
  scroll();
}
function scroll() {
  void nextTick(() => {
    if (out.value) out.value.scrollTop = out.value.scrollHeight;
  });
}
async function run() {
  const cmd = command.value.trim();
  if (!cmd) return;
  try {
    const info = await api.call('terminals.run', { conversationId: props.conversationId, command: cmd });
    command.value = '';
    await refresh();
    await pick(info.id);
  } catch (e) {
    fail(e);
  }
}
const kill = (id: string) => api.call('terminals.kill', { terminalId: id }).catch(fail);

const offs: (() => void)[] = [];
onMounted(() => {
  void refresh();
  offs.push(
    api.on('terminal.output', ({ terminalId, conversationId, chunk }) => {
      if (conversationId !== props.conversationId) return;
      if (terminalId !== selected.value) return;
      const stick = !out.value || out.value.scrollHeight - out.value.scrollTop - out.value.clientHeight < 40;
      output.value = (output.value + stripAnsi(chunk)).slice(-MAX);
      if (stick) scroll();
    }),
    api.on('terminal.changed', ({ terminal }) => {
      if (terminal.conversationId !== props.conversationId) return;
      const i = terminals.value.findIndex((x) => x.id === terminal.id);
      if (i >= 0) terminals.value.splice(i, 1, terminal);
      else terminals.value.push(terminal);
    }),
  );
});
onBeforeUnmount(() => offs.forEach((f) => f()));

const statusLabel = (x: TerminalInfo) => t(`panel.terminal.status.${x.status}`, { code: x.exitCode ?? '?' });
</script>

<template>
  <div class="term">
    <div class="list" role="listbox" :aria-label="t('panel.tabs.terminal')">
      <p v-if="!terminals.length" class="mh-muted pad">{{ t('panel.terminal.none') }}</p>
      <button v-for="x in terminals" :key="x.id" type="button" role="option" class="item" :class="{ active: x.id === selected }" :aria-selected="x.id === selected" @click="pick(x.id)">
        <i class="pi" :class="x.status === 'running' ? 'pi-spin pi-spinner' : x.exitCode === 0 ? 'pi-check' : 'pi-times'" />
        <span class="cmd">{{ x.command }}</span>
        <span class="st">{{ statusLabel(x) }}</span>
      </button>
    </div>
    <div v-if="current" class="meta">
      <span class="mh-muted">{{ t('panel.terminal.cwd') }} : {{ current.cwd }}</span>
      <Button v-if="current.status === 'running'" size="small" severity="danger" text icon="pi pi-stop" :label="t('panel.terminal.kill')" @click="kill(current.id)" />
    </div>
    <pre ref="out" class="out" tabindex="0" aria-live="off">{{ output }}</pre>
    <form class="input" @submit.prevent="run">
      <span class="prompt">&gt;</span>
      <InputText v-model="command" :placeholder="t('panel.terminal.command')" :aria-label="t('panel.terminal.command')" size="small" class="grow mono" />
      <Button type="submit" size="small" icon="pi pi-play" :label="t('panel.terminal.run')" :disabled="!command.trim()" />
    </form>
    <p class="hint mh-muted">{{ t('panel.terminal.hint') }}</p>
  </div>
</template>

<style scoped>
.term {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.list {
  max-height: 30%;
  overflow: auto;
  border-bottom: 1px solid var(--mh-border);
  padding: 4px;
}
.pad {
  padding: 12px;
  margin: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--mh-radius-sm);
  background: none;
  color: var(--mh-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.item:hover {
  background: var(--mh-hover);
}
.item.active {
  background: color-mix(in srgb, var(--mh-accent) 12%, transparent);
}
.cmd {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mh-font-mono);
  font-size: 12px;
}
.st {
  color: var(--mh-muted);
  font-size: 11px;
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
}
.out {
  flex: 1;
  min-height: 80px;
  margin: 0;
  padding: 10px;
  overflow: auto;
  background: color-mix(in srgb, var(--mh-text) 6%, var(--mh-surface));
  font-family: var(--mh-font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--mh-border);
}
.prompt {
  font-family: var(--mh-font-mono);
  color: var(--mh-muted);
}
.grow {
  flex: 1;
  min-width: 0;
}
.mono {
  font-family: var(--mh-font-mono);
}
.hint {
  margin: 0;
  padding: 0 10px 8px;
  font-size: 11px;
}
</style>
