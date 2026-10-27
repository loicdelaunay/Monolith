export const now = (): string => new Date().toISOString();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Estimation grossière (≈ 4 caractères par token) utilisée uniquement lorsque l'API ne fournit rien. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
