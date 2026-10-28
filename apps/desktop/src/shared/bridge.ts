// Contrat du pont preload → renderer. Types uniquement (aucun code exécuté côté renderer).

export interface RendererInfo {
  platform: string;
  /** Barre de titre personnalisée active (contrôles natifs superposés). */
  customTitleBar: boolean;
  /** Hauteur réservée par les contrôles natifs (px). */
  titleBarHeight: number;
  /** Largeur occupée par les contrôles natifs à droite (Windows/Linux). */
  controlsWidth: number;
  isPackaged: boolean;
  locale: string;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  mobile: boolean;
  conversationId: number | null;
  error: string | null;
}

export interface BrowserStateInfo {
  tabs: BrowserTabInfo[];
  activeId: string | null;
  notice: string | null;
}

export type BrowserCommand = 'new' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'select' | 'close' | 'mobile' | 'devtools' | 'external' | 'clearData';

export interface LaunchSettingsInfo {
  hardwareAcceleration: boolean;
  angle: 'default' | 'd3d11' | 'd3d9' | 'gl' | 'vulkan' | 'swiftshader';
  vsync: boolean;
}

export interface GpuInfo {
  hardwareAcceleration: boolean;
  angle: string;
  vsyncDisabled: boolean;
  featureStatus: Record<string, string>;
  devices: { vendorId?: number; deviceId?: number; active?: boolean }[];
  glRenderer: string | null;
  displayHz: number;
  scaleFactor: number;
  versions: { electron: string; chrome: string; node: string };
}

export interface HostApi {
  info(): Promise<RendererInfo>;
  pickDirectory(title?: string): Promise<string | null>;
  pickFiles(title?: string): Promise<string[]>;
  /** Chemin sur le disque d'un fichier ou dossier choisi ou déposé ('' pour un contenu collé). */
  pathForFile(file: File): string;
  openExternal(url: string): Promise<boolean>;
  showItemInFolder(path: string): Promise<void>;
  /** Ouvre (ou ramène au premier plan) la fenêtre d'un outil dédié. */
  openToolWindow(tool: string, title: string): Promise<boolean>;
  /** Ouvre un fichier existant avec l'application par défaut (exécutables refusés) ; message d'erreur ou chaîne vide. */
  openPath(path: string): Promise<string>;
  /** Dialogue « Enregistrer sous » puis écriture du texte ; retourne le chemin ou null si annulé. */
  saveTextFile(defaultName: string, content: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  /** Dialogue « Enregistrer sous » puis écriture binaire (base64). */
  saveBinaryFile(defaultName: string, dataBase64: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  setTitleBarColors(colors: { background: string; symbols: string }): Promise<void>;
  setZoom(factor: number): void;
  relaunch(): Promise<void>;
  /** Notification du système (centre de notifications). */
  notify(title: string, body: string, silent?: boolean): Promise<boolean>;
  /** Réglages de rendu (lus au prochain démarrage) et valeurs appliquées au démarrage courant. */
  launch(value?: LaunchSettingsInfo): Promise<{ saved: LaunchSettingsInfo; applied: LaunchSettingsInfo } | null>;
  gpuInfo(): Promise<GpuInfo | null>;
  metrics(): Promise<{ pid: number; type: string; name: string; cpu: number; memoryMb: number }[]>;
  browser: {
    /** Position du panneau en pixels de fenêtre ; null masque la vue. */
    setBounds(bounds: { x: number; y: number; width: number; height: number } | null): void;
    command(cmd: BrowserCommand, args?: Record<string, unknown>): Promise<void>;
    state(): Promise<BrowserStateInfo | null>;
    onState(listener: (state: BrowserStateInfo) => void): () => void;
  };
  onEngineRestarted(listener: () => void): () => void;
}

export interface EngineBridge {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

export interface MonolithBridge {
  engine: EngineBridge;
  host: HostApi;
}
