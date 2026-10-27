<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { APP_VERSION, type CapabilityId } from '@monolith/contracts';
import { store } from '../../stores/app.ts';
import { uiState } from '../../ui-state.ts';
import logo from '../../assets/logo.png';

const { t } = useI18n();
const caps = computed(() => (store.info ? (Object.entries(store.info.capabilities) as [CapabilityId, (typeof store.info.capabilities)[CapabilityId]][]) : []));
const severity = (state: string) => (state === 'available' ? 'success' : state === 'planned' ? 'secondary' : 'warn');
</script>

<template>
  <div class="head">
    <img :src="logo" alt="" width="56" height="56" />
    <div>
      <div class="name">Monolith Harness</div>
      <div class="mh-muted">{{ t('settings.about.version') }} {{ APP_VERSION }}</div>
    </div>
    <Button :label="t('settings.about.changelog')" icon="pi pi-list" size="small" severity="secondary" outlined class="push" @click="uiState.changelogOpen = true" />
  </div>
  <p>{{ t('settings.about.license') }}</p>
  <p class="mh-hint">{{ t('settings.about.network') }}</p>

  <dl v-if="store.info" class="facts">
    <dt>{{ t('settings.about.data') }}</dt>
    <dd><code>{{ store.info.dataDir }}</code></dd>
    <dt>{{ t('settings.about.database') }}</dt>
    <dd><code>{{ store.info.databasePath }}</code> — {{ t('settings.about.schema', { version: store.info.schemaVersion }) }}</dd>
    <dt>{{ t('settings.about.runtime') }}</dt>
    <dd>{{ store.info.platform }} {{ store.info.arch }} · Node {{ store.info.nodeVersion }} · SQLite {{ store.info.sqliteVersion }}</dd>
  </dl>

  <h3 class="mh-section-title">{{ t('settings.about.capabilities') }}</h3>
  <table class="caps">
    <tbody>
      <tr v-for="[id, cap] in caps" :key="id">
        <td><code>{{ id }}</code></td>
        <td><Tag :severity="severity(cap.state)" :value="t(`settings.about.states.${cap.state}`)" /></td>
        <td class="mh-muted">{{ cap.backend ? `${cap.backend} — ` : '' }}{{ cap.reason ?? '' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
}
.head img {
  border-radius: 12px;
}
.name {
  font-size: 18px;
  font-weight: 650;
}
.push {
  margin-left: auto;
}
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 16px 0;
}
.facts dt {
  font-weight: 600;
}
.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
code {
  font-family: var(--mh-font-mono);
  font-size: 12.5px;
}
.caps {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
.caps td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--mh-border);
  vertical-align: top;
}
</style>
