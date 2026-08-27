export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly maximum: number) {}
  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; this.waiting.shift()?.(); }
  }
  inFlight(): number { return this.active; }
}
