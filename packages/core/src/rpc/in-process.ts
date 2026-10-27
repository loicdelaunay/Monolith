import type { HarnessClient } from '@monolith/contracts';
import type { Harness } from '../harness.ts';

/** Client en processus (CLI, tests) : même contrat que les transports distants. */
export function createInProcessClient(harness: Harness): HarnessClient {
  return {
    call: ((method: Parameters<Harness['call']>[0], params?: unknown) =>
      (harness.call as (m: string, p: unknown) => Promise<unknown>)(method, structuredClone(params)).then((r) => structuredClone(r))) as HarnessClient['call'],
    on: (event, listener) => harness.events.on(event, listener),
  };
}
