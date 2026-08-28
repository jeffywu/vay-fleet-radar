import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { Destination } from "@fleet-radar/world";
import type { VehicleMapRecord } from "../api/contracts.ts";

type RouteProperties = { vehicleId: string; routeId: string; destinationId: string };
type DestinationProperties = RouteProperties & { destinationName: string };

export type FleetRouteFeatureCollection = FeatureCollection<LineString, RouteProperties>;
export type FleetDestinationFeatureCollection = FeatureCollection<Point, DestinationProperties>;

export function fleetRoutesToGeoJson(vehicles: readonly VehicleMapRecord[]): FleetRouteFeatureCollection {
  return {
    type: "FeatureCollection",
    features: vehicles.flatMap((vehicle): Feature<LineString, RouteProperties>[] => {
      const route = vehicle.status === "EN_ROUTE" ? vehicle.activeRoute : undefined;
      if (!route?.geometry) return [];
      return [{ type: "Feature", id: route.routeId, geometry: route.geometry,
        properties: { vehicleId: vehicle.vehicleId, routeId: route.routeId, destinationId: route.destinationId } }];
    }),
  };
}

export function fleetDestinationsToGeoJson(vehicles: readonly VehicleMapRecord[],
  destinations: readonly Destination[]): FleetDestinationFeatureCollection {
  const byId = new Map(destinations.map((destination) => [destination.id, destination]));
  return {
    type: "FeatureCollection",
    features: vehicles.flatMap((vehicle): Feature<Point, DestinationProperties>[] => {
      const route = vehicle.status === "EN_ROUTE" ? vehicle.activeRoute : undefined;
      const destination = route ? byId.get(route.destinationId) : undefined;
      if (!route || !destination) return [];
      return [{ type: "Feature", id: route.routeId, geometry: { type: "Point", coordinates: [...destination.coordinate] },
        properties: { vehicleId: vehicle.vehicleId, routeId: route.routeId, destinationId: destination.id,
          destinationName: destination.name } }];
    }),
  };
}
