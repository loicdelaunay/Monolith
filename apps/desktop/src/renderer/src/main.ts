import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import Tooltip from 'primevue/tooltip';
import Aura from '@primeuix/themes/aura';
import { definePreset, palette } from '@primeuix/themes';
import { messages } from '@monolith/contracts';
import 'primeicons/primeicons.css';
import './styles/base.css';
import './styles/markdown.css';
import App from './App.vue';

const preset = definePreset(Aura, {
  semantic: {
    primary: palette('#5b5bd6'),
    focusRing: { width: '2px', style: 'solid', color: '{primary.color}', offset: '2px' },
  },
});

// Les messages vue-i18n utilisent `{nom}` : même syntaxe que le traducteur du moteur et du CLI.
export const i18n = createI18n({
  legacy: false,
  locale: 'fr',
  fallbackLocale: 'fr',
  messages: messages as never,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
});

createApp(App)
  .use(i18n)
  .use(PrimeVue, {
    ripple: false,
    theme: {
      preset,
      options: { darkModeSelector: '.mh-dark', cssLayer: { name: 'primevue', order: 'primevue' } },
    },
  })
  .use(ToastService)
  .use(ConfirmationService)
  .directive('tooltip', Tooltip)
  .mount('#app');
