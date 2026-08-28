import { vehicleStatuses, type VehicleStatus } from "../api/contracts.ts";

const statusLabels: Record<VehicleStatus, string> = {
  FREE: "Free",
  WITH_CUSTOMER: "With customer",
  EN_ROUTE: "En route",
};

type VehicleFiltersProps = {
  readonly selectedStatuses: ReadonlySet<VehicleStatus>;
  readonly lowBatteryOnly: boolean;
  readonly visibleCount: number;
  readonly totalCount: number;
  readonly onStatusChange: (status: VehicleStatus, selected: boolean) => void;
  readonly onLowBatteryChange: (selected: boolean) => void;
};

export function VehicleFilters({ selectedStatuses, lowBatteryOnly, visibleCount, totalCount,
  onStatusChange, onLowBatteryChange }: VehicleFiltersProps) {
  return <div className="vehicle-filters">
    <fieldset>
      <legend>Status</legend>
      {vehicleStatuses.map((status) => <label key={status}>
        <input type="checkbox" checked={selectedStatuses.has(status)}
          onChange={(event) => onStatusChange(status, event.currentTarget.checked)} />
        <span>{statusLabels[status]}</span>
      </label>)}
    </fieldset>
    <fieldset>
      <legend>Battery</legend>
      <label><input type="checkbox" checked={lowBatteryOnly}
        onChange={(event) => onLowBatteryChange(event.currentTarget.checked)} />
        <span>Below 20%</span>
      </label>
    </fieldset>
    <p className="filter-count" aria-live="polite">Showing {visibleCount} of {totalCount}</p>
  </div>;
}
