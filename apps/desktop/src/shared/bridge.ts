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

export interface HostApi {
  info(): Promise<RendererInfo>;
  pickDirectory(title?: string): Promise<string | null>;
  pickFiles(title?: string): Promise<string[]>;
  openExternal(url: string): Promise<boolean>;
  showItemInFolder(path: string): Promise<void>;
  /** Dialogue « Enregistrer sous » puis écriture du texte ; retourne le chemin ou null si annulé. */
  saveTextFile(defaultName: string, content: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  /** Dialogue « Enregistrer sous » puis écriture binaire (base64). */
  saveBinaryFile(defaultName: string, dataBase64: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  setTitleBarColors(colors: { background: string; symbols: string }): Promise<void>;
  setZoom(factor: number): void;
  relaunch(): Promise<void>;
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
