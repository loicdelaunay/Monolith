// Processus moteur (Electron utilityProcess). Exécute @monolith/core hors du processus
// principal et hors du thread d'interface ; chaque fenêtre lui parle par un MessagePort dédié.
import { Harness, serveRpc, type HostBridge, type RpcMessage } from '@monolith/core';
import changelog from '../../../../CHANGELOG.md?raw';

interface ParentMessage {
  type: 'connect' | 'shutdown' | 'host-response';
  id?: number;
  result?: unknown;
  error?: string;
}

const parent = process.parentPort;
const exeDir = process.env.MONOLITH_EXE_DIR || null;
const explicit = process.env.MONOLITH_DATA_DIR || null;

// Pont vers le processus principal : navigateur intégré et captures (WebContentsView, desktopCapturer).
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;
const hostBridge: HostBridge = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Délai dépassé pour ${method}`));
      }, 90_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      parent.postMessage({ type: 'host-request', id, method, params });
    });
  },
};

let harness: Harness;
try {
  harness = new Harness({ host: 'desktop', data: { explicit, exeDir }, changelog, logToConsole: process.env.MONOLITH_DEV === '1', hostBridge });
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
  } else if (event.data?.type === 'host-response' && typeof event.data.id === 'number') {
    const p = pending.get(event.data.id);
    pending.delete(event.data.id);
    if (event.data.error) p?.reject(new Error(event.data.error));
    else p?.resolve(event.data.result);
  } else if (event.data?.type === 'shutdown') {
    void harness.close().finally(() => process.exit(0));
  }
});
