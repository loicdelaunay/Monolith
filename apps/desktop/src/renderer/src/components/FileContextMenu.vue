<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ContextMenu from 'primevue/contextmenu';
import { useToast } from 'primevue/usetoast';
import type { MenuItem } from 'primevue/menuitem';
import { api, errorMessage, host } from '../api.ts';
import { uiState } from '../ui-state.ts';
import { fileMenu } from '../lib/file-menu.ts';
import { isExecutable } from '../lib/file-icons.ts';

/** Menu contextuel des fichiers cités dans le chat (badges, cartes d'outils), comme la v1. */
const { t } = useI18n();
const toast = useToast();
const menu = ref<InstanceType<typeof ContextMenu> | null>(null);
const items = ref<MenuItem[]>([]);

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  toast.add({ severity: 'success', summary: t('fileMenu.copied'), life: 1500 });
}

fileMenu.show = (event, target) => {
  const dir = target.type === 'directory';
  const name = target.path.split(/[\\/]/).pop() ?? target.path;
  items.value = [
    { label: name, icon: dir ? 'pi pi-folder' : 'pi pi-file', disabled: true },
    { separator: true },
    ...(dir
      ? []
      : [
          {
            label: t('fileMenu.preview'),
            icon: 'pi pi-eye',
            command: () => {
              uiState.preview = { conversationId: target.conversationId, path: target.path, line: target.line ?? null };
              void api.call('settings.update', { layout: { panelOpen: true, panelTab: 'preview' } });
            },
          },
        ]),
    {
      label: dir ? t('fileMenu.openFolder') : t('fileMenu.open'),
      icon: 'pi pi-external-link',
      disabled: !dir && isExecutable(target.path),
      command: () =>
        void host
          .openPath(target.path)
          .then((err) => err && toast.add({ severity: 'warn', summary: t('fileMenu.openFailed'), detail: err, life: 6000 }))
          .catch((e) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 })),
    },
    { label: t('fileMenu.reveal'), icon: 'pi pi-folder-open', command: () => void host.showItemInFolder(target.path) },
    { separator: true },
    { label: t('fileMenu.copyPath'), icon: 'pi pi-copy', command: () => void copy(target.path) },
    { label: t('fileMenu.copyName'), icon: 'pi pi-copy', command: () => void copy(name) },
  ];
  menu.value?.show(event);
};
</script>

<template>
  <ContextMenu ref="menu" :model="items" />
</template>
