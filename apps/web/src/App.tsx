import { FleetConnection } from "./components/FleetConnection.tsx";
import { FleetMap } from "./components/FleetMap.tsx";
import { useFleetFeed } from "./hooks/useFleetFeed.ts";

export function App() {
  const fleet = useFleetFeed();
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
        </div></section>
        <section className="map-context"><p className="section-label">Map context</p>
          <p>Las Vegas service area and operating zones. Vehicle arrows point in their current heading.</p></section>
        <footer>Committed telemetry · Real-time feed</footer>
      </aside>
      <FleetMap vehicles={fleet.vehicles} staleAfterSeconds={fleet.staleAfterSeconds} />
    </div>
  </main>;
}
