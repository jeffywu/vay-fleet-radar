import type { EventPublisher, FleetEventFactory, VehicleStatus } from "@fleet-radar/domain/events";
import type { Coordinate } from "@fleet-radar/world";

export class SimulationEventEmitter {
  constructor(private readonly events: EventPublisher, private readonly factory: FleetEventFactory) {}

  publishTelemetry(input: { vehicleId: string; coordinate: Coordinate; heading: number; batteryPercentage: number; status: VehicleStatus; occurredAt?: string }): Promise<void> {
    return this.events.publish(this.factory.create({ eventType: "vehicle.telemetry-received", vehicleId: input.vehicleId, occurredAt: input.occurredAt,
      payload: { coordinate: input.coordinate, heading: input.heading, batteryPercentage: input.batteryPercentage, status: input.status } }));
  }
  publishRouteAssigned(input: { vehicleId: string; routeId: string; version: number; destinationId: string; dispatchJobId: string }): Promise<void> {
    return this.events.publish(this.factory.create({ eventType: "route.assigned", vehicleId: input.vehicleId, correlationId: input.dispatchJobId,
      payload: { routeId: input.routeId, version: input.version, destinationId: input.destinationId, assignmentState: "ACCEPTED" } }));
  }
  publishRouteCompleted(input: { vehicleId: string; routeId: string; version: number; destinationId: string; dispatchJobId?: string }): Promise<void> {
    return this.events.publish(this.factory.create({ eventType: "route.completed", vehicleId: input.vehicleId, correlationId: input.dispatchJobId,
      payload: { routeId: input.routeId, version: input.version, destinationId: input.destinationId } }));
  }
  publishRouteCancelled(input: { vehicleId: string; routeId: string; version: number; dispatchJobId?: string; reason?: string }): Promise<void> {
    return this.events.publish(this.factory.create({ eventType: "route.cancelled", vehicleId: input.vehicleId, correlationId: input.dispatchJobId,
      payload: { routeId: input.routeId, version: input.version, reason: input.reason } }));
  }
  publishAssignmentRejected(input: { vehicleId: string; routeId: string; version: number; destinationId: string; dispatchJobId: string; reason: string }): Promise<void> {
    return this.events.publish(this.factory.create({ eventType: "route.assignment-rejected", vehicleId: input.vehicleId, correlationId: input.dispatchJobId,
      payload: { routeId: input.routeId, version: input.version, destinationId: input.destinationId, reason: input.reason } }));
  }
}
