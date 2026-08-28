import type { VehicleMapRecord, VehicleStatus } from "../api/contracts.ts";

export type VehicleFilters = {
  readonly statuses: ReadonlySet<VehicleStatus>;
  readonly lowBatteryOnly: boolean;
};

export function filterVehicles(vehicles: readonly VehicleMapRecord[], filters: VehicleFilters): VehicleMapRecord[] {
  return vehicles.filter((vehicle) => filters.statuses.has(vehicle.status) &&
    (!filters.lowBatteryOnly || vehicle.batteryPercentage < 20));
}
