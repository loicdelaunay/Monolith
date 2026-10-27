import type { CapabilityStatus, PlatformCapabilities } from '@monolith/contracts';

export type HostKind = 'desktop' | 'cli' | 'server';

const planned = (reason: string): CapabilityStatus => ({ state: 'planned', reason });
const unavailable = (reason: string): CapabilityStatus => ({ state: 'unavailable', reason });

/**
 * Déclaration honnête des capacités : seules celles réellement implémentées sont `available`.
 * Mise à jour à chaque tranche (voir docs/FEATURE-MATRIX.md).
 */
export function platformCapabilities(host: HostKind, platform: NodeJS.Platform = process.platform): PlatformCapabilities {
  const gui = host === 'desktop';
  const mac = platform === 'darwin';
  return {
    'secrets.system':
      platform === 'win32'
        ? { state: 'available', backend: 'dpapi' }
        : platform === 'linux'
          ? { state: 'available', backend: 'libsecret', reason: 'Nécessite un trousseau Secret Service et la commande secret-tool.' }
          : mac
            ? { state: 'available', backend: 'keychain', reason: 'Implémenté mais non vérifié sur macOS.' }
            : unavailable('Système non pris en charge'),
    'browser.embedded': gui ? planned('Navigateur intégré : tranche T4.') : unavailable('Indisponible hors interface graphique ; utilisez un serveur MCP de navigation.'),
    'terminal.pty': planned('Terminaux interactifs : tranche T4.'),
    'terminal.pipe': planned('Terminaux asynchrones de l’agent : tranche T3.'),
    'desktop.screenshot': gui ? planned('Captures : tranche T4.') : unavailable('Nécessite l’interface desktop.'),
    'desktop.semanticControl': !gui
      ? unavailable('Nécessite l’interface desktop.')
      : platform === 'win32'
        ? planned('UI Automation : tranche T11.')
        : mac
          ? planned('Accessibilité macOS (AX) : non implémentée.')
          : planned('AT-SPI : à évaluer (tranche T11).'),
    'desktop.legacyInput': gui ? planned('Saisie physique (Legacy) : tranche T11, désactivée par défaut.') : unavailable('Nécessite l’interface desktop.'),
    'notifications.system': gui ? planned('Notifications : tranche T9.') : unavailable('Le CLI utilise la cloche du terminal (tranche T9).'),
    localModels: planned('Moteur GGUF intégré : tranche T10. Les serveurs locaux compatibles OpenAI fonctionnent déjà.'),
    python: planned('Scripts Python : tranche T6.'),
  };
}
