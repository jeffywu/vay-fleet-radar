import { useMemo, useState } from "react";
import { vehicleStatuses, type VehicleStatus } from "./api/contracts.ts";
import { FleetConnection } from "./components/FleetConnection.tsx";
import { FleetMap } from "./components/FleetMap.tsx";
import { VehicleFilters } from "./components/VehicleFilters.tsx";
import { useFleetFeed } from "./hooks/useFleetFeed.ts";
import { filterVehicles } from "./lib/filterVehicles.ts";

export function App() {
  const fleet = useFleetFeed();
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<VehicleStatus>>(() => new Set(vehicleStatuses));
  const [lowBatteryOnly, setLowBatteryOnly] = useState(false);
  const visibleVehicles = useMemo(() => filterVehicles(fleet.vehicles, { statuses: selectedStatuses, lowBatteryOnly }),
    [fleet.vehicles, lowBatteryOnly, selectedStatuses]);

  const changeStatus = (status: VehicleStatus, selected: boolean) => {
    setSelectedStatuses((current) => {
      const next = new Set(current);
      if (selected) next.add(status);
      else next.delete(status);
      return next;
    });
  };

  return <main className="app-shell">
    <header className="topbar">
      <div><span className="eyebrow">Operations</span><h1>Fleet Radar</h1></div>
      <FleetConnection state={fleet.connectionState} count={fleet.vehicles.length} errorMessage={fleet.errorMessage} onRetry={fleet.retry} />
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <section><p className="section-label">Vehicle status</p><div className="status-legend" aria-label="Vehicle status legend">
          <span><i className="vehicle-key vehicle-key--free" />Free</span>
          <span><i className="vehicle-key vehicle-key--customer" />With customer</span>
          <span><i className="vehicle-key vehicle-key--route" />En route</span>
          <span><i className="vehicle-key vehicle-key--stale" />Stale telemetry</span>
        </div>
          <div className="route-legend" aria-label="Active route legend">
            <span><i className="route-key" />Active route</span>
            <span><i className="destination-key" />Final destination</span>
          </div>
          <div className="filter-divider" />
          <p className="section-label">Map filters</p>
          <VehicleFilters selectedStatuses={selectedStatuses} lowBatteryOnly={lowBatteryOnly}
            visibleCount={visibleVehicles.length} totalCount={fleet.vehicles.length}
            onStatusChange={changeStatus} onLowBatteryChange={setLowBatteryOnly} />
        </section>
        <section className="map-context"><p className="section-label">Map context</p>
          <p>Las Vegas service area and operating zones. Vehicle arrows point in their current heading.</p></section>
        <footer>Committed telemetry · Real-time feed</footer>
      </aside>
      <FleetMap vehicles={visibleVehicles} staleAfterSeconds={fleet.staleAfterSeconds} />
    </div>
  </main>;
}
