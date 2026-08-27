export type Delay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export const defaultDelay: Delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const complete = () => { signal?.removeEventListener("abort", cancel); resolve(); };
  const timer = setTimeout(complete, milliseconds);
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
  signal?.addEventListener("abort", cancel, { once: true });
});

/** Evenly spaces starts; adequate for the single-process MVP's per-minute ceiling. */
export class RateLimiter {
  private nextAvailableMs = 0;
  private tail = Promise.resolve();
  constructor(
    requestsPerMinute: number,
    private readonly now: () => number = () => Date.now(),
    private readonly delay: Delay = defaultDelay,
  ) { this.intervalMs = 60_000 / requestsPerMinute; }
  private readonly intervalMs: number;

  acquire(signal?: AbortSignal): Promise<void> {
    const result = this.tail.then(async () => {
      const wait = Math.max(0, this.nextAvailableMs - this.now());
      if (wait > 0) await this.delay(wait, signal);
      this.nextAvailableMs = Math.max(this.nextAvailableMs, this.now()) + this.intervalMs;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
