import { parseWorldData, type Destination, type PolygonFeature, type PolygonFeatureCollection, type WorldData } from "@fleet-radar/world";

export type DestinationProperties = Pick<Destination, "id" | "name" | "serviceZoneId">;
export type DestinationFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, DestinationProperties>;

async function fetchJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Could not load ${label} (${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export async function fetchWorld(signal?: AbortSignal): Promise<WorldData> {
  const [serviceArea, serviceZones, destinations] = await Promise.all([
    fetchJson("/world/service-area.geojson", "service area", signal),
    fetchJson("/world/service-zones.geojson", "service zones", signal),
    fetchJson("/world/destinations.json", "destinations", signal),
  ]);
  return parseWorldData(serviceArea, serviceZones, destinations);
}

export function destinationsToGeoJson(destinations: readonly Destination[]): DestinationFeatureCollection {
  return {
    type: "FeatureCollection",
    features: destinations.map(({ id, name, coordinate, serviceZoneId }) => ({
      type: "Feature",
      id,
      properties: { id, name, serviceZoneId },
      geometry: { type: "Point", coordinates: [...coordinate] },
    })),
  };
}

export function mapboxPolygon(feature: PolygonFeature): GeoJSON.Feature<GeoJSON.Polygon> {
  return feature as unknown as GeoJSON.Feature<GeoJSON.Polygon>;
}

export function mapboxPolygonCollection(collection: PolygonFeatureCollection): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return collection as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon>;
}

