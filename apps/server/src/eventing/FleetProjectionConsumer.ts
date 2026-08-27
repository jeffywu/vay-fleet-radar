import type {
  AnyFleetEvent,
  EventSource,
  ReceivedFleetEvent,
  Unsubscribe,
  VehicleStatus,
} from "@fleet-radar/domain/events";
import { parseFleetEvent } from "@fleet-radar/domain/events";

export type VehicleProjection = {
  readonly vehicleId: string;
  readonly coordinate: readonly [number, number];
  readonly heading: number;
  readonly batteryPercentage: number;
  readonly status: VehicleStatus;
  readonly lastSequence: number;
  readonly lastOccurredAt: string;
  readonly lastReceivedAt: string;
};

export type RouteProjection = {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly version: number;
  readonly destinationId: string;
  readonly state: "ACCEPTED" | "IN_PROGRESS";
  readonly updatedAt: string;
};

export type DispatchProjection = {
  readonly dispatchJobId: string;
  readonly commandId?: string;
  readonly vehicleId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly destinationId?: string;
  readonly strategy?: string;
  readonly state: "REQUESTED" | "COMPLETED";
  readonly updatedAt: string;
};

/** In-memory MVP consumer mirroring append-then-project database semantics. */
export class FleetProjectionConsumer {
  private readonly acceptedEventIds = new Set<string>();
  private readonly events: ReceivedFleetEvent[] = [];
  private readonly vehicles = new Map<string, VehicleProjection>();
  private readonly routes = new Map<string, RouteProjection>();
  private readonly dispatchJobs = new Map<string, DispatchProjection>();
  private unsubscribe?: Unsubscribe;

  constructor(
    private readonly source: EventSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.source.subscribe((event) => this.consume(event));
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe?.();
  }

  async consume(event: AnyFleetEvent): Promise<void> {
    const parsed = parseFleetEvent(event);
    if (this.acceptedEventIds.has(parsed.eventId)) return;

    const receivedAt = this.now().toISOString();
    const received = { ...parsed, receivedAt } as ReceivedFleetEvent;
    this.events.push(received);
    this.acceptedEventIds.add(event.eventId);
    this.project(received);
  }

  eventLog(): readonly ReceivedFleetEvent[] {
    return this.events.map((event) => structuredClone(event));
  }

  vehicle(vehicleId: string): VehicleProjection | undefined {
    const value = this.vehicles.get(vehicleId);
    return value ? structuredClone(value) : undefined;
  }

  route(vehicleId: string): RouteProjection | undefined {
    const value = this.routes.get(vehicleId);
    return value ? structuredClone(value) : undefined;
  }

  dispatchJob(jobId: string): DispatchProjection | undefined {
    const value = this.dispatchJobs.get(jobId);
    return value ? structuredClone(value) : undefined;
  }

  private project(event: ReceivedFleetEvent): void {
    switch (event.eventType) {
      case "vehicle.telemetry-received": {
        const current = this.vehicles.get(event.vehicleId);
        if (current && event.sequence <= current.lastSequence) return;
        this.vehicles.set(event.vehicleId, {
          vehicleId: event.vehicleId,
          coordinate: event.payload.coordinate,
          heading: event.payload.heading,
          batteryPercentage: event.payload.batteryPercentage,
          status: event.payload.status,
          lastSequence: event.sequence,
          lastOccurredAt: event.occurredAt,
          lastReceivedAt: event.receivedAt,
        });
        return;
      }
      case "route.assigned":
      case "route.updated": {
        const current = this.routes.get(event.vehicleId);
        if (current && event.payload.version <= current.version) return;
        this.routes.set(event.vehicleId, {
          vehicleId: event.vehicleId,
          routeId: event.payload.routeId,
          version: event.payload.version,
          destinationId: event.payload.destinationId,
          state: event.eventType === "route.assigned" ? event.payload.assignmentState : "IN_PROGRESS",
          updatedAt: event.receivedAt,
        });
        return;
      }
      case "route.cancelled":
      case "route.completed": {
        const current = this.routes.get(event.vehicleId);
        if (current && current.routeId === event.payload.routeId && event.payload.version >= current.version) {
          this.routes.delete(event.vehicleId);
        }
        return;
      }
      case "dispatch.assignment-requested":
        this.dispatchJobs.set(event.payload.dispatchJobId, {
          dispatchJobId: event.payload.dispatchJobId,
          commandId: event.payload.commandId,
          vehicleId: event.vehicleId,
          routeId: event.payload.routeId,
          routeVersion: event.payload.routeVersion,
          destinationId: event.payload.destinationId,
          strategy: event.payload.strategy,
          state: "REQUESTED",
          updatedAt: event.receivedAt,
        });
        return;
      case "dispatch.assignment-completed": {
        const current = this.dispatchJobs.get(event.payload.dispatchJobId);
        this.dispatchJobs.set(event.payload.dispatchJobId, {
          dispatchJobId: event.payload.dispatchJobId,
          ...(current?.commandId === undefined ? {} : { commandId: current.commandId }),
          vehicleId: event.vehicleId,
          routeId: event.payload.routeId,
          routeVersion: event.payload.routeVersion,
          ...(current?.destinationId === undefined ? {} : { destinationId: current.destinationId }),
          ...(current?.strategy === undefined ? {} : { strategy: current.strategy }),
          state: "COMPLETED",
          updatedAt: event.receivedAt,
        });
        return;
      }
      case "route.assignment-rejected":
        return;
    }
  }
}
