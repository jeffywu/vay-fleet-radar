export type VehicleStatus = "FREE" | "WITH_CUSTOMER" | "EN_ROUTE";
export type Coordinate = readonly [longitude: number, latitude: number];

export type FleetEventPayloads = {
  "vehicle.telemetry-received": {
    readonly coordinate: Coordinate;
    readonly heading: number;
    readonly batteryPercentage: number;
    readonly status: VehicleStatus;
  };
  "route.assigned": {
    readonly routeId: string;
    readonly version: number;
    readonly destinationId: string;
    readonly assignmentState: "ACCEPTED" | "IN_PROGRESS";
  };
  "route.updated": {
    readonly routeId: string;
    readonly version: number;
    readonly destinationId: string;
  };
  "route.cancelled": {
    readonly routeId: string;
    readonly version: number;
    readonly reason?: string;
  };
  "route.completed": {
    readonly routeId: string;
    readonly version: number;
    readonly destinationId: string;
  };
  "route.assignment-rejected": {
    readonly routeId: string;
    readonly version: number;
    readonly destinationId: string;
    readonly reason: string;
  };
  "dispatch.assignment-requested": {
    readonly dispatchJobId: string;
    readonly commandId: string;
    readonly routeId: string;
    readonly routeVersion: number;
    readonly destinationId: string;
    readonly strategy: string;
    readonly reason?: string;
  };
  "dispatch.assignment-completed": {
    readonly dispatchJobId: string;
    readonly routeId: string;
    readonly routeVersion: number;
  };
};

export type FleetEventType = keyof FleetEventPayloads;

export type FleetEvent<TType extends FleetEventType = FleetEventType> = {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: 1;
  readonly vehicleId: string;
  /** Monotonically increasing for a vehicle across local application restarts. */
  readonly sequence: number;
  /** Producer time in ISO 8601 UTC. It is not used to determine freshness. */
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly payload: FleetEventPayloads[TType];
};

export type AnyFleetEvent = {
  [TType in FleetEventType]: FleetEvent<TType>;
}[FleetEventType];

export type ReceivedFleetEvent = AnyFleetEvent & {
  /** Backend ingestion time in ISO 8601 UTC. */
  readonly receivedAt: string;
};
