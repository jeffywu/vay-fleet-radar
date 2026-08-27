import type { Feature, FeatureCollection, Point } from "geojson";
import type { VehicleMapRecord } from "../api/contracts.ts";

export type VehicleFeatureProperties = {
  vehicleId: string;
  heading: number;
  batteryPercentage: number;
  status: VehicleMapRecord["status"];
  serviceZoneId: string;
  isStale: boolean;
  lastReceivedAt: string;
};

export type VehicleFeatureCollection = FeatureCollection<Point, VehicleFeatureProperties>;

export function vehiclesToGeoJson(vehicles: readonly VehicleMapRecord[], staleAfterSeconds: number,
  now = Date.now()): VehicleFeatureCollection {
  return {
    type: "FeatureCollection",
    features: vehicles.map((vehicle): Feature<Point, VehicleFeatureProperties> => ({
      type: "Feature",
      id: vehicle.vehicleId,
      geometry: { type: "Point", coordinates: [...vehicle.coordinate] },
      properties: {
        vehicleId: vehicle.vehicleId,
        heading: vehicle.heading,
        batteryPercentage: vehicle.batteryPercentage,
        status: vehicle.status,
        serviceZoneId: vehicle.serviceZoneId,
        isStale: Date.parse(vehicle.lastReceivedAt) < now - staleAfterSeconds * 1_000,
        lastReceivedAt: vehicle.lastReceivedAt,
      },
    })),
  };
}
