import { serializeError, type HarnessEvent, type HarnessMethod } from '@monolith/contracts';
import type { Harness } from '../harness.ts';

/** Messages échangés entre une interface et le moteur (MessagePort, WebSocket…). */
export type RpcMessage =
  | { t: 'call'; id: number; method: string; params: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: ReturnType<typeof serializeError> }
  | { t: 'event'; event: HarnessEvent; payload: unknown };

export interface RpcPort {
  post(message: RpcMessage): void;
  onMessage(listener: (message: RpcMessage) => void): void;
  onClose?(listener: () => void): void;
}

/**
 * Sert l'API du moteur sur un port. Les événements sont relayés tant que le port est ouvert.
 * Retourne une fonction de déconnexion.
 */
export function serveRpc(harness: Harness, port: RpcPort): () => void {
  const off = harness.events.onAny((event, payload) => {
    try {
      port.post({ t: 'event', event, payload });
    } catch {
      /* port fermé */
    }
  });
  port.onMessage(async (msg) => {
    if (!msg || msg.t !== 'call' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    if (!harness.isMethod(msg.method)) {
      port.post({ t: 'result', id: msg.id, ok: false, error: { name: 'HarnessError', code: 'invalid_argument', message: `Méthode inconnue : ${msg.method}` } });
      return;
    }
    try {
      const value = await (harness.call as (m: HarnessMethod, p: unknown) => Promise<unknown>)(msg.method as HarnessMethod, msg.params);
      port.post({ t: 'result', id: msg.id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      port.post({ t: 'result', id: msg.id, ok: false, error: serializeError(error) });
    }
  });
  port.onClose?.(off);
  return off;
}
