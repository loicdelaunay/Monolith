<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { GitAction, GitCommit, GitStatusInfo, Id } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import DiffView from '../tools/DiffView.vue';

const props = defineProps<{ conversationId: Id }>();
const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();

const status = ref<GitStatusInfo | null>(null);
const branches = ref<{ current: string | null; branches: string[] }>({ current: null, branches: [] });
const log = ref<GitCommit[]>([]);
const message = ref('');
const busy = ref<GitAction | null>(null);
const view = ref<'changes' | 'history'>('changes');
const diff = ref<{ path: string; staged: boolean; before: string; after: string } | null>(null);

const staged = computed(() => status.value?.files.filter((f) => f.index !== '.' && f.index !== '?') ?? []);
const unstaged = computed(() => status.value?.files.filter((f) => f.worktree !== '.') ?? []);

const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 8000 });

async function refresh() {
  status.value = await api.call('git.status', { conversationId: props.conversationId }).catch((e) => (fail(e), null));
  if (!status.value?.available) return;
  [branches.value, log.value] = await Promise.all([
    api.call('git.branches', { conversationId: props.conversationId }).catch(() => ({ current: null, branches: [] })),
    api.call('git.log', { conversationId: props.conversationId, limit: 100 }).catch(() => []),
  ]);
  if (diff.value && !status.value.files.some((f) => f.path === diff.value!.path)) diff.value = null;
}
onMounted(refresh);

async function run(action: GitAction, extra: { paths?: string[]; message?: string; branch?: string } = {}) {
  busy.value = action;
  try {
    const r = await api.call('git.run', { conversationId: props.conversationId, action, ...extra });
    toast.add({ severity: 'success', summary: t('panel.git.done'), detail: r.output.slice(0, 400) || undefined, life: 3000 });
    if (action === 'commit') message.value = '';
  } catch (e) {
    fail(e);
  } finally {
    busy.value = null;
    await refresh();
  }
}

function discard(path: string) {
  confirm.require({
    header: t('panel.git.discard'),
    message: t('panel.git.discardConfirm', { path }),
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('panel.git.discard'), severity: 'danger' },
    accept: () => run('discard', { paths: [path] }),
  });
}
function push() {
  confirm.require({
    header: t('panel.git.push'),
    message: t('panel.git.pushConfirm', { upstream: status.value?.upstream ?? t('panel.git.noUpstream') }),
    icon: 'pi pi-upload',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('panel.git.push') },
    accept: () => run('push'),
  });
}
async function showDiff(path: string, isStaged: boolean) {
  try {
    const v = await api.call('git.fileVersions', { conversationId: props.conversationId, path, staged: isStaged });
    diff.value = { path, staged: isStaged, ...v };
  } catch (e) {
    fail(e);
  }
}
const code = (f: { index: string; worktree: string }, s: boolean) => (s ? f.index : f.worktree === '?' ? 'U' : f.worktree);
</script>

<template>
  <div class="git">
    <div v-if="status && !status.available" class="pad">
      <p><strong>{{ t('panel.git.unavailable') }}</strong></p>
      <p class="mh-muted">{{ status.reason }}</p>
      <Button size="small" text icon="pi pi-refresh" :label="t('panel.files.refresh')" @click="refresh" />
    </div>
    <template v-else-if="status">
      <div class="bar">
        <i class="pi pi-sitemap mh-muted" />
        <Select :model-value="branches.current" :options="branches.branches" :aria-label="t('panel.git.branch')" size="small" class="branch" :disabled="!!busy" @update:model-value="(b: string) => b !== branches.current && run('switch', { branch: b })" />
        <span v-if="status.ahead" class="badge">↑ {{ t('panel.git.ahead', { n: status.ahead }) }}</span>
        <span v-if="status.behind" class="badge">↓ {{ t('panel.git.behind', { n: status.behind }) }}</span>
        <span class="grow" />
        <Button size="small" text :label="t('panel.git.fetch')" icon="pi pi-download" :loading="busy === 'fetch'" :disabled="!!busy" @click="run('fetch')" />
        <Button size="small" text :label="t('panel.git.pull')" icon="pi pi-arrow-down" :loading="busy === 'pull'" :disabled="!!busy || !status.upstream" @click="run('pull')" />
        <Button size="small" text :label="t('panel.git.push')" icon="pi pi-upload" :loading="busy === 'push'" :disabled="!!busy" @click="push" />
        <button type="button" class="mh-icon-btn" :aria-label="t('panel.files.refresh')" @click="refresh"><i class="pi pi-refresh" /></button>
      </div>
      <div class="views" role="tablist">
        <button type="button" role="tab" :class="{ active: view === 'changes' }" :aria-selected="view === 'changes'" @click="view = 'changes'">{{ t('panel.git.changes') }} ({{ status.files.length }})</button>
        <button type="button" role="tab" :class="{ active: view === 'history' }" :aria-selected="view === 'history'" @click="view = 'history'">{{ t('panel.git.history') }}</button>
      </div>

      <div v-if="view === 'changes'" class="scroll">
        <p v-if="!status.files.length" class="mh-muted pad">{{ t('panel.git.clean') }}</p>
        <template v-for="group in [{ s: true, files: staged }, { s: false, files: unstaged }]" :key="String(group.s)">
          <h4 v-if="group.files.length" class="group">{{ group.s ? t('panel.git.staged') : t('panel.git.unstaged') }}</h4>
          <div v-for="f in group.files" :key="`${group.s}${f.path}`" class="file" :class="{ active: diff?.path === f.path && diff?.staged === group.s }">
            <button type="button" class="fname" @click="showDiff(f.path, group.s)">
              <span class="code" :data-code="code(f, group.s)">{{ code(f, group.s) }}</span>
              <span class="path">{{ f.path }}</span>
            </button>
            <button v-if="group.s" type="button" class="mh-icon-btn" :aria-label="t('panel.git.unstage')" v-tooltip.left="t('panel.git.unstage')" :disabled="!!busy" @click="run('unstage', { paths: [f.path] })"><i class="pi pi-minus" /></button>
            <template v-else>
              <button v-if="f.worktree !== '?'" type="button" class="mh-icon-btn" :aria-label="t('panel.git.discard')" v-tooltip.left="t('panel.git.discard')" :disabled="!!busy" @click="discard(f.path)"><i class="pi pi-undo" /></button>
              <button type="button" class="mh-icon-btn" :aria-label="t('panel.git.stage')" v-tooltip.left="t('panel.git.stage')" :disabled="!!busy" @click="run('stage', { paths: [f.path] })"><i class="pi pi-plus" /></button>
            </template>
          </div>
        </template>
        <div v-if="diff" class="diff">
          <DiffView :before="diff.before" :after="diff.after" :path="diff.path" />
        </div>
      </div>
      <div v-else class="scroll">
        <ol class="log">
          <li v-for="c in log" :key="c.hash">
            <code>{{ c.hash }}</code> <span class="subject">{{ c.subject }}</span>
            <span class="mh-muted small">{{ c.author }} · {{ new Date(c.date).toLocaleString() }}</span>
          </li>
        </ol>
      </div>

      <form v-if="view === 'changes'" class="commit" @submit.prevent="run('commit', { message })">
        <Textarea v-model="message" rows="2" auto-resize :placeholder="t('panel.git.commitMessage')" :aria-label="t('panel.git.commitMessage')" class="msg" />
        <Button type="submit" size="small" icon="pi pi-check" :label="t('panel.git.commit')" :loading="busy === 'commit'" :disabled="!message.trim() || !staged.length || !!busy" />
      </form>
    </template>
  </div>
</template>

<style scoped>
.git {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.pad {
  padding: 12px 14px;
}
.bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--mh-border);
}
.branch {
  min-width: 140px;
  max-width: 220px;
}
.badge {
  font-size: 11px;
  color: var(--mh-muted);
}
.grow {
  flex: 1;
}
.views {
  display: flex;
  gap: 4px;
  padding: 6px 8px 0;
}
.views button {
  border: none;
  background: none;
  padding: 4px 10px;
  border-bottom: 2px solid transparent;
  color: var(--mh-muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.views button.active {
  color: var(--mh-text);
  border-bottom-color: var(--mh-accent);
}
.scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 6px;
}
.group {
  margin: 10px 6px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--mh-muted);
}
.file {
  display: flex;
  align-items: center;
  border-radius: var(--mh-radius-sm);
}
.file:hover,
.file.active {
  background: var(--mh-hover);
}
.fname {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: none;
  padding: 4px 6px;
  cursor: pointer;
  color: var(--mh-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.code {
  width: 16px;
  text-align: center;
  font-family: var(--mh-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--mh-muted);
}
.code[data-code='M'] {
  color: #c08a1e;
}
.code[data-code='A'],
.code[data-code='U'] {
  color: #2f9e5b;
}
.code[data-code='D'] {
  color: #d64545;
}
.diff {
  margin-top: 8px;
}
.log {
  list-style: none;
  margin: 0;
  padding: 0;
}
.log li {
  padding: 6px;
  border-bottom: 1px solid var(--mh-border);
  font-size: 13px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}
.subject {
  flex: 1;
  min-width: 0;
}
.small {
  font-size: 11px;
}
.commit {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 8px;
  border-top: 1px solid var(--mh-border);
}
.msg {
  flex: 1;
}
</style>
