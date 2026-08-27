import { LAS_VEGAS_BOUNDS, ZONE_IDS, type Bounds } from "./config.ts";
import type { Coordinate } from "./types.ts";

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (b[1] - a[1]) * radians;
  const longitudeDelta = (b[0] - a[0]) * radians;
  const startLatitude = a[1] * radians;
  const endLatitude = b[1] * radians;
  const h =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isInsideBounds(coordinate: Coordinate, bounds: Bounds = LAS_VEGAS_BOUNDS): boolean {
  return (
    coordinate[0] >= bounds.west &&
    coordinate[0] <= bounds.east &&
    coordinate[1] >= bounds.south &&
    coordinate[1] <= bounds.north
  );
}

/** Shared boundaries belong to the cell north and/or east of the boundary. */
export function serviceZoneIdFor(coordinate: Coordinate, bounds: Bounds = LAS_VEGAS_BOUNDS): string {
  if (!isInsideBounds(coordinate, bounds)) {
    throw new Error(`Coordinate [${coordinate.join(", ")}] is outside the service area`);
  }

  const longitudeStep = (bounds.east - bounds.west) / 3;
  const latitudeStep = (bounds.north - bounds.south) / 3;
  const column = coordinate[0] >= bounds.west + 2 * longitudeStep ? 2 : coordinate[0] >= bounds.west + longitudeStep ? 1 : 0;
  const row = coordinate[1] >= bounds.south + 2 * latitudeStep ? 0 : coordinate[1] >= bounds.south + latitudeStep ? 1 : 2;
  return ZONE_IDS[row * 3 + column];
}

export function hasMinimumSeparation(
  coordinate: Coordinate,
  accepted: readonly Coordinate[],
  minimumMeters: number,
): boolean {
  return accepted.every((other) => haversineMeters(coordinate, other) >= minimumMeters);
}
