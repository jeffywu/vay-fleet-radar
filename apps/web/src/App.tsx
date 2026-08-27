import { useCallback, useState } from "react";
import type { Destination } from "@fleet-radar/world";
import { FleetMap } from "./components/FleetMap.tsx";

export function App() {
  const [selected, setSelected] = useState<Destination>();
  const [summary, setSummary] = useState({ destinations: 0, zones: 0 });
  const handleSelect = useCallback((destination: Destination) => setSelected(destination), []);
  const handleWorldLoad = useCallback((counts: typeof summary) => setSummary(counts), []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Operations</span>
          <h1>Fleet Radar</h1>
        </div>
        <span className="preview-badge"><i />World preview</span>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <section>
            <p className="section-label">Simulation world</p>
            <div className="metrics">
              <article><strong>{summary.destinations || "—"}</strong><span>Destinations</span></article>
              <article><strong>{summary.zones || "—"}</strong><span>Service zones</span></article>
            </div>
          </section>
          <section className="selection" aria-live="polite">
            <p className="section-label">Selected destination</p>
            {selected ? (
              <div>
                <strong>{selected.name}</strong>
                <code>{selected.id}</code>
                <span>{selected.serviceZoneId}</span>
                <small>{selected.coordinate[1].toFixed(5)}, {selected.coordinate[0].toFixed(5)}</small>
              </div>
            ) : <p>Choose an orange point on the map to inspect its world data.</p>}
          </section>
          <section className="checklist">
            <p className="section-label">Visual QA</p>
            <ul>
              <li>Nine zones tile the boundary</li>
              <li>Points cluster around the metro</li>
              <li>No destination falls outside</li>
              <li>Selection matches ID and zone</li>
            </ul>
          </section>
          <footer><span className="status-dot" />Static world data · Las Vegas</footer>
        </aside>
        <FleetMap onDestinationSelect={handleSelect} onWorldLoad={handleWorldLoad} />
      </div>
    </main>
  );
}

