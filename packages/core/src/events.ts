import type { HarnessEvent, HarnessEvents } from '@monolith/contracts';

type Listener<E extends HarnessEvent> = (payload: HarnessEvents[E]) => void;

/** Bus d'événements typé du moteur. Les transports s'y abonnent via `onAny`. */
export class EventBus {
  private readonly listeners = new Map<HarnessEvent, Set<Listener<HarnessEvent>>>();
  private readonly any = new Set<(event: HarnessEvent, payload: unknown) => void>();

  on<E extends HarnessEvent>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener<HarnessEvent>);
    return () => set.delete(listener as Listener<HarnessEvent>);
  }

  onAny(listener: (event: HarnessEvent, payload: unknown) => void): () => void {
    this.any.add(listener);
    return () => this.any.delete(listener);
  }

  emit<E extends HarnessEvent>(event: E, payload: HarnessEvents[E]): void {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        l(payload);
      } catch {
        /* un abonné défaillant n'interrompt pas les autres */
      }
    }
    for (const l of this.any) {
      try {
        l(event, payload);
      } catch {
        /* idem */
      }
    }
  }
}
