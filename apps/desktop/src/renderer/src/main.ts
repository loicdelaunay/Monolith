import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import Tooltip from 'primevue/tooltip';
import Aura from '@primeuix/themes/aura';
import { definePreset, palette } from '@primeuix/themes';
import 'primeicons/primeicons.css';
import './styles/base.css';
import './styles/markdown.css';
import App from './App.vue';
import { i18n } from './i18n.ts';

const preset = definePreset(Aura, {
  semantic: {
    primary: palette('#5b5bd6'),
    focusRing: { width: '2px', style: 'solid', color: '{primary.color}', offset: '2px' },
  },
  // Boutons secondaires en sombre : texte un ton plus clair pour un contraste ≥ 4,5:1 (WCAG AA).
  components: {
    button: {
      colorScheme: {
        dark: {
          outlined: { secondary: { color: '{surface.300}' } },
          text: { secondary: { color: '{surface.300}' } },
        },
      },
    },
  },
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
