export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** ISO-8601 with an explicit offset, which is what the zod schemas require. */
export function nowIso(clock: Clock = systemClock): string {
  return clock().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function elapsedMs(fromIso: string, clock: Clock = systemClock): number {
  return clock().getTime() - new Date(fromIso).getTime();
}
