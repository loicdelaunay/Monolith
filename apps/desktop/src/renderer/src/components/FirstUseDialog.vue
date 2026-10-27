<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import type { Id } from '@monolith/contracts';
import { store } from '../stores/app.ts';
import { finishFirstUse, firstUse } from '../lib/first-use.ts';
import LocalAiInstall from './LocalAiInstall.vue';

/**
 * Demande de première utilisation (comme la v1) : télécharger et utiliser le modèle local
 * (LANCET Nano pour le mode Automatique, MiniLM multilingue pour le RAG), utiliser un modèle
 * d'une connexion, ou annuler.
 */
const { t } = useI18n();
const visible = computed(() => firstUse.kind !== null);
const kind = computed(() => firstUse.kind ?? 'validator');
const key = computed(() => (kind.value === 'validator' ? 'firstUse.validator' : 'firstUse.rag'));

const providerId = ref<Id | null>(null);
const model = ref<string>('');
watch(visible, (v) => {
  if (!v) return;
  providerId.value = null;
  model.value = '';
});
// Validateur : modèle de chat d'une connexion (pas d'agent externe) ; RAG : connexion compatible OpenAI (/embeddings).
const providers = computed(() => store.providers.filter((p) => p.enabled && (kind.value === 'validator' ? p.kind !== 'acp' : p.kind === 'openai-compatible')).map((p) => ({ label: p.name, value: p.id })));
const models = computed(() => (store.providers.find((p) => p.id === providerId.value)?.models ?? []).filter((m) => m.enabled).map((m) => ({ label: m.label, value: m.id })));
watch(providerId, () => (model.value = kind.value === 'validator' ? (models.value[0]?.value ?? '') : ''));
const canUseModel = computed(() => providerId.value !== null && model.value.trim().length > 0);

function useLocal() {
  finishFirstUse(kind.value === 'validator' ? { permissions: { validator: 'lancet' } } : { rag: { embeddingSource: 'local' } });
}
function useModel() {
  if (!canUseModel.value) return;
  finishFirstUse(
    kind.value === 'validator'
      ? { permissions: { validator: 'model', validatorProviderId: providerId.value, validatorModel: model.value.trim() } }
      : { rag: { embeddingSource: 'provider', embeddingProviderId: providerId.value, embeddingModel: model.value.trim() } },
  );
}
</script>

<template>
  <Dialog :visible="visible" modal :header="t(`${key}.title`)" :style="{ width: 'min(640px, 94vw)' }" :closable="true" @update:visible="(v: boolean) => !v && finishFirstUse(null)">
    <p class="intro">{{ t(`${key}.intro`) }}</p>

    <section class="choice">
      <h4><i class="pi pi-download" /> {{ t(`${key}.localTitle`) }}</h4>
      <p class="mh-hint">{{ t(`${key}.localHint`) }}</p>
      <LocalAiInstall :component="kind === 'validator' ? 'lancet' : 'minilm'" :use-label="t(`${key}.useLocal`)" @installed="useLocal" @use="useLocal" />
    </section>

    <section class="choice">
      <h4><i class="pi pi-server" /> {{ t(`${key}.modelTitle`) }}</h4>
      <p class="mh-hint">{{ t(`${key}.modelHint`) }}</p>
      <div v-if="providers.length" class="mh-row wrap">
        <div class="mh-field">
          <label for="fu-prov">{{ t('firstUse.provider') }}</label>
          <Select input-id="fu-prov" v-model="providerId" :options="providers" option-label="label" option-value="value" :placeholder="t('firstUse.chooseProvider')" :aria-label="t('firstUse.provider')" class="pick" />
        </div>
        <div v-if="providerId !== null" class="mh-field">
          <label for="fu-model">{{ t('firstUse.model') }}</label>
          <Select v-if="kind === 'validator'" input-id="fu-model" v-model="model" :options="models" option-label="label" option-value="value" :aria-label="t('firstUse.model')" class="pick" />
          <InputText v-else id="fu-model" v-model="model" placeholder="text-embedding-3-small" />
        </div>
        <Button :label="t('firstUse.useModel')" icon="pi pi-check" size="small" :disabled="!canUseModel" class="go" @click="useModel" />
      </div>
      <p v-else class="mh-hint warn">{{ t(`${key}.noProvider`) }}</p>
    </section>

    <template #footer>
      <Button :label="t('common.cancel')" severity="secondary" outlined @click="finishFirstUse(null)" />
    </template>
  </Dialog>
</template>

<style scoped>
.intro {
  margin: 0 0 12px;
}
.choice {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  padding: 12px 14px;
  margin-bottom: 12px;
}
.choice h4 {
  margin: 0 0 4px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.choice h4 .pi {
  color: var(--mh-accent);
}
.choice .mh-hint {
  margin: 0 0 10px;
}
.wrap {
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}
.pick {
  min-width: 200px;
}
.warn {
  color: var(--mh-warning);
}
</style>
