<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ProgressSpinner from 'primevue/progressspinner';
import type { Conversation } from '@monolith/contracts';
import { attentionOf, progressing } from '../stores/app.ts';

/**
 * État dans la barre latérale, pour une conversation ou un groupe de sous-agents : le cercle tant que
 * le modèle avance, l'exclamation quand une action attend l'utilisateur, les deux si le modèle continue
 * malgré cette attente (propositions à traiter, sous-agent bloqué pendant que d'autres travaillent).
 */
const props = defineProps<{ conversations: Conversation[] }>();
const { t } = useI18n();
const attention = computed(() => props.conversations.map((c) => attentionOf(c.id)).find((a) => a) ?? null);
const working = computed(() => props.conversations.some((c) => progressing(c.id)));
</script>

<template>
  <span v-if="working || attention" class="status">
    <ProgressSpinner v-if="working" class="spin" stroke-width="6" :aria-label="t('conversation.generating')" />
    <i v-if="attention" class="pi pi-exclamation-circle attention" role="img" :aria-label="t(`conversation.attention.${attention}`)" v-tooltip.top="t(`conversation.attention.${attention}`)" />
  </span>
</template>

<style scoped>
.status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.attention {
  color: #f97316;
  font-size: 14px;
  font-weight: 700;
}
.spin {
  width: 14px !important;
  height: 14px !important;
  margin: 0;
}
</style>
