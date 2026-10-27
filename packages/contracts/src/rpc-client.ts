import { HarnessError, type SerializedHarnessError } from './errors.ts';
import type { HarnessClient, HarnessEvent, HarnessEvents } from './api.ts';

/** Transport minimal côté interface (navigateur, renderer Electron, WebSocket). */
export interface ClientTransport {
  send(message: { t: 'call'; id: number; method: string; params: unknown }): void;
  onMessage(listener: (message: unknown) => void): void;
}

type Incoming =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: SerializedHarnessError }
  | { t: 'event'; event: HarnessEvent; payload: unknown };

/** Client RPC générique : corrèle les réponses et distribue les événements. */
export function createRpcClient(transport: ClientTransport): HarnessClient {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<HarnessEvent, Set<(payload: unknown) => void>>();

  transport.onMessage((raw) => {
    const msg = raw as Incoming;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value === null ? undefined : msg.value);
      else p.reject(HarnessError.fromSerialized(msg.error));
    } else if (msg.t === 'event') {
      for (const l of listeners.get(msg.event) ?? []) {
        try {
          l(msg.payload);
        } catch {
          /* un abonné défaillant n'interrompt pas les autres */
        }
      }
    }
  });

  return {
    call: ((method: string, params?: unknown) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        transport.send({ t: 'call', id, method, params: params ?? null });
      })) as HarnessClient['call'],
    on<E extends HarnessEvent>(event: E, listener: (payload: HarnessEvents[E]) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener as (p: unknown) => void);
      return () => set.delete(listener as (p: unknown) => void);
    },
  };
}
