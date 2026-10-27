/** État réel d'une capacité sur la plateforme et l'hôte courants. */
export type CapabilityState = 'available' | 'planned' | 'unavailable';

export interface CapabilityStatus {
  state: CapabilityState;
  /** Explication affichée lorsque la capacité n'est pas disponible. */
  reason?: string;
  /** Implémentation effectivement utilisée (ex. `dpapi`, `uia`). */
  backend?: string;
}

export type CapabilityId =
  | 'secrets.system'
  | 'browser.embedded'
  | 'terminal.pty'
  | 'terminal.pipe'
  | 'desktop.screenshot'
  | 'desktop.semanticControl'
  | 'desktop.legacyInput'
  | 'notifications.system'
  | 'localModels'
  | 'python';

export type PlatformCapabilities = Record<CapabilityId, CapabilityStatus>;
