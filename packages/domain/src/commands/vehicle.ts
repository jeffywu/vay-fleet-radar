export type AssignRouteCommand = {
  readonly commandId: string;
  readonly dispatchJobId: string;
  readonly vehicleId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly destinationId: string;
};

export type CancelRouteCommand = {
  readonly commandId: string;
  readonly vehicleId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly reason?: string;
};

export type AssignmentRejectionReason =
  | "UNKNOWN_VEHICLE"
  | "UNKNOWN_DESTINATION"
  | "VEHICLE_BUSY"
  | "ROUTE_PENDING"
  | "RECHARGING"
  | "LOW_BATTERY"
  | "STALE_ROUTE_VERSION"
  | "ROUTING_UNAVAILABLE"
  | "INSUFFICIENT_RANGE"
  | "SHUTTING_DOWN";

export type AssignmentResult =
  | { readonly accepted: true; readonly routeId: string; readonly routeVersion: number }
  | { readonly accepted: false; readonly reason: AssignmentRejectionReason };

export type CancellationResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly reason: "UNKNOWN_VEHICLE" | "ROUTE_NOT_ACTIVE" | "STALE_ROUTE_VERSION" | "SHUTTING_DOWN" };

export interface VehicleCommandPort {
  assignRoute(command: AssignRouteCommand): Promise<AssignmentResult>;
  cancelRoute(command: CancelRouteCommand): Promise<CancellationResult>;
}
