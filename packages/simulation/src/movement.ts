import type { Coordinate } from "@fleet-radar/world";

const EARTH_RADIUS_METERS = 6_371_000;
const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (value: number) => value * 180 / Math.PI;

export function haversineMeters(a: Coordinate, b: Coordinate): number {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(b[0] - a[0]);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function bearingDegrees(a: Coordinate, b: Coordinate): number {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const deltaLon = radians(b[0] - a[0]);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (degrees(Math.atan2(y, x)) + 360) % 360;
}

export function interpolateLine(coordinates: readonly Coordinate[], fraction: number): { coordinate: Coordinate; heading: number } {
  if (coordinates.length < 2) throw new TypeError("A route must have at least two coordinates");
  const lengths = coordinates.slice(1).map((point, index) => haversineMeters(coordinates[index], point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return { coordinate: coordinates[coordinates.length - 1], heading: 0 };
  let remaining = Math.max(0, Math.min(1, fraction)) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (length === 0) continue;
    if (remaining <= length || index === lengths.length - 1) {
      const start = coordinates[index];
      const end = coordinates[index + 1];
      const local = Math.min(1, remaining / length);
      return {
        coordinate: [start[0] + (end[0] - start[0]) * local, start[1] + (end[1] - start[1]) * local],
        heading: bearingDegrees(start, end),
      };
    }
    remaining -= length;
  }
  const last = coordinates.length - 1;
  return { coordinate: coordinates[last], heading: bearingDegrees(coordinates[last - 1], coordinates[last]) };
}
