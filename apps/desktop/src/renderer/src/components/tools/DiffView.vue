<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import { diffAsync, type DiffBlock } from '../../lib/diff.ts';

const props = defineProps<{ before: string; after: string; path?: string }>();
const { t } = useI18n();
const blocks = ref<DiffBlock[] | null>(null);
const CONTEXT = 3;

watch(
  () => [props.before, props.after],
  async () => {
    blocks.value = null;
    blocks.value = await diffAsync(props.before, props.after);
  },
  { immediate: true },
);

/** Les longues zones inchangées sont réduites à quelques lignes de contexte. */
const view = computed(() =>
  (blocks.value ?? []).map((b, i, all) => {
    if (b.kind !== 'equal' || b.lines.length <= CONTEXT * 2 + 1) return { block: b, skipped: 0, head: b.kind === 'equal' ? b.lines : [], tail: [] as string[] };
    const first = i === 0;
    const last = i === all.length - 1;
    const head = first ? [] : b.lines.slice(0, CONTEXT);
    const tail = last ? [] : b.lines.slice(-CONTEXT);
    return { block: b, skipped: b.lines.length - head.length - tail.length, head, tail };
  }),
);
const stats = computed(() => {
  let add = 0;
  let del = 0;
  for (const b of blocks.value ?? []) {
    if (b.kind === 'add') add += b.lines.length;
    else if (b.kind === 'remove') del += b.lines.length;
    else if (b.kind === 'replace') {
      add += b.after.length;
      del += b.before.length;
    }
  }
  return { add, del };
});
</script>

<template>
  <div class="diff">
    <div class="diff-head">
      <span v-if="path" class="path">{{ path }}</span>
      <span class="add">+{{ stats.add }}</span>
      <span class="del">−{{ stats.del }}</span>
    </div>
    <div v-if="!blocks" class="loading"><ProgressSpinner style="width: 16px; height: 16px" stroke-width="6" /> {{ t('tools.computingDiff') }}</div>
    <div v-else class="diff-body" role="table" :aria-label="t('tools.diff')">
      <template v-for="(v, i) in view" :key="i">
        <template v-if="v.block.kind === 'equal'">
          <div v-for="(l, j) in v.head" :key="`h${j}`" class="row eq"><span class="n">{{ v.block.oldStart + j }}</span><span class="n">{{ v.block.newStart + j }}</span><span class="s"> </span><code>{{ l }}</code></div>
          <div v-if="v.skipped" class="row skip"><span class="n">⋯</span><span class="n">⋯</span><span class="s" /><code>{{ t('tools.unchangedLines', { count: v.skipped }) }}</code></div>
          <div v-for="(l, j) in v.tail" :key="`t${j}`" class="row eq">
            <span class="n">{{ v.block.oldStart + v.block.lines.length - v.tail.length + j }}</span><span class="n">{{ v.block.newStart + v.block.lines.length - v.tail.length + j }}</span><span class="s"> </span><code>{{ l }}</code>
          </div>
        </template>
        <template v-else-if="v.block.kind === 'remove'">
          <div v-for="(l, j) in v.block.lines" :key="j" class="row del"><span class="n">{{ v.block.oldStart + j }}</span><span class="n" /><span class="s">−</span><code>{{ l }}</code></div>
        </template>
        <template v-else-if="v.block.kind === 'add'">
          <div v-for="(l, j) in v.block.lines" :key="j" class="row add"><span class="n" /><span class="n">{{ v.block.newStart + j }}</span><span class="s">+</span><code>{{ l }}</code></div>
        </template>
        <div v-else class="replace" :title="t('tools.replaced')">
          <div v-for="(l, j) in v.block.before" :key="`b${j}`" class="row rep-old"><span class="n">{{ v.block.oldStart + j }}</span><span class="n" /><span class="s">~</span><code>{{ l }}</code></div>
          <div v-for="(l, j) in v.block.after" :key="`a${j}`" class="row rep-new"><span class="n" /><span class="n">{{ v.block.newStart + j }}</span><span class="s">~</span><code>{{ l }}</code></div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff {
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius-sm);
  overflow: hidden;
  font-size: 12px;
}
.diff-head {
  display: flex;
  gap: 10px;
  padding: 4px 10px;
  background: var(--mh-code-bg);
  border-bottom: 1px solid var(--mh-border);
}
.path {
  font-family: var(--mh-font-mono);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.add {
  color: var(--mh-success);
}
.del {
  color: var(--mh-danger);
}
.loading {
  padding: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--mh-muted);
}
.diff-body {
  max-height: 420px;
  overflow: auto;
  font-family: var(--mh-font-mono);
}
.row {
  display: grid;
  grid-template-columns: 3.4em 3.4em 1.4em 1fr;
  line-height: 1.5;
  white-space: pre;
  min-width: max-content;
}
.row code {
  font-family: inherit;
  padding-right: 10px;
}
.n {
  text-align: right;
  padding-right: 6px;
  color: var(--mh-muted);
  opacity: 0.7;
  user-select: none;
}
.s {
  text-align: center;
  user-select: none;
}
.del {
  background: color-mix(in srgb, var(--mh-danger) 14%, transparent);
}
.row.add {
  background: color-mix(in srgb, var(--mh-success) 14%, transparent);
}
.row.del .s {
  color: var(--mh-danger);
}
.row.add .s {
  color: var(--mh-success);
}
.replace {
  border-left: 3px solid #e08a1e;
}
.rep-old {
  background: color-mix(in srgb, #e08a1e 12%, transparent);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, #e08a1e 60%, transparent);
}
.rep-new {
  background: color-mix(in srgb, #e08a1e 20%, transparent);
}
.skip {
  color: var(--mh-muted);
  font-style: italic;
  background: var(--mh-code-bg);
}
</style>
