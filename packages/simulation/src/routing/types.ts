import type { LineString } from "geojson";
import type { Coordinate, Destination } from "@fleet-radar/world";

export type PlannedRoute = {
  readonly geometry: LineString;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
};

export interface RoutingPort {
  planRoute(origin: Coordinate, destination: Destination, signal?: AbortSignal): Promise<PlannedRoute>;
}

export type RoutingMetrics = {
  readonly attempts: number;
  readonly successes: number;
  readonly failures: Readonly<Record<string, number>>;
  readonly retries: number;
  readonly inFlight: number;
  readonly totalLatencyMs: number;
  readonly remainingBudget: number;
};
