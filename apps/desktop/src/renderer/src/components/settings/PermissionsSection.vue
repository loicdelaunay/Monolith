<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import RadioButton from 'primevue/radiobutton';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { useToast } from 'primevue/usetoast';
import type { PermissionDecisionLog, PermissionRule, Settings } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';

defineProps<{ draft: Settings }>();
const { t } = useI18n();
const toast = useToast();
const rules = ref<PermissionRule[]>([]);
const history = ref<PermissionDecisionLog[]>([]);
const form = reactive({ scope: 'global' as 'global' | 'project', projectId: null as number | null, tool: '*', family: '*', resource: '', decision: 'allow' as 'allow' | 'deny' | 'ask' });

async function load() {
  [rules.value, history.value] = await Promise.all([api.call('permissions.rules', {}), api.call('permissions.history', { limit: 100 })]);
}
onMounted(load);
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

async function addRule() {
  try {
    await api.call('permissions.addRule', { scope: form.scope, projectId: form.scope === 'project' ? form.projectId : null, conversationId: null, tool: form.tool || '*', family: form.family || '*', resource: form.resource, decision: form.decision });
    form.resource = '';
    await load();
  } catch (e) {
    fail(e);
  }
}
async function removeRule(id: number) {
  await api.call('permissions.removeRule', { id }).catch(fail);
  await load();
}
const projectName = (id: number | null) => store.projects.find((p) => p.id === id)?.name ?? '?';
const severity = (d: string) => (d === 'allow' ? 'success' : d === 'deny' ? 'danger' : 'warn');
</script>

<template>
  <fieldset class="mh-field plain">
    <legend class="mh-label">{{ t('permissionsSettings.policy') }}</legend>
    <div v-for="p in ['deny_all', 'ask', 'rules'] as const" :key="p" class="radio">
      <RadioButton v-model="draft.permissions.policy" :input-id="`pol-${p}`" :value="p" />
      <label :for="`pol-${p}`">
        <strong>{{ t(`permissionsSettings.policies.${p}`) }}</strong>
        <span class="mh-hint"> — {{ t(`permissionsSettings.policyHints.${p}`) }}</span>
      </label>
    </div>
  </fieldset>

  <div class="mh-row between">
    <h3 class="mh-section-title">{{ t('permissionsSettings.rules') }}</h3>
    <span class="mh-badge-immediate"><i class="pi pi-bolt" />{{ t('common.immediate') }}</span>
  </div>
  <p class="mh-hint">{{ t('permissionsSettings.rulesHint') }}</p>
  <table class="rules">
    <thead>
      <tr><th>{{ t('permissionsSettings.decision') }}</th><th>{{ t('permissionsSettings.scope') }}</th><th>{{ t('permissionsSettings.tool') }}</th><th>{{ t('permissionsSettings.family') }}</th><th>{{ t('permissionsSettings.resource') }}</th><th /></tr>
    </thead>
    <tbody>
      <tr v-for="r in rules" :key="r.id">
        <td><Tag :severity="severity(r.decision)" :value="t(`permissionsSettings.decisions.${r.decision}`)" /></td>
        <td>{{ r.scope === 'project' ? `${t('permissionsSettings.scopes.project')} « ${projectName(r.projectId)} »` : t(`permissionsSettings.scopes.${r.scope}`) }}</td>
        <td><code>{{ r.tool }}</code></td>
        <td><code>{{ r.family }}</code></td>
        <td><code>{{ r.resource || '*' }}</code></td>
        <td><button type="button" class="mh-icon-btn" :aria-label="t('common.delete')" @click="removeRule(r.id)"><i class="pi pi-trash" /></button></td>
      </tr>
      <tr v-if="rules.length === 0"><td colspan="6" class="mh-hint">{{ t('permissionsSettings.noRules') }}</td></tr>
    </tbody>
  </table>
  <div class="add">
    <Select v-model="form.decision" :options="['allow', 'ask', 'deny']" :option-label="(d: string) => t(`permissionsSettings.decisions.${d}`)" :aria-label="t('permissionsSettings.decision')" size="small" />
    <Select v-model="form.scope" :options="['global', 'project']" :option-label="(d: string) => t(`permissionsSettings.scopes.${d}`)" :aria-label="t('permissionsSettings.scope')" size="small" />
    <Select v-if="form.scope === 'project'" v-model="form.projectId" :options="store.projects" option-label="name" option-value="id" :placeholder="t('project.name')" size="small" />
    <InputText v-model="form.tool" :placeholder="t('permissionsSettings.tool')" size="small" class="w" />
    <InputText v-model="form.family" :placeholder="t('permissionsSettings.family')" size="small" class="w" />
    <InputText v-model="form.resource" :placeholder="t('permissionsSettings.resourcePlaceholder')" size="small" class="w2" />
    <Button :label="t('common.add')" icon="pi pi-plus" size="small" :disabled="form.scope === 'project' && form.projectId === null" @click="addRule" />
  </div>

  <h3 class="mh-section-title">{{ t('permissionsSettings.history') }}</h3>
  <table class="rules">
    <tbody>
      <tr v-for="h in history" :key="h.id">
        <td class="mh-hint">{{ new Date(h.createdAt).toLocaleString() }}</td>
        <td><Tag :severity="severity(h.decision)" :value="t(`permissionsSettings.decisions.${h.decision}`)" /></td>
        <td><code>{{ h.tool }}</code></td>
        <td class="target"><code>{{ h.target ?? '' }}</code></td>
        <td class="mh-hint">{{ t(`tools.sources.${h.source}`) }}{{ h.scope ? ` · ${t(`tools.scopes.${h.scope}`)}` : '' }}</td>
      </tr>
      <tr v-if="history.length === 0"><td class="mh-hint">{{ t('permissionsSettings.noHistory') }}</td></tr>
    </tbody>
  </table>
</template>

<style scoped>
.plain {
  border: 0;
  padding: 0;
  margin: 0 0 18px;
}
.radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
}
.rules {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  margin-bottom: 10px;
}
.rules th {
  text-align: left;
  color: var(--mh-muted);
  font-weight: 600;
  padding: 4px 6px;
}
.rules td {
  padding: 4px 6px;
  border-top: 1px solid var(--mh-border);
}
.target code {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
code {
  font-family: var(--mh-font-mono);
}
.add {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.w {
  width: 120px;
}
.w2 {
  width: 200px;
}
</style>
