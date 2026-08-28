import { describe, expect, it } from "vitest";
import type { VehicleMapRecord } from "../api/contracts.ts";
import { fleetDestinationsToGeoJson, fleetRoutesToGeoJson } from "../lib/fleetRoutesToGeoJson.ts";

const vehicle: VehicleMapRecord = { vehicleId: "vehicle-1", coordinate: [-115.17, 36.12], heading: 90,
  batteryPercentage: 70, status: "EN_ROUTE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z",
  lastReceivedAt: "2026-01-01T00:00:01.000Z", activeRoute: { routeId: "route-1", version: 1,
    destinationId: "dst-1", state: "ACCEPTED", geometryAvailable: true,
    geometry: { type: "LineString", coordinates: [[-115.17, 36.12], [-115.14, 36.17]] } } };
const destination = { id: "dst-1", name: "Downtown Las Vegas", coordinate: [-115.14, 36.17] as const, serviceZoneId: "zone-c" };

describe("fleet route GeoJSON", () => {
  it("renders active geometry and the catalog destination for en-route vehicles", () => {
    expect(fleetRoutesToGeoJson([vehicle]).features[0]).toMatchObject({ id: "route-1", geometry: vehicle.activeRoute?.geometry });
    expect(fleetDestinationsToGeoJson([vehicle], [destination]).features[0]).toMatchObject({
      geometry: { coordinates: destination.coordinate }, properties: { destinationName: destination.name },
    });
  });

  it("does not render stale route metadata for a non-en-route vehicle", () => {
    const free = { ...vehicle, status: "FREE" as const };
    expect(fleetRoutesToGeoJson([free]).features).toEqual([]);
    expect(fleetDestinationsToGeoJson([free], [destination]).features).toEqual([]);
  });
});
