import { LAS_VEGAS_BOUNDS, MIN_DESTINATION_SEPARATION_METERS, ZONE_IDS, type Bounds } from "./config.ts";
import { haversineMeters, isInsideBounds, serviceZoneIdFor } from "./geometry.ts";
import type { Coordinate, Destination, PolygonFeature, PolygonFeatureCollection, WorldData } from "./types.ts";

function fail(message: string): never {
  throw new Error(`Invalid simulation world: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  return value as Record<string, unknown>;
}

function coordinate(value: unknown, label: string): Coordinate {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    fail(`${label} must be a finite [longitude, latitude] pair`);
  }
  const parsed = value as unknown as Coordinate;
  if (parsed[0] < -180 || parsed[0] > 180 || parsed[1] < -90 || parsed[1] > 90) fail(`${label} is outside WGS84 ranges`);
  return parsed;
}

function polygonFeature(value: unknown, label: string): PolygonFeature {
  const feature = record(value);
  if (feature.type !== "Feature") fail(`${label} must be a GeoJSON Feature`);
  const properties = record(feature.properties);
  if (typeof properties.id !== "string" || typeof properties.name !== "string") fail(`${label} needs string id and name properties`);
  const geometry = record(feature.geometry);
  if (geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
    fail(`${label} must contain one Polygon ring`);
  }
  const rawRing = geometry.coordinates[0];
  if (!Array.isArray(rawRing) || rawRing.length < 4) fail(`${label} Polygon ring is too short`);
  const ring = rawRing.map((item, index) => coordinate(item, `${label} coordinate ${index}`));
  const first = ring[0];
  const last = ring.at(-1);
  if (!last || first[0] !== last[0] || first[1] !== last[1]) fail(`${label} Polygon ring must be closed`);
  return value as PolygonFeature;
}

function boundsOf(feature: PolygonFeature): Bounds {
  const ring = feature.geometry.coordinates[0];
  const longitudes = ring.map((item) => item[0]);
  const latitudes = ring.map((item) => item[1]);
  return { west: Math.min(...longitudes), south: Math.min(...latitudes), east: Math.max(...longitudes), north: Math.max(...latitudes) };
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-10;
}

function validateZoneGrid(zone: PolygonFeature, index: number, areaBounds: Bounds): void {
  const row = Math.floor(index / 3);
  const column = index % 3;
  const longitudeStep = (areaBounds.east - areaBounds.west) / 3;
  const latitudeStep = (areaBounds.north - areaBounds.south) / 3;
  const expected: Bounds = {
    west: areaBounds.west + column * longitudeStep,
    east: areaBounds.west + (column + 1) * longitudeStep,
    north: areaBounds.north - row * latitudeStep,
    south: areaBounds.north - (row + 1) * latitudeStep,
  };
  const actual = boundsOf(zone);
  if (
    !approximatelyEqual(actual.west, expected.west) ||
    !approximatelyEqual(actual.east, expected.east) ||
    !approximatelyEqual(actual.south, expected.south) ||
    !approximatelyEqual(actual.north, expected.north)
  ) fail(`service zone ${zone.properties.id} does not tile its configured grid cell`);
  const ring = zone.geometry.coordinates[0];
  if (ring.length !== 5 || ring.some(([longitude, latitude]) =>
    (!approximatelyEqual(longitude, expected.west) && !approximatelyEqual(longitude, expected.east)) ||
    (!approximatelyEqual(latitude, expected.south) && !approximatelyEqual(latitude, expected.north)))) {
    fail(`service zone ${zone.properties.id} must be a rectangular grid cell`);
  }
}

function destination(value: unknown, index: number): Destination {
  const item = record(value);
  if (typeof item.id !== "string" || !/^dst-lv-\d{4}$/.test(item.id)) fail(`destination ${index} has an invalid id`);
  if (typeof item.name !== "string" || item.name.length === 0) fail(`destination ${index} has an invalid name`);
  if (typeof item.serviceZoneId !== "string") fail(`destination ${item.id} has an invalid serviceZoneId`);
  return { id: item.id, name: item.name, coordinate: coordinate(item.coordinate, `destination ${item.id}`), serviceZoneId: item.serviceZoneId };
}

export function parseWorldData(serviceAreaValue: unknown, zonesValue: unknown, destinationsValue: unknown): WorldData {
  const serviceArea = polygonFeature(serviceAreaValue, "service area");
  const zonesObject = record(zonesValue);
  if (zonesObject.type !== "FeatureCollection" || !Array.isArray(zonesObject.features)) fail("service zones must be a FeatureCollection");
  const serviceZones: PolygonFeatureCollection = {
    type: "FeatureCollection",
    features: zonesObject.features.map((feature, index) => polygonFeature(feature, `service zone ${index}`)),
  };
  if (!Array.isArray(destinationsValue)) fail("destinations must be an array");
  const destinations = destinationsValue.map(destination);
  const world = { serviceArea, serviceZones, destinations };
  validateWorld(world);
  return world;
}

export function validateWorld(world: WorldData): void {
  const serviceArea = polygonFeature(world.serviceArea, "service area");
  const areaBounds = boundsOf(serviceArea);
  if (JSON.stringify(areaBounds) !== JSON.stringify(LAS_VEGAS_BOUNDS)) fail("service area does not match the configured Las Vegas bounds");

  if (world.serviceZones.type !== "FeatureCollection" || world.serviceZones.features.length !== 9) fail("exactly nine service zones are required");
  const zoneIds = world.serviceZones.features.map((zone, index) => polygonFeature(zone, `service zone ${index}`).properties.id);
  if (new Set(zoneIds).size !== 9 || ZONE_IDS.some((id) => !zoneIds.includes(id))) fail("service zone IDs must match the configured 3×3 grid");
  for (const [index, zone] of world.serviceZones.features.entries()) {
    if (zone.properties.id !== ZONE_IDS[index]) fail("service zones must use north-to-south, west-to-east order");
    for (const point of zone.geometry.coordinates[0]) if (!isInsideBounds(point, areaBounds)) fail(`service zone ${zone.properties.id} is outside the service area`);
    validateZoneGrid(zone, index, areaBounds);
  }

  if (world.destinations.length !== 200) fail(`exactly 200 destinations are required; received ${world.destinations.length}`);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let index = 0; index < world.destinations.length; index += 1) {
    const item = destination(world.destinations[index], index);
    if (ids.has(item.id)) fail(`duplicate destination id ${item.id}`);
    if (names.has(item.name)) fail(`duplicate destination name ${item.name}`);
    ids.add(item.id);
    names.add(item.name);
  }
  for (let index = 0; index < world.destinations.length; index += 1) {
    const item = destination(world.destinations[index], index);
    const expectedId = `dst-lv-${String(index + 1).padStart(4, "0")}`;
    if (item.id !== expectedId) fail(`destinations must be sorted by ID; expected ${expectedId} at index ${index}`);
    if (!isInsideBounds(item.coordinate, areaBounds)) fail(`destination ${item.id} is outside the service area`);
    const expectedZone = serviceZoneIdFor(item.coordinate, areaBounds);
    if (item.serviceZoneId !== expectedZone) fail(`destination ${item.id} belongs to ${expectedZone}, not ${item.serviceZoneId}`);
  }
  for (let left = 0; left < world.destinations.length; left += 1) {
    for (let right = left + 1; right < world.destinations.length; right += 1) {
      const distance = haversineMeters(world.destinations[left].coordinate, world.destinations[right].coordinate);
      if (distance < MIN_DESTINATION_SEPARATION_METERS) {
        fail(`destinations ${world.destinations[left].id} and ${world.destinations[right].id} are ${distance.toFixed(1)}m apart`);
      }
    }
  }
}
