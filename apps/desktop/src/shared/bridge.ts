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

export interface HostApi {
  info(): Promise<RendererInfo>;
  pickDirectory(title?: string): Promise<string | null>;
  openExternal(url: string): Promise<boolean>;
  showItemInFolder(path: string): Promise<void>;
  setTitleBarColors(colors: { background: string; symbols: string }): Promise<void>;
  setZoom(factor: number): void;
  relaunch(): Promise<void>;
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
