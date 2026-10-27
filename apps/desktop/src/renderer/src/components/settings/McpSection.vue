<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { McpImportPreview, McpServer, McpServerInput } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';

const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const servers = ref<McpServer[]>([]);
const editing = ref<number | 'new' | null>(null);
const expanded = ref<number | null>(null);
const busy = ref<number | null>(null);
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 8000 });

let off: (() => void) | null = null;
onMounted(async () => {
  servers.value = await api.call('mcp.list').catch(() => []);
  off = api.on('mcp.changed', ({ servers: s }) => (servers.value = s));
});
onBeforeUnmount(() => off?.());

// ---------- Formulaire ----------
const form = reactive({ name: '', transport: 'stdio' as 'stdio' | 'http', command: '', args: '', env: '', url: '', headers: '', secrets: '', enabled: true });
const pairs = (text: string, sep: string) => {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};
function startNew() {
  Object.assign(form, { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', secrets: '', enabled: true });
  editing.value = 'new';
}
function startEdit(s: McpServer) {
  Object.assign(form, {
    name: s.name,
    transport: s.transport,
    command: s.config.command,
    args: s.config.args.join('\n'),
    env: Object.entries(s.config.env).map(([k, v]) => `${k}=${v}`).join('\n'),
    url: s.config.url,
    headers: Object.entries(s.config.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    secrets: '',
    enabled: s.enabled,
  });
  editing.value = s.id;
}
async function save() {
  const input: McpServerInput = {
    name: form.name,
    transport: form.transport,
    config: { command: form.command, args: form.args.split('\n').map((a) => a.trim()).filter(Boolean), env: pairs(form.env, '='), url: form.url, headers: pairs(form.headers, ':') },
    secrets: pairs(form.secrets, form.transport === 'http' ? ':' : '='),
    enabled: form.enabled,
  };
  try {
    if (editing.value === 'new') await api.call('mcp.create', input);
    else if (typeof editing.value === 'number') await api.call('mcp.update', { id: editing.value, patch: input });
    editing.value = null;
    toast.add({ severity: 'success', summary: t('common.saved'), life: 2000 });
  } catch (e) {
    fail(e);
  }
}

// ---------- Import ----------
const importing = ref(false);
const importJson = ref('');
const preview = ref<McpImportPreview | null>(null);
async function doPreview() {
  preview.value = await api.call('mcp.previewImport', { json: importJson.value }).catch((e) => (fail(e), null));
}
async function doImport() {
  try {
    await api.call('mcp.import', { json: importJson.value });
    importing.value = false;
    importJson.value = '';
    preview.value = null;
  } catch (e) {
    fail(e);
  }
}

async function toggleConnect(s: McpServer) {
  busy.value = s.id;
  try {
    await api.call(s.status === 'connected' ? 'mcp.disconnect' : 'mcp.connect', { id: s.id });
    if (s.status !== 'connected') expanded.value = s.id;
  } catch (e) {
    fail(e);
  } finally {
    busy.value = null;
  }
}
function setEnabled(id: number, enabled: boolean) {
  api.call('mcp.update', { id, patch: { enabled } }).catch(fail);
}
function remove(s: McpServer) {
  confirm.require({
    header: t('settings.mcpSettings.deleteTitle', { name: s.name }),
    message: t('settings.mcpSettings.deleteMessage'),
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('common.delete'), severity: 'danger' },
    accept: () => api.call('mcp.delete', { id: s.id }).catch(fail),
  });
}
const transportOptions = ['stdio', 'http'].map((v) => ({ value: v, label: t(`settings.mcpSettings.transports.${v}`) }));
const statusIcon = { disconnected: 'pi-circle', connecting: 'pi-spin pi-spinner', connected: 'pi-circle-fill ok', error: 'pi-exclamation-circle bad' } as const;
</script>

<template>
  <p class="mh-hint">{{ t('settings.mcpSettings.hint') }}</p>
  <div class="mh-row wrap actions">
    <Button :label="t('settings.mcpSettings.add')" icon="pi pi-plus" size="small" @click="startNew" />
    <Button :label="t('settings.mcpSettings.import')" icon="pi pi-download" size="small" severity="secondary" outlined @click="importing = !importing" />
  </div>

  <div v-if="importing" class="box">
    <p class="mh-hint">{{ t('settings.mcpSettings.importHint') }}</p>
    <Textarea v-model="importJson" rows="6" fluid class="mono" spellcheck="false" placeholder='{ "mcpServers": { "nom": { "command": "npx", "args": ["-y", "…"] } } }' />
    <div class="mh-row wrap">
      <Button :label="t('settings.mcpSettings.preview')" size="small" severity="secondary" :disabled="!importJson.trim()" @click="doPreview" />
      <Button v-if="preview && preview.servers.some((s) => !s.exists)" :label="t('settings.mcpSettings.importAction', { count: preview.servers.filter((s) => !s.exists).length })" size="small" icon="pi pi-check" @click="doImport" />
    </div>
    <ul v-if="preview" class="preview">
      <li v-for="s in preview.servers" :key="s.name">
        <strong>{{ s.name }}</strong> — {{ t(`settings.mcpSettings.transports.${s.transport}`) }} · <code>{{ s.transport === 'http' ? s.config.url : [s.config.command, ...(s.config.args ?? [])].join(' ') }}</code>
        <span v-if="Object.keys(s.secrets ?? {}).length" class="mh-hint"> · 🔒 {{ Object.keys(s.secrets ?? {}).join(', ') }}</span>
        <span v-if="s.exists" class="warn"> · {{ t('settings.mcpSettings.exists') }}</span>
      </li>
      <li v-for="e in preview.errors" :key="e" class="warn">{{ e }}</li>
    </ul>
  </div>

  <div v-if="editing !== null" class="box">
    <div class="mh-row wrap">
      <div class="mh-field grow">
        <label for="mcp-name">{{ t('settings.mcpSettings.name') }}</label>
        <InputText id="mcp-name" v-model="form.name" maxlength="60" fluid />
      </div>
      <div class="mh-field">
        <label for="mcp-tr">{{ t('settings.mcpSettings.transport') }}</label>
        <Select input-id="mcp-tr" v-model="form.transport" :options="transportOptions" option-label="label" option-value="value" />
      </div>
    </div>
    <template v-if="form.transport === 'stdio'">
      <div class="mh-field">
        <label for="mcp-cmd">{{ t('settings.mcpSettings.command') }}</label>
        <InputText id="mcp-cmd" v-model="form.command" fluid spellcheck="false" class="mono" />
      </div>
      <div class="mh-field">
        <label for="mcp-args">{{ t('settings.mcpSettings.args') }}</label>
        <Textarea id="mcp-args" v-model="form.args" rows="2" auto-resize fluid spellcheck="false" class="mono" />
      </div>
      <div class="mh-field">
        <label for="mcp-env">{{ t('settings.mcpSettings.env') }}</label>
        <Textarea id="mcp-env" v-model="form.env" rows="2" auto-resize fluid spellcheck="false" class="mono" />
      </div>
    </template>
    <template v-else>
      <div class="mh-field">
        <label for="mcp-url">{{ t('settings.mcpSettings.url') }}</label>
        <InputText id="mcp-url" v-model="form.url" fluid spellcheck="false" placeholder="https://…/mcp" />
      </div>
      <div class="mh-field">
        <label for="mcp-hdr">{{ t('settings.mcpSettings.headers') }}</label>
        <Textarea id="mcp-hdr" v-model="form.headers" rows="2" auto-resize fluid spellcheck="false" class="mono" />
      </div>
    </template>
    <div class="mh-field">
      <label for="mcp-sec">{{ t('settings.mcpSettings.secrets') }}</label>
      <Textarea id="mcp-sec" v-model="form.secrets" rows="2" auto-resize fluid spellcheck="false" class="mono" :placeholder="form.transport === 'http' ? 'Authorization: Bearer …' : 'GITHUB_TOKEN=…'" />
      <p class="mh-hint">{{ t('settings.mcpSettings.secretsHint') }}</p>
      <p v-if="typeof editing === 'number'" class="mh-hint">{{ t('settings.mcpSettings.secretsSaved', { names: [...(servers.find((s) => s.id === editing)?.config.secretEnv ?? []), ...(servers.find((s) => s.id === editing)?.config.secretHeaders ?? [])].join(', ') || '—' }) }}</p>
    </div>
    <div class="mh-switch-row">
      <label for="mcp-en">{{ t('settings.mcpSettings.enabled') }}</label>
      <ToggleSwitch input-id="mcp-en" v-model="form.enabled" />
    </div>
    <div class="mh-row end">
      <Button :label="t('common.cancel')" severity="secondary" text size="small" @click="editing = null" />
      <Button :label="t('settings.mcpSettings.save')" icon="pi pi-check" size="small" :disabled="!form.name.trim()" @click="save" />
    </div>
  </div>

  <p v-if="!servers.length && editing === null" class="mh-muted">{{ t('settings.mcpSettings.empty') }}</p>
  <div v-for="s in servers" :key="s.id" class="server">
    <div class="mh-row head">
      <i class="pi" :class="statusIcon[s.status]" />
      <button type="button" class="name" @click="expanded = expanded === s.id ? null : s.id">
        <strong>{{ s.name }}</strong>
        <span class="mh-hint">{{ t(`settings.mcpSettings.status.${s.status}`) }}<template v-if="s.status === 'connected'"> · {{ t('settings.mcpSettings.tools', { count: s.tools.length }) }}<template v-if="s.serverInfo"> · {{ s.serverInfo.name }} {{ s.serverInfo.version }}</template></template></span>
      </button>
      <ToggleSwitch :model-value="s.enabled" :aria-label="t('settings.mcpSettings.enabled')" v-tooltip.top="t('settings.mcpSettings.enabled')" @update:model-value="(v: boolean) => setEnabled(s.id, v)" />
      <Button :label="s.status === 'connected' ? t('settings.mcpSettings.disconnect') : t('settings.mcpSettings.connect')" size="small" severity="secondary" outlined :loading="busy === s.id" @click="toggleConnect(s)" />
      <Button icon="pi pi-pencil" text rounded size="small" :aria-label="t('common.edit')" @click="startEdit(s)" />
      <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="t('common.delete')" @click="remove(s)" />
    </div>
    <Message v-if="s.error" severity="error" size="small">{{ s.error }}</Message>
    <ul v-if="expanded === s.id && s.tools.length" class="tools">
      <li v-for="tool in s.tools" :key="tool.name">
        <code>{{ tool.name }}</code><span v-if="tool.readOnly" class="tag">{{ t('settings.mcpSettings.readOnly') }}</span>
        <span class="mh-hint"> — {{ tool.description }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.actions {
  margin: 10px 0;
  gap: 8px;
}
.box {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 12px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mono {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.preview {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
}
.warn {
  color: var(--mh-warning);
}
.server {
  border-bottom: 1px solid var(--mh-border);
  padding: 8px 0;
}
.head {
  gap: 8px;
  align-items: center;
}
.name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border: 0;
  background: none;
  color: var(--mh-text);
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.pi.ok {
  color: #2f9e5b;
}
.pi.bad {
  color: var(--mh-danger);
}
.tools {
  margin: 6px 0 0;
  padding-left: 22px;
  font-size: 12.5px;
}
.tag {
  margin-left: 6px;
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--mh-hover);
}
.end {
  justify-content: flex-end;
}
.grow {
  flex: 1;
}
</style>
