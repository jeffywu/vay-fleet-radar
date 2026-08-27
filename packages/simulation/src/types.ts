import type { VehicleStatus } from "@fleet-radar/domain/events";
import type { Coordinate } from "@fleet-radar/world";
import type { PlannedRoute } from "./routing/types.ts";

export type MovementPurpose = "CUSTOMER" | "DISPATCH";

export type ActiveMovement = {
  readonly purpose: MovementPurpose;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly destinationId: string;
  readonly dispatchJobId?: string;
  readonly route: PlannedRoute;
  elapsedSeconds: number;
  distanceTravelledMeters: number;
};

export type PendingMovement = {
  readonly purpose: MovementPurpose;
  readonly commandId?: string;
};

export type SimulatedVehicle = {
  readonly id: string;
  coordinate: Coordinate;
  heading: number;
  batteryPercentage: number;
  status: VehicleStatus;
  currentDestinationId: string;
  freeSinceSimulatedMs: number;
  pendingMovement?: PendingMovement;
  activeMovement?: ActiveMovement;
  telemetryGapUntilSimulatedMs?: number;
  rechargeUntilSimulatedMs?: number;
  customerBackoffUntilSimulatedMs?: number;
};

export type VehicleSnapshot = Readonly<Omit<SimulatedVehicle, "pendingMovement" | "activeMovement">> & {
  readonly routePending: boolean;
  readonly activeRouteId?: string;
};
