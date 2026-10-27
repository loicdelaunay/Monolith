import { palette, updatePreset } from '@primeuix/themes';
import type { Settings } from '@monolith/contracts';

/** Jetons de couleur d'une variante (claire ou sombre) d'un thème. */
export interface ThemeTokens {
  bg: string;
  sidebar: string;
  surface: string;
  elevated: string;
  hover: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  userBubble: string;
  assistantBubble: string;
  toolBubble: string;
  codeBg: string;
  danger: string;
  warning: string;
  success: string;
  /** Palette de surface PrimeVue (0 → 950). */
  surfaceScale: Record<string, string>;
}

export interface ThemeDefinition {
  id: string;
  name: { fr: string; en: string };
  light: ThemeTokens | null;
  dark: ThemeTokens;
}

const zincLight = { 0: '#ffffff', 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' };
const neutralDark = { 0: '#ffffff', 50: '#f5f5f5', 100: '#e8e8e8', 200: '#d0d0d0', 300: '#b0b0b0', 400: '#8a8a8a', 500: '#6b6b6b', 600: '#4a4a4a', 700: '#333333', 800: '#242424', 900: '#161616', 950: '#0b0b0b' };

export const THEMES: ThemeDefinition[] = [
  {
    id: 'monolith',
    name: { fr: 'Monolith', en: 'Monolith' },
    light: {
      bg: '#f7f7f8', sidebar: '#f0f0f2', surface: '#ffffff', elevated: '#ffffff', hover: '#e9e9ec', border: '#e2e2e6', text: '#1b1b1f', muted: '#6e6e78',
      accent: '#5b5bd6', accentText: '#ffffff', userBubble: '#ececfb', assistantBubble: 'transparent', toolBubble: '#f2f2f5', codeBg: '#f6f6f8',
      danger: '#d93f3f', warning: '#c27c0e', success: '#1f8a5b', surfaceScale: zincLight,
    },
    dark: {
      bg: '#111214', sidebar: '#0d0e10', surface: '#17181b', elevated: '#1d1e22', hover: '#24252a', border: '#2a2b30', text: '#e7e7ea', muted: '#9a9ba4',
      accent: '#8183f4', accentText: '#0d0e10', userBubble: '#25264a', assistantBubble: 'transparent', toolBubble: '#1b1c20', codeBg: '#141518',
      danger: '#f06a6a', warning: '#e0a43a', success: '#4cc38a', surfaceScale: { 0: '#ffffff', 50: '#f4f4f5', 100: '#e7e7ea', 200: '#c9c9cf', 300: '#a3a3ad', 400: '#7c7c87', 500: '#5b5b66', 600: '#3e3e46', 700: '#2a2b30', 800: '#1d1e22', 900: '#17181b', 950: '#111214' },
    },
  },
  {
    id: 'fluent-dark-v2',
    name: { fr: 'Fluent sombre V2', en: 'Fluent Dark V2' },
    // Surfaces noires et grises, bordures discrètes ; seul l'accent porte le bleu #1D6FC8.
    light: {
      bg: '#f3f3f3', sidebar: '#ebebeb', surface: '#ffffff', elevated: '#ffffff', hover: '#e5e5e5', border: '#dedede', text: '#1a1a1a', muted: '#616161',
      accent: '#1D6FC8', accentText: '#ffffff', userBubble: '#e3eefa', assistantBubble: 'transparent', toolBubble: '#f5f5f5', codeBg: '#f7f7f7',
      danger: '#c42b1c', warning: '#9d5d00', success: '#0f7b0f', surfaceScale: { ...zincLight, 50: '#fafafa', 100: '#f3f3f3', 200: '#e5e5e5', 300: '#d1d1d1' },
    },
    dark: {
      bg: '#0b0b0b', sidebar: '#060606', surface: '#141414', elevated: '#1c1c1c', hover: '#232323', border: '#2b2b2b', text: '#f3f3f3', muted: '#a0a0a0',
      accent: '#1D6FC8', accentText: '#ffffff', userBubble: '#1f1f1f', assistantBubble: 'transparent', toolBubble: '#171717', codeBg: '#101010',
      danger: '#ff6b5b', warning: '#fce100', success: '#6ccb5f', surfaceScale: neutralDark,
    },
  },
  {
    id: 'graphite',
    name: { fr: 'Graphite', en: 'Graphite' },
    light: {
      bg: '#f6f5f3', sidebar: '#efeeeb', surface: '#ffffff', elevated: '#ffffff', hover: '#e8e6e2', border: '#e0ddd8', text: '#1f1d1a', muted: '#6f6a63',
      accent: '#0f8a7a', accentText: '#ffffff', userBubble: '#e3f2ef', assistantBubble: 'transparent', toolBubble: '#f3f1ee', codeBg: '#f7f6f4',
      danger: '#c8423b', warning: '#b06f12', success: '#2b8a4e', surfaceScale: { 0: '#ffffff', 50: '#faf9f7', 100: '#f2f1ee', 200: '#e3e0db', 300: '#d0ccc5', 400: '#a8a29a', 500: '#7c766e', 600: '#5c5751', 700: '#433f3a', 800: '#2b2825', 900: '#1d1b19', 950: '#100f0e' },
    },
    dark: {
      bg: '#141312', sidebar: '#0f0e0d', surface: '#1b1a18', elevated: '#22201e', hover: '#2a2826', border: '#33302d', text: '#ebe8e3', muted: '#a39d94',
      accent: '#35c2ad', accentText: '#0f0e0d', userBubble: '#1d3330', assistantBubble: 'transparent', toolBubble: '#1e1d1b', codeBg: '#171615',
      danger: '#f07167', warning: '#e7a33e', success: '#5cc489', surfaceScale: { 0: '#ffffff', 50: '#f5f3f0', 100: '#e7e4df', 200: '#cbc6be', 300: '#a8a29a', 400: '#857f77', 500: '#625d57', 600: '#46423e', 700: '#33302d', 800: '#22201e', 900: '#1b1a18', 950: '#141312' },
    },
  },
];

export function findTheme(id: string): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

const FONT_STACKS: Record<string, string> = {
  system: 'system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif',
  humanist: '"Segoe UI Variable Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif',
  rounded: '"Segoe UI Variable Small", ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif',
};
const MONO_STACKS: Record<string, string> = {
  default: '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", "SF Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", ui-monospace, monospace',
  consolas: 'Consolas, "Cascadia Mono", ui-monospace, monospace',
  system: 'ui-monospace, monospace',
};
export const FONT_CHOICES = Object.keys(FONT_STACKS);
export const MONO_CHOICES = Object.keys(MONO_STACKS);

let lastApplied = '';

/**
 * Applique un thème. Les propriétés CSS ne sont réécrites que lorsque leur valeur change
 * (aucun recalcul de style inutile au repos).
 */
export function applyAppearance(appearance: Settings['appearance'], prefersDark: boolean): { dark: boolean; tokens: ThemeTokens } {
  const theme = findTheme(appearance.theme);
  const wantDark = appearance.mode === 'dark' || (appearance.mode === 'system' && prefersDark);
  const dark = wantDark || !theme.light;
  const base = dark ? theme.dark : theme.light!;
  const tokens: ThemeTokens = {
    ...base,
    ...(appearance.accent ? { accent: appearance.accent } : {}),
    ...(appearance.userBubble ? { userBubble: appearance.userBubble } : {}),
    ...(appearance.assistantBubble ? { assistantBubble: appearance.assistantBubble } : {}),
    ...(appearance.toolBubble ? { toolBubble: appearance.toolBubble } : {}),
  };

  const vars: Record<string, string> = {
    '--mh-bg': tokens.bg,
    '--mh-sidebar': tokens.sidebar,
    '--mh-surface': tokens.surface,
    '--mh-elevated': tokens.elevated,
    '--mh-hover': tokens.hover,
    '--mh-border': tokens.border,
    '--mh-text': tokens.text,
    '--mh-muted': tokens.muted,
    '--mh-accent': tokens.accent,
    '--mh-accent-text': tokens.accentText,
    '--mh-user-bubble': tokens.userBubble,
    '--mh-assistant-bubble': tokens.assistantBubble,
    '--mh-tool-bubble': tokens.toolBubble,
    '--mh-code-bg': tokens.codeBg,
    '--mh-danger': tokens.danger,
    '--mh-warning': tokens.warning,
    '--mh-success': tokens.success,
    '--mh-font-ui': FONT_STACKS[appearance.uiFont] ?? FONT_STACKS.system!,
    '--mh-font-input': FONT_STACKS[appearance.inputFont] ?? FONT_STACKS.system!,
    '--mh-font-reply': FONT_STACKS[appearance.replyFont] ?? FONT_STACKS.system!,
    '--mh-font-mono': MONO_STACKS[appearance.monoFont] ?? MONO_STACKS.default!,
    '--mh-reading-size': `${appearance.readingSize}px`,
    '--mh-density': appearance.density === 'compact' ? '0.75' : '1',
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v);
  }
  root.classList.toggle('mh-dark', dark);
  root.dataset.density = appearance.density;

  const key = `${theme.id}|${dark}|${tokens.accent}`;
  if (key !== lastApplied) {
    lastApplied = key;
    updatePreset({
      semantic: {
        primary: palette(tokens.accent),
        colorScheme: {
          [dark ? 'dark' : 'light']: {
            surface: tokens.surfaceScale,
            primary: { color: tokens.accent, contrastColor: tokens.accentText, hoverColor: tokens.accent, activeColor: tokens.accent },
            highlight: { background: `color-mix(in srgb, ${tokens.accent} 18%, transparent)`, focusBackground: `color-mix(in srgb, ${tokens.accent} 26%, transparent)`, color: tokens.text, focusColor: tokens.text },
          },
        },
      },
    });
  }
  return { dark, tokens };
}
