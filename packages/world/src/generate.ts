import {
  DEFAULT_WORLD_SEED,
  LAS_VEGAS_BOUNDS,
  MIN_DESTINATION_SEPARATION_METERS,
  SAMPLING_REGIONS,
  ZONE_IDS,
  rectangleRing,
  type SamplingRegion,
} from "./config.ts";
import { hasMinimumSeparation, serviceZoneIdFor } from "./geometry.ts";
import { seededRandom } from "./prng.ts";
import type { Coordinate, Destination, PolygonFeature, PolygonFeatureCollection, WorldData } from "./types.ts";
import { validateWorld } from "./validate.ts";

export type GeneratedDestination = Destination & { readonly samplingRegionId: string };
export type GeneratedWorld = WorldData & { readonly generatedDestinations: readonly GeneratedDestination[] };

export function createServiceArea(): PolygonFeature {
  return {
    type: "Feature",
    properties: { id: "las-vegas-metro", name: "Las Vegas Metro Demo Area" },
    geometry: { type: "Polygon", coordinates: [rectangleRing(LAS_VEGAS_BOUNDS)] },
  };
}

export function createServiceZones(): PolygonFeatureCollection {
  const longitudeStep = (LAS_VEGAS_BOUNDS.east - LAS_VEGAS_BOUNDS.west) / 3;
  const latitudeStep = (LAS_VEGAS_BOUNDS.north - LAS_VEGAS_BOUNDS.south) / 3;
  const features: PolygonFeature[] = [];

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const west = LAS_VEGAS_BOUNDS.west + column * longitudeStep;
      const east = west + longitudeStep;
      const north = LAS_VEGAS_BOUNDS.north - row * latitudeStep;
      const south = north - latitudeStep;
      const id = ZONE_IDS[row * 3 + column];
      features.push({
        type: "Feature",
        properties: { id, name: `Service zone ${id.replace("zone-", "").toUpperCase()}` },
        geometry: { type: "Polygon", coordinates: [rectangleRing({ west, south, east, north })] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function sampleRegion(
  region: SamplingRegion,
  random: () => number,
  accepted: GeneratedDestination[],
): void {
  let attempts = 0;
  let regionCount = 0;
  while (regionCount < region.count && attempts < 10_000) {
    attempts += 1;
    const coordinate: Coordinate = [
      region.west + random() * (region.east - region.west),
      region.south + random() * (region.north - region.south),
    ];
    if (!hasMinimumSeparation(coordinate, accepted.map((item) => item.coordinate), MIN_DESTINATION_SEPARATION_METERS)) {
      continue;
    }
    const index = accepted.length + 1;
    accepted.push({
      id: `dst-lv-${String(index).padStart(4, "0")}`,
      name: `LV Destination ${String(index).padStart(3, "0")}`,
      coordinate,
      serviceZoneId: serviceZoneIdFor(coordinate),
      samplingRegionId: region.id,
    });
    regionCount += 1;
  }
  if (regionCount !== region.count) {
    throw new Error(`Could not generate ${region.count} destinations for ${region.name} after 10,000 attempts`);
  }
}

export function generateWorld(seed = DEFAULT_WORLD_SEED): GeneratedWorld {
  const random = seededRandom(seed);
  const generatedDestinations: GeneratedDestination[] = [];
  for (const region of SAMPLING_REGIONS) sampleRegion(region, random, generatedDestinations);

  const destinations = generatedDestinations.map(({ samplingRegionId: _samplingRegionId, ...destination }) => destination);
  const world: WorldData = {
    serviceArea: createServiceArea(),
    serviceZones: createServiceZones(),
    destinations,
  };
  validateWorld(world);
  validateSamplingRegionCounts(generatedDestinations);
  return { ...world, generatedDestinations };
}

export function validateSamplingRegionCounts(destinations: readonly GeneratedDestination[]): void {
  for (const region of SAMPLING_REGIONS) {
    const count = destinations.filter((destination) => destination.samplingRegionId === region.id).length;
    if (count !== region.count) throw new Error(`Sampling region ${region.id} expected ${region.count} destinations, received ${count}`);
  }
}

export function roundedWorld(world: WorldData): WorldData {
  return {
    serviceArea: world.serviceArea,
    serviceZones: world.serviceZones,
    destinations: world.destinations.map((destination) => ({
      ...destination,
      coordinate: [Number(destination.coordinate[0].toFixed(6)), Number(destination.coordinate[1].toFixed(6))],
    })),
  };
}

