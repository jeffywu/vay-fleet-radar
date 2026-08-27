import type { VehicleStatus } from "@fleet-radar/domain/events";

export type RouteDto = { routeId: string; version: number; destinationId: string; state: "ACCEPTED" | "IN_PROGRESS"; geometryAvailable: boolean };
export type VehicleDto = { vehicleId: string; coordinate: [number, number]; heading: number; batteryPercentage: number; status: VehicleStatus; serviceZoneId: string; lastOccurredAt: string; lastReceivedAt: string; isStale: boolean; activeRoute?: RouteDto };
export type DispatchJobDto = { dispatchJobId: string; vehicleId: string; routeId: string; routeVersion: number; destinationId: string; strategy: string; decisionReason?: string; commandId: string; correlationId: string; state: string; requestedAt: string; acceptedAt?: string; startedAt?: string; completedAt?: string; updatedAt: string };
export type ProjectionUpdate = { streamId: string; eventId: string; updateType: "vehicle.updated" | "route.updated" | "route.removed" | "dispatch-job.updated"; aggregateId: string; payload: unknown; createdAt: string };
