import type { Id, ReasoningLevel, ResponseStyle } from './model.ts';

export type Language = 'system' | 'fr' | 'en';
export type ThemeMode = 'system' | 'light' | 'dark';
export type ReasoningDisplay = 'none' | 'collapsed' | 'expanded';
export type Density = 'compact' | 'comfortable';

export interface Settings {
  general: {
    language: Language;
    /** Demander confirmation avant de supprimer une conversation. */
    confirmDelete: boolean;
  };
  chat: {
    defaultProviderId: Id | null;
    defaultModel: string | null;
    defaultReasoningLevel: ReasoningLevel;
    responseStyle: ResponseStyle;
    reasoningDisplay: ReasoningDisplay;
    showThroughput: boolean;
    showContextUsage: boolean;
    codeLineNumbers: boolean;
    /** Instructions système globales ajoutées avant celles du projet. */
    customInstructions: string;
  };
  appearance: {
    mode: ThemeMode;
    theme: string;
    accent: string | null;
    uiFont: string;
    inputFont: string;
    replyFont: string;
    monoFont: string;
    readingSize: number;
    density: Density;
    zoom: number;
    userBubble: string | null;
    assistantBubble: string | null;
    toolBubble: string | null;
    /** Barre de titre personnalisée ; `system` force le cadre natif. */
    titleBar: 'custom' | 'system';
  };
  network: {
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    /** Retry ciblé : HTTP 400 dont le corps indique un JSON tronqué par une passerelle. */
    retryTruncatedJson400: boolean;
  };
  cli: {
    theme: string;
  };
  layout: {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    collapsedProjects: Id[];
    showArchived: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  general: {
    language: 'system',
    confirmDelete: true,
  },
  chat: {
    defaultProviderId: null,
    defaultModel: null,
    defaultReasoningLevel: 'auto',
    responseStyle: 'default',
    reasoningDisplay: 'collapsed',
    showThroughput: false,
    showContextUsage: false,
    codeLineNumbers: true,
    customInstructions: '',
  },
  appearance: {
    mode: 'system',
    theme: 'monolith',
    accent: null,
    uiFont: 'system',
    inputFont: 'system',
    replyFont: 'system',
    monoFont: 'default',
    readingSize: 15,
    density: 'comfortable',
    zoom: 1,
    userBubble: null,
    assistantBubble: null,
    toolBubble: null,
    titleBar: 'custom',
  },
  network: {
    retryMaxAttempts: 3,
    retryBaseDelayMs: 800,
    retryTruncatedJson400: true,
  },
  cli: {
    theme: 'monolith',
  },
  layout: {
    sidebarWidth: 280,
    sidebarCollapsed: false,
    collapsedProjects: [],
    showArchived: false,
  },
};

export type SettingsSection = keyof Settings;

/** Patch profond limité à deux niveaux (section → clé). */
export type SettingsPatch = { [S in SettingsSection]?: Partial<Settings[S]> };

/** Bornes appliquées par le moteur : une valeur hors bornes est ramenée dans l'intervalle. */
export const SETTINGS_BOUNDS = {
  'appearance.readingSize': [11, 24],
  'appearance.zoom': [0.7, 1.6],
  'network.retryMaxAttempts': [1, 8],
  'network.retryBaseDelayMs': [100, 10_000],
  'layout.sidebarWidth': [200, 520],
} as const satisfies Record<string, readonly [number, number]>;
