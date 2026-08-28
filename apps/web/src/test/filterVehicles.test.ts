import { describe, expect, it } from "vitest";
import type { VehicleMapRecord } from "../api/contracts.ts";
import { filterVehicles } from "../lib/filterVehicles.ts";

const base: Omit<VehicleMapRecord, "vehicleId" | "status" | "batteryPercentage"> = {
  coordinate: [-115.17, 36.12], heading: 90, serviceZoneId: "zone-c",
  lastOccurredAt: "2026-01-01T00:00:00.000Z", lastReceivedAt: "2026-01-01T00:00:01.000Z",
};
const vehicles: VehicleMapRecord[] = [
  { ...base, vehicleId: "free-low", status: "FREE", batteryPercentage: 19.9 },
  { ...base, vehicleId: "free-threshold", status: "FREE", batteryPercentage: 20 },
  { ...base, vehicleId: "customer-low", status: "WITH_CUSTOMER", batteryPercentage: 10 },
  { ...base, vehicleId: "route-high", status: "EN_ROUTE", batteryPercentage: 75 },
];

describe("filterVehicles", () => {
  it("filters by selected statuses", () => {
    expect(filterVehicles(vehicles, { statuses: new Set(["FREE", "EN_ROUTE"]), lowBatteryOnly: false })
      .map(({ vehicleId }) => vehicleId)).toEqual(["free-low", "free-threshold", "route-high"]);
  });

  it("combines status and strictly-below-20 battery filters", () => {
    expect(filterVehicles(vehicles, { statuses: new Set(["FREE"]), lowBatteryOnly: true })
      .map(({ vehicleId }) => vehicleId)).toEqual(["free-low"]);
  });

  it("returns no vehicles when no status is selected", () => {
    expect(filterVehicles(vehicles, { statuses: new Set(), lowBatteryOnly: false })).toEqual([]);
  });
});
