import { createI18n } from 'vue-i18n';
import { messages } from '@monolith/contracts';

// Les messages vue-i18n utilisent `{nom}` : même syntaxe que le traducteur du moteur et du CLI.
export const i18n = createI18n({
  legacy: false,
  locale: 'fr',
  fallbackLocale: 'fr',
  messages: messages as never,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
});
