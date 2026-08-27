import type { Coordinate, Destination } from "@fleet-radar/world";
import { haversineMeters } from "../movement.ts";
import { RoutingError } from "./errors.ts";
import type { PlannedRoute } from "./types.ts";

function coordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number" && Number.isFinite(part)) &&
    value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
}

export function validatePlannedRoute(route: unknown, origin: Coordinate, destination: Destination, toleranceMeters: number): PlannedRoute {
  if (!route || typeof route !== "object") throw new RoutingError("INVALID_RESPONSE");
  const value = route as Record<string, unknown>;
  const geometry = value.geometry as Record<string, unknown> | undefined;
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || !geometry.coordinates.every(coordinate)) {
    throw new RoutingError("INVALID_RESPONSE", "Routing provider returned invalid geometry");
  }
  if (typeof value.distanceMeters !== "number" || !Number.isFinite(value.distanceMeters) || value.distanceMeters <= 0 ||
      typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0) {
    throw new RoutingError("INVALID_RESPONSE", "Routing provider returned invalid metrics");
  }
  const coordinates = geometry.coordinates as [number, number][];
  if (haversineMeters(origin, coordinates[0]) > toleranceMeters || haversineMeters(destination.coordinate, coordinates.at(-1)!) > toleranceMeters) {
    throw new RoutingError("INVALID_RESPONSE", "Routing provider endpoints exceed snap tolerance");
  }
  return Object.freeze({
    geometry: Object.freeze({ type: "LineString", coordinates: Object.freeze(coordinates.map((point) => Object.freeze([...point]))) }),
    distanceMeters: value.distanceMeters,
    durationSeconds: value.durationSeconds,
  }) as PlannedRoute;
}
