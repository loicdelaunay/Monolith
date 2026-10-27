// Preload (sandboxé) : seul pont entre l'interface et le reste de l'application.
// Expose un port vers le moteur et quelques appels hôte nommés ; rien d'autre.
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { HostApi, MonolithBridge } from '../shared/bridge.ts';

let port: MessagePort | null = null;
const queue: unknown[] = [];
const listeners = new Set<(message: unknown) => void>();
const restartListeners = new Set<() => void>();
let connectedOnce = false;

ipcRenderer.on('engine:port', (event) => {
  const next = event.ports[0];
  if (!next) return;
  port?.close();
  port = next;
  port.onmessage = (e: MessageEvent) => {
    for (const l of listeners) l(e.data);
  };
  port.start();
  for (const m of queue.splice(0)) port.postMessage(m);
  if (connectedOnce) for (const l of restartListeners) l();
  connectedOnce = true;
});
ipcRenderer.send('engine:request-port');

const host: HostApi = {
  info: () => ipcRenderer.invoke('host:info'),
  pickDirectory: (title) => ipcRenderer.invoke('host:pickDirectory', title),
  pickFiles: (title) => ipcRenderer.invoke('host:pickFiles', title),
  openExternal: (url) => ipcRenderer.invoke('host:openExternal', url),
  showItemInFolder: (path) => ipcRenderer.invoke('host:showItemInFolder', path),
  saveTextFile: (defaultName, content, filters) => ipcRenderer.invoke('host:saveTextFile', defaultName, content, filters),
  setTitleBarColors: (colors) => ipcRenderer.invoke('host:setTitleBarColors', colors),
  setZoom: (factor) => {
    if (typeof factor === 'number' && factor >= 0.5 && factor <= 2 && webFrame.getZoomFactor() !== factor) webFrame.setZoomFactor(factor);
  },
  relaunch: () => ipcRenderer.invoke('host:relaunch'),
  browser: {
    setBounds: (bounds) => ipcRenderer.send('browser:bounds', bounds),
    command: (cmd, args) => ipcRenderer.invoke('browser:command', cmd, args ?? {}),
    state: () => ipcRenderer.invoke('browser:state'),
    onState: (listener) => {
      const l = (_e: unknown, s: Parameters<typeof listener>[0]) => listener(s);
      ipcRenderer.on('browser:state', l);
      return () => ipcRenderer.off('browser:state', l);
    },
  },
  onEngineRestarted: (listener) => {
    restartListeners.add(listener);
    return () => restartListeners.delete(listener);
  },
};

const bridge: MonolithBridge = {
  engine: {
    send: (message) => {
      if (port) port.postMessage(message);
      else queue.push(message);
    },
    onMessage: (listener) => {
      listeners.add(listener);
    },
  },
  host,
};

contextBridge.exposeInMainWorld('monolith', bridge);
