import type { CapabilityStatus, PlatformCapabilities } from '@monolith/contracts';

export type HostKind = 'desktop' | 'cli' | 'server';

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
    'browser.embedded': gui ? { state: 'available', backend: 'electron' } : unavailable('Indisponible hors interface graphique ; utilisez un serveur MCP de navigation.'),
    'terminal.pty': unavailable('Pas de pseudo-terminal interactif : les commandes s’exécutent en tâche asynchrone (sortie en direct, arrêt).'),
    'terminal.pipe': { state: 'available', backend: platform === 'win32' ? 'cmd' : 'sh' },
    'desktop.screenshot': gui ? { state: 'available', backend: 'electron' } : unavailable('Nécessite l’interface desktop.'),
    'desktop.semanticControl': !gui
      ? unavailable('Nécessite l’interface desktop.')
      : platform === 'win32'
        ? { state: 'available', backend: 'uia', reason: 'UI Automation (PowerShell, thread MTA, délai de 10 s) ; skills Clavier et Souris désactivés par défaut.' }
        : mac
          ? unavailable('macOS : contrôle du clavier et de la souris non pris en charge dans cette version.')
          : unavailable('Linux : contrôle du clavier et de la souris non disponible (AT-SPI non implémenté).'),
    'desktop.legacyInput': !gui
      ? unavailable('Nécessite l’interface desktop.')
      : platform === 'win32'
        ? { state: 'available', backend: 'win32', reason: 'Saisie physique séparée ; repli automatique désactivé par défaut.' }
        : unavailable(mac ? 'macOS : non pris en charge dans cette version.' : 'Linux : non disponible.'),
    'notifications.system': gui ? { state: 'available', backend: 'electron' } : unavailable('Le CLI n’affiche pas de notifications système.'),
    localModels: { state: 'available', backend: 'llama.cpp', reason: 'Moteur llama-server externe (chemin choisi ou version officielle installée).' },
    python: { state: 'available', backend: 'system', reason: 'Python 3 du poste (py, python3, python) ; aucun Python embarqué.' },
  };
}
