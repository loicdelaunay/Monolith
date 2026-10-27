<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import RadioButton from 'primevue/radiobutton';
import Checkbox from 'primevue/checkbox';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { useToast } from 'primevue/usetoast';
import type { Id, Question, QuestionAnswer, ToolCallRecord } from '@monolith/contracts';
import { api, errorMessage } from '../../api.ts';

const props = defineProps<{ call: ToolCallRecord; conversationId: Id }>();
const { t } = useI18n();
const toast = useToast();

const display = computed(() => (props.call.display?.kind === 'question' ? props.call.display : null));
const questions = computed<Question[]>(() => display.value?.questions ?? []);
const answered = computed(() => display.value?.answers ?? null);
const waiting = computed(() => props.call.status === 'running' && !answered.value && !display.value?.cancelled);

const state = reactive<Record<string, { single: string | null; multiple: string[]; text: string }>>({});
for (const q of questions.value) state[q.id] = { single: null, multiple: [], text: '' };
const index = ref(0);
const current = computed(() => questions.value[index.value]);

function complete(q: Question): boolean {
  const s = state[q.id]!;
  if (q.kind === 'text') return s.text.trim().length > 0;
  if (q.kind === 'multiple') return s.multiple.length > 0 || (!!q.allowCustom && s.text.trim().length > 0);
  return s.single !== null || (!!q.allowCustom && s.text.trim().length > 0);
}
function summary(q: Question): string {
  const s = state[q.id]!;
  const labels = (q.kind === 'multiple' ? s.multiple : s.single ? [s.single] : []).map((id) => q.options?.find((o) => o.id === id)?.label ?? id);
  return [...labels, ...(s.text.trim() ? [s.text.trim()] : [])].join(', ') || '—';
}
const allComplete = computed(() => questions.value.every(complete));

async function submit(cancel = false) {
  const answers: QuestionAnswer[] | null = cancel
    ? null
    : questions.value.map((q) => {
        const s = state[q.id]!;
        return { questionId: q.id, optionIds: q.kind === 'multiple' ? s.multiple : s.single ? [s.single] : [], text: s.text.trim() || null };
      });
  try {
    await api.call('questions.answer', { conversationId: props.conversationId, callId: props.call.id, answers });
  } catch (e) {
    toast.add({ severity: 'error', summary: errorMessage(e), life: 5000 });
  }
}

function answerLabel(q: Question): string {
  const a = answered.value?.find((x) => x.questionId === q.id);
  if (!a) return '—';
  return [...a.optionIds.map((id) => q.options?.find((o) => o.id === id)?.label ?? id), ...(a.text ? [a.text] : [])].join(', ') || '—';
}
</script>

<template>
  <div class="qcard">
    <!-- Réponses déjà données : récapitulatif. -->
    <template v-if="!waiting">
      <p v-if="display?.cancelled" class="mh-hint">{{ t('questions.cancelled') }}</p>
      <dl v-else class="recap">
        <template v-for="q in questions" :key="q.id"><dt>{{ q.prompt }}</dt><dd>{{ answerLabel(q) }}</dd></template>
      </dl>
    </template>

    <template v-else-if="current">
      <!-- Plusieurs questions : accordéon récapitulatif. -->
      <ol v-if="questions.length > 1" class="steps">
        <li v-for="(q, i) in questions" :key="q.id" :class="{ active: i === index, done: complete(q) }">
          <button type="button" @click="index = i">
            <span class="num">{{ i + 1 }}</span>
            <span class="q">{{ q.prompt }}</span>
            <span v-if="i !== index && complete(q)" class="mh-hint ans">{{ summary(q) }}</span>
          </button>
        </li>
      </ol>

      <fieldset class="question">
        <legend>{{ current.prompt }}</legend>
        <p v-if="current.kind === 'multiple'" class="mh-hint">{{ t('questions.multiple') }}</p>
        <div v-if="current.options?.length" class="tiles" :role="current.kind === 'multiple' ? 'group' : 'radiogroup'">
          <label v-for="o in current.options" :key="o.id" class="tile" :class="{ selected: current.kind === 'multiple' ? state[current.id]!.multiple.includes(o.id) : state[current.id]!.single === o.id }">
            <Checkbox v-if="current.kind === 'multiple'" v-model="state[current.id]!.multiple" :value="o.id" :input-id="`${call.id}-${o.id}`" />
            <RadioButton v-else v-model="state[current.id]!.single" :value="o.id" :input-id="`${call.id}-${o.id}`" :name="`${call.id}-${current.id}`" />
            <i v-if="o.icon" class="pi" :class="`pi-${o.icon}`" aria-hidden="true" />
            <span class="tile-text">
              <span class="tile-label">{{ o.label }}</span>
              <span v-if="o.description" class="mh-hint">{{ o.description }}</span>
            </span>
          </label>
        </div>
        <Textarea v-if="current.kind === 'text'" v-model="state[current.id]!.text" rows="3" auto-resize fluid :aria-label="current.prompt" />
        <InputText v-else-if="current.allowCustom" v-model="state[current.id]!.text" :placeholder="t('questions.custom')" fluid :aria-label="t('questions.custom')" />
      </fieldset>

      <div class="actions">
        <Button :label="t('questions.cancel')" severity="secondary" text size="small" @click="submit(true)" />
        <span class="grow" />
        <Button v-if="questions.length > 1" :label="t('questions.previous')" icon="pi pi-angle-left" severity="secondary" outlined size="small" :disabled="index === 0" @click="index--" />
        <Button v-if="index < questions.length - 1" :label="t('questions.next')" icon="pi pi-angle-right" icon-pos="right" size="small" severity="secondary" :disabled="!complete(current)" @click="index++" />
        <Button v-else :label="t('questions.submit')" icon="pi pi-check" size="small" :disabled="!allComplete" @click="submit()" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.qcard {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.steps button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.steps li.active button {
  background: color-mix(in srgb, var(--mh-accent) 12%, transparent);
}
.num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--mh-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  flex: none;
}
.steps li.done .num {
  background: var(--mh-accent);
  color: var(--mh-accent-text);
  border-color: var(--mh-accent);
}
.q {
  flex: 1;
  min-width: 0;
}
.ans {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.question {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.question legend {
  font-weight: 600;
  margin-bottom: 6px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
}
.tile {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  background: var(--mh-surface);
  cursor: pointer;
}
.tile.selected {
  border-color: var(--mh-accent);
  background: color-mix(in srgb, var(--mh-accent) 10%, var(--mh-surface));
}
.tile-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tile-label {
  font-weight: 550;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grow {
  flex: 1;
}
.recap {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;
}
.recap dt {
  color: var(--mh-muted);
}
.recap dd {
  margin: 0;
  font-weight: 550;
}
</style>
