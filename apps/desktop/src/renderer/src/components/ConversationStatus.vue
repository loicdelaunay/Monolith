<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import type { Conversation } from '@monolith/contracts';
import { attentionOf } from '../stores/app.ts';

/** État dans la barre latérale : une action attendue de l'utilisateur passe avant la génération en cours. */
const props = defineProps<{ conversation: Conversation }>();
const { t } = useI18n();
const attention = computed(() => attentionOf(props.conversation.id));
</script>

<template>
  <i v-if="attention" class="pi pi-exclamation-circle attention" role="img" :aria-label="t(`conversation.attention.${attention}`)" v-tooltip.top="t(`conversation.attention.${attention}`)" />
  <ProgressSpinner v-else-if="conversation.generating" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
</template>

<style scoped>
.attention {
  flex: none;
  margin-left: auto;
  color: #f97316;
  font-size: 14px;
  font-weight: 700;
}
.spin {
  flex: none;
  width: 14px !important;
  height: 14px !important;
  margin: 0 0 0 auto;
}
</style>
