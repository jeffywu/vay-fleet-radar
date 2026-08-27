import type { DispatchEngine, DispatchVehicle } from "@fleet-radar/dispatch";
import type { WorldCatalogView } from "@fleet-radar/world";
import type { DispatchJobRepository } from "../database/DispatchJobRepository.ts";
import type { FleetReadRepository } from "../database/FleetReadRepository.ts";

export class DispatchRunner {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private readonly engine: DispatchEngine, private readonly fleet: FleetReadRepository,
    private readonly jobs: DispatchJobRepository, private readonly world: WorldCatalogView, private readonly targetActive: number,
    private readonly intervalMs: number, private readonly maxPerCycle: number,
    private readonly routingReady: () => boolean = () => true) {}

  start(): void {
    if (this.timer || this.targetActive === 0) return;
    this.timer = setInterval(() => void this.cycle(), this.intervalMs);
    this.timer.unref();
    void this.cycle();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  async cycle(): Promise<void> {
    if (this.running) return this.running;
    const operation = this.runCycle();
    this.running = operation;
    try { await operation; }
    finally { if (this.running === operation) this.running = undefined; }
  }
  private async runCycle(): Promise<void> {
    if (!this.routingReady()) return;
    const active = await this.jobs.countActive();
    const desired = Math.min(this.maxPerCycle, Math.max(0, this.targetActive - active));
    if (!desired) return;
    for (let index = 0; index < desired; index += 1) {
      const snapshot = await this.fleet.listVehicles({ stale: false });
      const vehicles: DispatchVehicle[] = snapshot.data.filter((vehicle) => !vehicle.activeRoute).map((vehicle) => ({ id: vehicle.vehicleId, coordinate: vehicle.coordinate,
        batteryPercentage: vehicle.batteryPercentage, status: vehicle.status,
      }));
      const result = await this.engine.assignOne(vehicles, this.world);
      if (!result) return;
    }
  }
}
