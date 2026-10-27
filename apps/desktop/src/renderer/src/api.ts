import { createRpcClient, HarnessError, type HarnessClient } from '@monolith/contracts';
import type { MonolithBridge } from '../../shared/bridge.ts';

declare global {
  interface Window {
    monolith: MonolithBridge;
  }
}

export const bridge = window.monolith;
export const host = bridge.host;

/** Client du moteur : appels RPC et événements, sur le port direct fourni par le preload. */
export const api: HarnessClient = createRpcClient({
  // Les paramètres peuvent être des objets réactifs (proxys Vue) : copie JSON avant le passage
  // par le pont (contextBridge / MessagePort n'acceptent que des données clonables).
  send: (m) => bridge.engine.send(plain(m)),
  onMessage: (l) => bridge.engine.onMessage(l),
});

/** Copie profonde de données JSON (désactive les proxys réactifs). */
export function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function errorMessage(error: unknown): string {
  if (error instanceof HarnessError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string {
  return error instanceof HarnessError ? error.code : 'internal';
}
