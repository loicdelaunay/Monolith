<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirm } from 'primevue/useconfirm';
import { useToast } from 'primevue/usetoast';
import { api, errorMessage, host } from '../api.ts';
import { store } from '../stores/app.ts';

/**
 * Mise à jour disponible (comme Discord) : petit bouton vert avec une flèche, en haut à droite.
 * Un clic télécharge la mise à jour, vérifiée par son empreinte, puis redémarre Monolith pour l'installer ;
 * si l'installation automatique n'est pas possible (installateur, développement), ouvre la page de la version.
 */
const { t } = useI18n();
const confirm = useConfirm();
const toast = useToast();

const u = computed(() => store.update);
const visible = computed(() => !!u.value?.release && ['available', 'downloading', 'ready', 'installing'].includes(u.value.status));
const version = computed(() => u.value?.release?.version ?? '');
const percent = computed(() => Math.round((u.value?.progress ?? 0) * 100));
const label = computed(() => {
  const s = u.value;
  if (!s?.release) return '';
  if (s.status === 'downloading') return t('update.downloading', { version: version.value, percent: percent.value });
  if (s.status === 'installing') return t('update.installing', { version: version.value });
  if (!s.installable) return t('update.openPage', { version: version.value });
  return s.status === 'ready' ? t('update.ready', { version: version.value }) : t('update.available', { version: version.value });
});

/** Téléchargement lancé depuis ce bouton : l'installation suit dès que le paquet est vérifié. */
const installAfterDownload = ref(false);
watch(
  () => u.value?.status,
  (status) => {
    if (status === 'ready' && installAfterDownload.value) {
      installAfterDownload.value = false;
      install();
    } else if (status === 'error') installAfterDownload.value = false;
  },
);

async function click() {
  const s = u.value;
  if (!s?.release || s.status === 'downloading' || s.status === 'installing') return;
  if (!s.installable) return void host.openExternal(s.release.url);
  if (s.status === 'ready') return install();
  installAfterDownload.value = true;
  await api.call('updates.download').catch((e) => {
    installAfterDownload.value = false;
    toast.add({ severity: 'error', summary: t('update.failed'), detail: errorMessage(e), life: 7000 });
  });
}

function install() {
  const run = () => void api.call('updates.install').catch((e) => toast.add({ severity: 'error', summary: t('update.failed'), detail: errorMessage(e), life: 7000 }));
  // Une génération en cours serait interrompue par le redémarrage : confirmation dans ce cas seulement.
  if (!store.generations.size) return run();
  confirm.require({
    header: t('update.confirmTitle', { version: version.value }),
    message: t('update.confirmBusy'),
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('update.restart') },
    accept: run,
  });
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="mh-update"
    :class="u?.status"
    :style="u?.status === 'downloading' ? { '--p': `${percent}%` } : undefined"
    :aria-label="label"
    :disabled="u?.status === 'installing'"
    v-tooltip.bottom="label"
    @click="click"
  >
    <i class="pi" :class="u?.status === 'installing' ? 'pi-spin pi-spinner' : 'pi-download'" />
  </button>
</template>

<style scoped>
.mh-update {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: #23a55a;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 0 0 0 rgb(35 165 90 / 0.5);
  animation: mh-update-pulse 2.4s ease-out 3;
  -webkit-app-region: no-drag;
}
.mh-update:hover {
  background: #1f9150;
}
.mh-update .pi {
  font-size: 12px;
  font-weight: 700;
}
/* Téléchargement : anneau de progression autour du bouton. */
.mh-update.downloading {
  background: conic-gradient(#23a55a var(--p, 0%), color-mix(in srgb, #23a55a 25%, transparent) 0);
  cursor: progress;
}
.mh-update.installing {
  cursor: progress;
}
@keyframes mh-update-pulse {
  70% {
    box-shadow: 0 0 0 8px rgb(35 165 90 / 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgb(35 165 90 / 0);
  }
}
</style>
