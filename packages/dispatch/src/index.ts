import type { Coordinate, Destination, WorldCatalogView } from "@fleet-radar/world";
import type { EventPublisher, FleetEventFactory } from "@fleet-radar/domain/events";

export type DispatchVehicle = {
  readonly id: string;
  readonly coordinate: Coordinate;
  readonly batteryPercentage: number;
  readonly status: "FREE" | "WITH_CUSTOMER" | "EN_ROUTE";
};

export type DispatchAssignment = {
  readonly vehicle: DispatchVehicle;
  readonly destination: Destination;
};

export type DispatchStrategy = {
  assign(vehicles: readonly DispatchVehicle[], world: WorldCatalogView): DispatchAssignment | undefined;
};

export class RandomDispatchStrategy implements DispatchStrategy {
  constructor(
    private readonly random: () => number,
    private readonly minimumBatteryPercentage = 20,
  ) {}

  assign(vehicles: readonly DispatchVehicle[], world: WorldCatalogView): DispatchAssignment | undefined {
    const eligible = vehicles.filter(
      (vehicle) => vehicle.status === "FREE" && vehicle.batteryPercentage >= this.minimumBatteryPercentage,
    );
    if (eligible.length === 0 || world.destinations.length === 0) return undefined;
    const vehicle = eligible[Math.min(eligible.length - 1, Math.floor(this.random() * eligible.length))];
    const destination = world.destinations[Math.min(world.destinations.length - 1, Math.floor(this.random() * world.destinations.length))];
    return { vehicle, destination };
  }
}

/** Publishes dispatcher-owned job facts through the shared domain boundary. */
export class DispatchEventEmitter {
  constructor(
    private readonly events: EventPublisher,
    private readonly factory: FleetEventFactory,
  ) {}

  publishAssignmentRequested(input: {
    dispatchJobId: string;
    vehicleId: string;
    routeId: string;
    routeVersion: number;
    destinationId: string;
    strategy: string;
    reason?: string;
  }): Promise<void> {
    return this.events.publish(this.factory.create({
      eventType: "dispatch.assignment-requested",
      vehicleId: input.vehicleId,
      correlationId: input.dispatchJobId,
      payload: {
        dispatchJobId: input.dispatchJobId,
        routeId: input.routeId,
        routeVersion: input.routeVersion,
        destinationId: input.destinationId,
        strategy: input.strategy,
        reason: input.reason,
      },
    }));
  }

  publishAssignmentCompleted(input: {
    dispatchJobId: string;
    vehicleId: string;
    routeId: string;
    routeVersion: number;
  }): Promise<void> {
    return this.events.publish(this.factory.create({
      eventType: "dispatch.assignment-completed",
      vehicleId: input.vehicleId,
      correlationId: input.dispatchJobId,
      payload: {
        dispatchJobId: input.dispatchJobId,
        routeId: input.routeId,
        routeVersion: input.routeVersion,
      },
    }));
  }
}
