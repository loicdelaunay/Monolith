<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import type { PermissionScope } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';
import { store } from '../../stores/app.ts';
import DiffView from './DiffView.vue';

const { t, te } = useI18n();
const toast = useToast();
const request = computed(() => store.permissionRequests[0] ?? null);
const conversation = computed(() => (request.value ? store.conversations.get(request.value.conversationId) : null));
const showRaw = ref(false);
const prettyArgs = computed(() => {
  try {
    return JSON.stringify(JSON.parse(request.value?.arguments || '{}'), null, 2);
  } catch {
    return request.value?.arguments ?? '';
  }
});

async function respond(decision: 'allow' | 'deny', scope: PermissionScope) {
  const r = request.value;
  if (!r) return;
  store.permissionRequests.shift();
  showRaw.value = false;
  try {
    await api.call('permissions.respond', { requestId: r.requestId, decision, scope });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });
  }
}
</script>

<template>
  <Dialog :visible="request !== null" modal :closable="false" :header="t('permission.title')" :style="{ width: 'min(900px, 96vw)' }" @update:visible="(v: boolean) => !v && respond('deny', 'once')">
    <div v-if="request" class="perm">
      <p class="lead">
        <i class="pi pi-shield" />
        <span>{{ t('permission.lead', { tool: te(`tools.names.${request.tool}`) ? t(`tools.names.${request.tool}`) : request.tool }) }}</span>
      </p>
      <dl class="facts">
        <dt>{{ t('permission.action') }}</dt>
        <dd><code>{{ request.tool }}</code> — {{ request.effects.map((e) => t(`tools.effect.${e}`)).join(', ') }}</dd>
        <dt v-if="request.target">{{ t('permission.target') }}</dt>
        <dd v-if="request.target"><code>{{ request.target }}</code></dd>
        <dt>{{ t('permission.conversation') }}</dt>
        <dd>{{ conversation?.title ?? request.conversationId }}</dd>
        <dt>{{ t('permission.why') }}</dt>
        <dd class="mh-muted">{{ request.reason }}</dd>
      </dl>

      <template v-if="request.preview?.kind === 'changes'">
        <div class="mh-label">{{ t('permission.changes') }}</div>
        <DiffView v-for="c in request.preview.changes" :key="c.path" :before="c.before" :after="c.after" :path="`${c.path} (${t(`tools.change.${c.status}`)})`" />
      </template>
      <template v-else-if="request.preview?.kind === 'command'">
        <div class="mh-label">{{ t('permission.command') }} <span class="mh-hint">({{ request.preview.cwd }})</span></div>
        <pre class="raw">{{ request.preview.command }}</pre>
      </template>

      <button type="button" class="link" :aria-expanded="showRaw" @click="showRaw = !showRaw">{{ showRaw ? t('permission.hideParams') : t('permission.showParams') }}</button>
      <pre v-if="showRaw" class="raw">{{ prettyArgs }}</pre>
      <p v-if="store.permissionRequests.length > 1" class="mh-hint">{{ t('permission.more', { count: store.permissionRequests.length - 1 }) }}</p>
    </div>
    <template #footer>
      <div class="footer">
        <Button :label="t('permission.deny')" icon="pi pi-times" severity="danger" outlined @click="respond('deny', 'once')" />
        <span class="grow" />
        <Button :label="t('permission.allowGlobal')" severity="secondary" text @click="respond('allow', 'global')" />
        <Button v-if="conversation?.projectId !== null" :label="t('permission.allowProject')" severity="secondary" text @click="respond('allow', 'project')" />
        <Button :label="t('permission.allowConversation')" severity="secondary" outlined @click="respond('allow', 'conversation')" />
        <Button :label="t('permission.allowOnce')" icon="pi pi-check" autofocus @click="respond('allow', 'once')" />
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.perm {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.lead {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 0;
  font-weight: 600;
}
.lead .pi {
  color: var(--mh-warning);
  font-size: 18px;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 14px;
  margin: 0;
}
.facts dt {
  color: var(--mh-muted);
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
code,
.raw {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.raw {
  margin: 0;
  background: var(--mh-code-bg);
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
}
.link {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--mh-accent);
  cursor: pointer;
  padding: 0;
}
.footer {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  flex-wrap: wrap;
}
.grow {
  flex: 1;
}
</style>
