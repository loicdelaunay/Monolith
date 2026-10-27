// Processus moteur (Electron utilityProcess). Exécute @monolith/core hors du processus
// principal et hors du thread d'interface ; chaque fenêtre lui parle par un MessagePort dédié.
import { Harness, serveRpc, type RpcMessage } from '@monolith/core';
import changelog from '../../../../CHANGELOG.md?raw';

interface ParentMessage {
  type: 'connect' | 'shutdown';
}

const parent = process.parentPort;
const exeDir = process.env.MONOLITH_EXE_DIR || null;
const explicit = process.env.MONOLITH_DATA_DIR || null;

let harness: Harness;
try {
  harness = new Harness({ host: 'desktop', data: { explicit, exeDir }, changelog, logToConsole: process.env.MONOLITH_DEV === '1' });
} catch (error) {
  parent.postMessage({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

const settings = harness.settings.get();
parent.postMessage({
  type: 'ready',
  dataDir: harness.dataDir.dir,
  titleBar: settings.appearance.titleBar,
  zoom: settings.appearance.zoom,
  readOnly: harness.db.info.readOnly,
});

harness.events.on('settings.changed', (s) => {
  parent.postMessage({ type: 'settings', titleBar: s.appearance.titleBar, zoom: s.appearance.zoom });
});

parent.on('message', (event: { data: ParentMessage; ports: Electron.MessagePortMain[] }) => {
  if (event.data?.type === 'connect' && event.ports[0]) {
    const port = event.ports[0];
    let closeListener: (() => void) | null = null;
    serveRpc(harness, {
      post: (m: RpcMessage) => port.postMessage(m),
      onMessage: (l) => port.on('message', (e) => l(e.data as RpcMessage)),
      onClose: (l) => {
        closeListener = l;
      },
    });
    port.on('close', () => closeListener?.());
    port.start();
  } else if (event.data?.type === 'shutdown') {
    void harness.close().finally(() => process.exit(0));
  }
});
