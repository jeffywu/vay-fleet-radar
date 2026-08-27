import { describe, expect, it } from "vitest";
import type { VehicleMapRecord } from "../api/contracts.ts";
import { vehiclesToGeoJson } from "../lib/vehiclesToGeoJson.ts";

const record: VehicleMapRecord = { vehicleId: "vehicle-1", coordinate: [-115.17, 36.12], heading: 45, batteryPercentage: 51,
  status: "EN_ROUTE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z", lastReceivedAt: "2026-01-01T00:00:10.000Z" };

describe("vehiclesToGeoJson", () => {
  it("creates stable feature IDs with status, heading, and freshness properties", () => {
    const data = vehiclesToGeoJson([record], 30, Date.parse("2026-01-01T00:00:20.000Z"));
    expect(data.features[0]).toEqual({ type: "Feature", id: "vehicle-1", geometry: { type: "Point", coordinates: [-115.17, 36.12] },
      properties: { vehicleId: "vehicle-1", heading: 45, batteryPercentage: 51, status: "EN_ROUTE", serviceZoneId: "zone-c",
        isStale: false, lastReceivedAt: "2026-01-01T00:00:10.000Z" } });
  });

  it("ages a vehicle from fresh to stale using backend receipt time", () => {
    expect(vehiclesToGeoJson([record], 30, Date.parse("2026-01-01T00:00:40.000Z")).features[0]?.properties.isStale).toBe(false);
    expect(vehiclesToGeoJson([record], 30, Date.parse("2026-01-01T00:00:40.001Z")).features[0]?.properties.isStale).toBe(true);
  });
});
