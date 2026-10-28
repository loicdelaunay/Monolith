<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AttachmentRef } from '@monolith/contracts';
import { formatSize, previewUrl } from '../lib/attachments.ts';
import { fileIcon } from '../lib/file-icons.ts';

const props = defineProps<{ attachment: AttachmentRef; removable?: boolean; large?: boolean }>();
defineEmits<{ remove: [] }>();
const { t } = useI18n();
const src = ref<string | null>(null);
const icon = computed(() => fileIcon(props.attachment.name, props.attachment.kind === 'folder' ? 'directory' : 'file'));

onMounted(async () => {
  if (props.attachment.kind === 'image') src.value = await previewUrl(props.attachment.id).catch(() => null);
});
</script>

<template>
  <span class="chip" :class="{ large, image: attachment.kind === 'image' }" :title="`${attachment.name} — ${attachment.mime}, ${formatSize(attachment.size)}`">
    <img v-if="src" :src="src" :alt="attachment.name" />
    <i v-else class="pi" :class="icon.icon" :style="{ color: icon.color }" aria-hidden="true" />
    <span class="name">{{ attachment.name }}</span>
    <span class="size">{{ formatSize(attachment.size) }}</span>
    <button v-if="removable" type="button" class="remove" :aria-label="t('composer.removeAttachment', { name: attachment.name })" @click="$emit('remove')"><i class="pi pi-times" /></button>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 3px 6px 3px 4px;
  border: 1px solid var(--mh-border);
  border-radius: 8px;
  background: var(--mh-tool-bubble);
  font-size: 12.5px;
}
.chip img {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: 5px;
  flex: none;
}
.chip.large.image {
  flex-direction: column;
  align-items: flex-start;
  max-width: 220px;
  padding: 4px;
}
.chip.large img {
  width: 200px;
  height: auto;
  max-height: 200px;
  object-fit: contain;
  background: var(--mh-code-bg);
}
.chip > .pi {
  color: var(--mh-muted);
  padding: 0 4px;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.size {
  color: var(--mh-muted);
  font-size: 11px;
  flex: none;
}
.remove {
  border: 0;
  background: transparent;
  color: var(--mh-muted);
  cursor: pointer;
  border-radius: 5px;
  width: 20px;
  height: 20px;
  flex: none;
}
.remove:hover {
  background: var(--mh-hover);
  color: var(--mh-text);
}
</style>
