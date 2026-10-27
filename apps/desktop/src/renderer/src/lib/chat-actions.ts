import type { ToastServiceMethods } from 'primevue/toastservice';
import type { Id } from '@monolith/contracts';
import { api, errorMessage, host } from '../api.ts';
import { i18n } from '../i18n.ts';
import { openConversation, store } from '../stores/app.ts';

const translator = i18n.global as unknown as { t: (key: string, params: Record<string, unknown>) => string };
const t = (key: string, params?: Record<string, unknown>) => translator.t(key, params ?? {});

/**
 * Actions de conversation partagées par les menus, l'en-tête, les messages et les commandes « / ».
 * Le moteur applique les règles ; ces fonctions gèrent seulement l'interface (navigation, messages).
 */
export function chatActions(toast: ToastServiceMethods) {
  const fail = (e: unknown) => toast.add({ severity: 'error', summary: t('errors.internal'), detail: errorMessage(e), life: 7000 });

  return {
    async fork(id: Id, messageId: Id | null = null) {
      try {
        const copy = await api.call('conversations.fork', { id, messageId });
        store.conversations.set(copy.id, copy);
        await openConversation(copy.id);
        toast.add({ severity: 'success', summary: messageId === null ? t('actions.duplicated') : t('actions.forked'), life: 3000 });
      } catch (e) {
        fail(e);
      }
    },

    /** Retourne le texte et les pièces jointes à replacer dans l'éditeur. */
    async resumeFrom(id: Id, messageId: Id) {
      try {
        const r = await api.call('conversations.resumeFrom', { id, messageId });
        const backup = await api.call('conversations.get', { id: r.backupConversationId });
        store.conversations.set(backup.id, backup);
        toast.add({ severity: 'info', summary: t('actions.resumed'), detail: t('actions.resumedDetail', { title: backup.title }), life: 7000 });
        return r;
      } catch (e) {
        fail(e);
        return null;
      }
    },

    async exportMarkdown(id: Id, includeReasoning: boolean) {
      try {
        const { fileName, markdown } = await api.call('conversations.exportMarkdown', { id, includeReasoning });
        const path = await host.saveTextFile(fileName, markdown, [{ name: 'Markdown', extensions: ['md'] }]);
        if (path) toast.add({ severity: 'success', summary: t('actions.exported'), detail: path, life: 5000 });
      } catch (e) {
        fail(e);
      }
    },

    async compact(id: Id) {
      try {
        toast.add({ severity: 'info', summary: t('actions.compacting'), life: 2500 });
        const c = await api.call('conversations.compact', { id });
        toast.add({ severity: 'success', summary: t('actions.compacted'), detail: t('actions.compactedDetail', { count: c.upToSeq }), life: 5000 });
      } catch (e) {
        fail(e);
      }
    },
  };
}
