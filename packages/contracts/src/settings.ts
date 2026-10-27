import type { AgentMode, ConversationMode, Id, ReasoningLevel, ResponseStyle } from './model.ts';

/** Raccourci clavier : applique un fournisseur, un modèle, un mode et/ou un niveau de réflexion. */
export interface ShortcutItem {
  id: string;
  /** Combinaison normalisée, ex. « Alt+1 », « Ctrl+Shift+K ». */
  keys: string;
  label: string;
  providerId: Id | null;
  model: string | null;
  mode: ConversationMode | null;
  agentMode: AgentMode | null;
  reasoningLevel: ReasoningLevel | null;
}
import type { PermissionPolicy, SubagentPreset } from './tools.ts';
import type { UpdateMode } from './updates.ts';

export type Language = 'system' | 'fr' | 'en';
export type ThemeMode = 'system' | 'light' | 'dark';
export type ReasoningDisplay = 'none' | 'collapsed' | 'expanded';
export type Density = 'compact' | 'comfortable';
/** Contrôle du bureau Windows : automatique (UI Automation d'abord), UI Automation seule, ou saisie physique. */
export type DesktopInputMode = 'auto' | 'uia' | 'legacy';

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
    /** Nommage automatique après la première réponse (requête dédiée, comptabilisée). */
    autoNaming: boolean;
    /** Connexion et modèle dédiés au nommage ; null : ceux de la conversation. */
    namingProviderId: Id | null;
    namingModel: string | null;
    /** Compactage automatique avant envoi lorsque le contexte dépasse le seuil. */
    autoCompact: boolean;
    /** Seuil en pourcentage de la fenêtre de contexte (moins la réserve de sortie). */
    compactThreshold: number;
    /** Nombre de derniers échanges (question + réponse) toujours conservés intacts. */
    compactKeepTurns: number;
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
    /** Nom et logos affichés (vides : Monolith Harness). Logos : images data: ≤ 256 Ko. */
    appName: string;
    logoLight: string | null;
    logoDark: string | null;
    /** Animation de fond (désactivée par défaut ; respecte la réduction des animations du système). */
    backgroundAnimation: 'none' | 'gradient' | 'aurora' | 'particles';
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
  agent: {
    /** Tours d'outils maximum par réponse. */
    maxToolRounds: number;
    /** Délai d'attente d'une commande avant de la laisser en arrière-plan (s). */
    commandTimeoutSec: number;
    /** Taille maximale d'un résultat d'outil renvoyé au modèle (caractères). */
    maxResultChars: number;
    /** Lire les fichiers d'instructions (AGENTS.md, CLAUDE.md, .monolith/instructions.md) des racines et sous-dossiers. */
    readInstructionFiles: boolean;
  };
  permissions: {
    policy: PermissionPolicy;
    /** Validateur du mode Automatique (connexion et modèle) ; non configuré : chaque action est demandée. */
    validatorProviderId: Id | null;
    validatorModel: string | null;
  };
  loop: {
    enabled: boolean;
    /** Nombre de répétitions qui déclenche l'alerte. */
    threshold: number;
    /** Nombre de derniers appels comparés. */
    window: number;
    /** `exact` : arguments identiques ; `equivalent` : arguments normalisés (espaces, ordre des clés, casse). */
    match: 'exact' | 'equivalent';
  };
  skills: {
    /** Activation par skill (identifiant → actif). Désactiver retire l'accès au modèle, les données restent. */
    enabled: Record<string, boolean>;
    info: { date: boolean; system: boolean; conversation: boolean };
  };
  render: {
    mermaid: boolean;
    latex: boolean;
    /** Aperçus interactifs isolés des blocs HTML. */
    htmlPreview: boolean;
    /** Badges de fichiers vérifiés pour les chemins cités. */
    fileBadges: boolean;
  };
  local: {
    /** Taille de contexte par défaut des modèles locaux (tokens). */
    contextSize: number;
    /** Couches sur le GPU : -1 = estimation automatique, 0 = CPU seul. */
    gpuLayers: number;
    /** Threads CPU : 0 = automatique. */
    threads: number;
    /** Arrêt du serveur local après N minutes d'inactivité (0 : jamais). */
    idleUnloadMin: number;
  };
  notifications: {
    /** Notifications système (centre de notifications du système). */
    system: boolean;
    sound: boolean;
    /** Fin de génération dans une conversation qui n'est pas affichée (ou fenêtre inactive). */
    onGeneration: boolean;
    onScheduled: boolean;
    onError: boolean;
  };
  maintenance: {
    /** Archiver les conversations inactives depuis N jours (0 : jamais). */
    autoArchiveDays: number;
    /** Supprimer les conversations archivées depuis N jours (0 : jamais). */
    autoDeleteArchivedDays: number;
    /** Supprimer les pièces jointes qui ne sont plus référencées. */
    cleanAttachments: boolean;
  };
  studio: {
    /** Connexion et modèle des outils dédiés (null : modèle par défaut du chat). */
    providerId: Id | null;
    model: string | null;
    imageProviderId: Id | null;
    imageModel: string | null;
    imageSize: string;
    /** Vision de secours : description des images par ce modèle quand celui de la conversation n'a pas la vision. */
    visionFallback: boolean;
    visionProviderId: Id | null;
    visionModel: string | null;
  };
  subagents: {
    /** auto : outil disponible ; forced : délégation demandée au modèle ; off : désactivés. */
    mode: 'auto' | 'forced' | 'off';
    maxDepth: number;
    maxParallel: number;
    /** Budget par sous-agent. */
    maxRounds: number;
    maxOutputTokens: number;
    timeoutSec: number;
    presets: SubagentPreset[];
  };
  memory: {
    /** Lecture initiale forcée : mémoires pertinentes injectées en début de génération. */
    forcedRead: boolean;
    forcedReadCount: number;
    /** Écriture forcée : extraction automatique de souvenirs après chaque réponse (requête dédiée). */
    forcedWrite: boolean;
  };
  web: {
    /** none : pas de moteur, l'agent n'utilise que le client HTTP intégré (comme la v1). */
    searchProvider: 'duckduckgo' | 'searxng' | 'none';
    searxngUrl: string;
    maxPageChars: number;
    /** Client HTTP intégré : réglages par défaut (modifiables par conversation avec web_http_configure). */
    httpUserAgent: string;
    httpProxyUrl: string;
    httpUseCookies: boolean;
    httpFollowRedirects: boolean;
    httpTimeoutSec: number;
    httpResponseMode: 'smart' | 'legacy';
    httpMaxResponseKb: number;
  };
  updates: {
    /** off : jamais de vérification automatique ; notify : signaler ; auto : télécharger et installer à la fermeture. */
    mode: UpdateMode;
  };
  desktop: {
    /** Contrôle du clavier : auto = UI Automation d'abord ; uia = actions sémantiques seules ; legacy = saisie physique. */
    keyboardMode: DesktopInputMode;
    /** Contrôle de la souris (mêmes modes, réglés séparément). */
    mouseMode: DesktopInputMode;
    /** En mode automatique, l'IA peut choisir uia ou legacy à chaque appel ; un mode fixe n'est jamais contourné. */
    allowAiChoose: boolean;
    /** Repli Legacy automatique (mode automatique) : seulement sur échec de capacité avant toute action, autorisé à part. */
    legacyFallback: boolean;
  };
  rag: {
    /** Connexion et modèle d'embeddings (compatibles OpenAI) ; null : recherche lexicale seule. */
    embeddingProviderId: Id | null;
    embeddingModel: string | null;
    chunkLines: number;
    topK: number;
  };
  shortcuts: {
    items: ShortcutItem[];
    /** Ctrl+Shift+M : mode suivant ; Ctrl+Shift+R : niveau de réflexion suivant. */
    builtin: boolean;
  };
  layout: {
    panelOpen: boolean;
    panelTab: string;
    panelWidth: number;
    panelMaximized: boolean;
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
    showThroughput: true,
    showContextUsage: true,
    codeLineNumbers: true,
    customInstructions: '',
    autoNaming: true,
    namingProviderId: null,
    namingModel: null,
    autoCompact: true,
    compactThreshold: 80,
    compactKeepTurns: 4,
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
    appName: '',
    logoLight: null,
    logoDark: null,
    backgroundAnimation: 'none',
  },
  network: {
    retryMaxAttempts: 3,
    retryBaseDelayMs: 800,
    retryTruncatedJson400: true,
  },
  cli: {
    theme: 'monolith',
  },
  agent: {
    maxToolRounds: 40,
    commandTimeoutSec: 120,
    maxResultChars: 24_000,
    readInstructionFiles: true,
  },
  permissions: {
    // Lecture dans la portée : automatique ; écriture, commandes, réseau : demande (sauf règle).
    policy: 'rules',
    validatorProviderId: null,
    validatorModel: null,
  },
  loop: {
    enabled: true,
    threshold: 3,
    window: 12,
    match: 'equivalent',
  },
  skills: {
    enabled: {
      info: true,
      sources: true,
      editing: true,
      patch: true,
      terminal: true,
      questions: true,
      actions: true,
      planning: true,
      summary: true,
      review: true,
      design: false,
      git: true,
      browser: true,
      screenshots: false,
      keyboard: false,
      mouse: false,
      memory: true,
      web: true,
      file_index: false,
      rag: false,
      python: false,
      custom_skills: true,
      mcp: true,
      subagents: true,
      images: false,
      vision: true,
      assets: true,
    },
    info: { date: true, system: true, conversation: true },
  },
  render: {
    mermaid: true,
    latex: true,
    htmlPreview: true,
    fileBadges: true,
  },
  local: {
    contextSize: 8192,
    gpuLayers: -1,
    threads: 0,
    idleUnloadMin: 10,
  },
  notifications: {
    system: false,
    sound: false,
    onGeneration: true,
    onScheduled: true,
    onError: true,
  },
  maintenance: {
    autoArchiveDays: 0,
    autoDeleteArchivedDays: 0,
    cleanAttachments: true,
  },
  studio: {
    providerId: null,
    model: null,
    imageProviderId: null,
    imageModel: null,
    imageSize: '1024x1024',
    visionFallback: true,
    visionProviderId: null,
    visionModel: null,
  },
  subagents: {
    mode: 'auto',
    maxDepth: 1,
    maxParallel: 3,
    maxRounds: 25,
    maxOutputTokens: 40_000,
    timeoutSec: 900,
    presets: [
      { id: 'explorer', name: 'Explorateur', description: 'Recherche et synthèse dans les sources, sans modification', instructions: 'Explore les sources, cite les fichiers et lignes utiles, ne modifie rien.', agentMode: 'plan', providerId: null, model: null },
      { id: 'implementer', name: 'Implémenteur', description: 'Réalise une modification bien délimitée', instructions: 'Réalise la modification demandée, vérifie-la (tests si possible) et décris précisément ce qui a changé.', agentMode: 'execute', providerId: null, model: null },
      { id: 'reviewer', name: 'Relecteur', description: 'Relit un changement et signale les problèmes', instructions: 'Relis le travail indiqué, signale les erreurs, risques et oublis par ordre de gravité, sans modifier.', agentMode: 'plan', providerId: null, model: null },
    ],
  },
  memory: {
    forcedRead: false,
    forcedReadCount: 20,
    forcedWrite: false,
  },
  web: {
    searchProvider: 'duckduckgo',
    searxngUrl: '',
    maxPageChars: 40_000,
    httpUserAgent: 'Mozilla/5.0 (compatible; MonolithHarness/3)',
    httpProxyUrl: '',
    httpUseCookies: false,
    httpFollowRedirects: true,
    httpTimeoutSec: 30,
    httpResponseMode: 'smart',
    httpMaxResponseKb: 1024,
  },
  updates: {
    mode: 'notify',
  },
  desktop: {
    keyboardMode: 'auto',
    mouseMode: 'auto',
    allowAiChoose: true,
    legacyFallback: false,
  },
  rag: {
    embeddingProviderId: null,
    embeddingModel: null,
    chunkLines: 60,
    topK: 8,
  },
  shortcuts: {
    items: [],
    builtin: true,
  },
  layout: {
    panelOpen: false,
    panelTab: 'files',
    panelWidth: 520,
    panelMaximized: false,
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
  'layout.panelWidth': [320, 1400],
  'chat.compactThreshold': [40, 95],
  'chat.compactKeepTurns': [1, 20],
  'agent.maxToolRounds': [1, 200],
  'agent.commandTimeoutSec': [5, 3600],
  'agent.maxResultChars': [2000, 200_000],
  'loop.threshold': [2, 20],
  'loop.window': [3, 100],
  'memory.forcedReadCount': [1, 100],
  'maintenance.autoArchiveDays': [0, 3650],
  'local.contextSize': [512, 262_144],
  'local.gpuLayers': [-1, 999],
  'local.threads': [0, 256],
  'local.idleUnloadMin': [0, 1440],
  'maintenance.autoDeleteArchivedDays': [0, 3650],
  'subagents.maxDepth': [1, 3],
  'subagents.maxParallel': [1, 8],
  'subagents.maxRounds': [1, 200],
  'subagents.maxOutputTokens': [1000, 1_000_000],
  'subagents.timeoutSec': [30, 7200],
  'web.maxPageChars': [2000, 200_000],
  'web.httpTimeoutSec': [5, 300],
  'web.httpMaxResponseKb': [16, 4096],
  'rag.chunkLines': [10, 400],
  'rag.topK': [1, 50],
} as const satisfies Record<string, readonly [number, number]>;
