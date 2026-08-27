import type { SimulationConfig } from "./config.ts";
import { SimulationEngine } from "./SimulationEngine.ts";

export type RunnerScheduler = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

const scheduler: RunnerScheduler = { now: () => performance.now(), setTimeout, clearTimeout };

export class SimulationRunner {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private tick?: Promise<void>;
  private previousMs = 0;
  private stopped = false;
  private failure?: unknown;
  constructor(private readonly engine: SimulationEngine, private readonly config: SimulationConfig, private readonly clock: RunnerScheduler = scheduler) {}
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.previousMs = this.clock.now();
    this.schedule();
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.tick) await this.tick.catch((error) => { this.failure ??= error; });
    await this.engine.shutdown();
    if (this.failure !== undefined) throw this.failure;
  }
  private schedule(): void {
    if (!this.running) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      const current = this.clock.now();
      const elapsed = Math.min(this.config.maximumAdvanceMs, Math.max(1, current - this.previousMs) * this.config.timeMultiplier);
      this.previousMs = current;
      const tick = this.engine.advance(elapsed);
      this.tick = tick;
      void tick.then(
        () => { this.tick = undefined; this.schedule(); },
        (error) => { this.tick = undefined; this.failure = error; this.running = false; },
      );
    }, this.config.tickIntervalMs);
  }
}
