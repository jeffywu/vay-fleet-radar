# MapBox Integration

This document defines where Mapbox is used in Fleet Radar, what the current public free tier provides, and how runtime routing interacts with persisted simulation and operational data.

Pricing and product terms were reviewed on August 27, 2026. They can change independently of this repository and must be rechecked before deployment. This is an architectural assessment, not legal advice.

## Decision Summary

The MVP uses two Mapbox products through separate adapters:

1. Mapbox GL JS renders the browser basemap and application-supplied GeoJSON.
2. Mapbox Directions generates an ephemeral route when a customer trip or dispatch assignment starts.

Approximately 200 destinations are persisted because they define the stable operating world. Routes are not persisted. A Directions response exists only as active working state while the associated vehicle is moving and is discarded on completion or cancellation.

- Use Mapbox GL JS v3 with one long-lived `Map` instance.
- Use a Mapbox-hosted standard streets style as the basemap.
- Keep the service-area polygon, service zones, and approximately 200 curated destination records as source-controlled files loaded into memory.
- Select an origin and destination locally, then make one Directions request per attempted trip or dispatch assignment.
- Pass the ephemeral route geometry to the simulator and dashboard through application ports.
- Do not write Mapbox route geometry, distance, duration, or raw responses to the event log, database, repository, or durable cache.
- Do not call Directions on telemetry ticks or animation frames.
- Use deterministic fake routes in automated tests.

This design accepts Mapbox Directions as an MVP runtime dependency while preventing it from becoming a database or domain-model dependency.

## Public Free-Tier Assessment

The public allowances are technically sufficient for a local interview prototype, subject to account eligibility and Mapbox's current terms.

| Product | Current free allowance | Relevant capability | MVP decision |
| --- | ---: | --- | --- |
| Mapbox GL JS | 50,000 web map loads/month | Interactive vector basemap, pan/zoom, client-side GeoJSON, symbols, lines, fills, heatmaps, and clustering | Use |
| Directions API | 100,000 requests/month; maximum 300 requests/minute | Driving routes, GeoJSON geometry, distance, duration, and annotations | Use at route start |
| Matrix API | 100,000 matrix elements/month | Many-to-many travel time and distance; no route geometry | Defer |
| Optimization API | 100,000 requests/month | Reorders multiple stops for an efficient route | Defer |
| Map Matching API | 100,000 requests/month | Snaps noisy traces to the road network | Defer |
| Temporary Geocoding API | 100,000 requests/month | Address/place lookup | Do not use for source-controlled destinations |
| Static Images API | 50,000 requests/month | Server-rendered map images | Not needed |

A Mapbox GL JS map load is counted when a `Map` object is initialized. Pan, zoom, layer changes, and ordinary interaction do not create additional map loads, and the load includes the map's vector/raster tile requests. A session longer than 12 hours starts another map-load session. The dashboard should create one map and update its sources rather than recreate it during React renders.

Directions supports the `mapbox/driving` profile, GeoJSON `LineString` geometry, distance and duration, up to 25 coordinates, and a 300-request-per-minute limit. This application sends two coordinates per request.

Sources:

- [Mapbox pricing](https://www.mapbox.com/pricing)
- [Mapbox GL JS pricing and map-load definition](https://docs.mapbox.com/mapbox-gl-js/guides/pricing/)
- [Directions API and limits](https://docs.mapbox.com/api/navigation/directions/)
- [Mapbox Product Terms](https://www.mapbox.com/legal/product-terms)
- [Geocoding storage rules](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results)
- [Mapbox access-token guidance](https://docs.mapbox.com/help/dive-deeper/access-tokens/)

### Licensing caveat for a vehicle-domain prototype

Mapbox's public Terms of Service contain additional licensing language for applications related to defined forms of “vehicle usage.” This operator web dashboard is not embedded in a vehicle and is not designed as a vehicle system component, but the broader Vay/teledriving context makes the classification worth confirming with Mapbox rather than assuming public free-tier entitlement for a real deployment.

Current Product Terms also prohibit caching or storing Directions results. The MVP therefore retains a response only as transient state necessary to execute and display its active route. Whether a particular implementation of active in-memory retention satisfies the current terms should be confirmed before non-demo use.

The simulator persists telemetry positions calculated while following that geometry. Although those positions are operational telemetry rather than a stored Directions response, a dense event history could approximate the route. Confirm that treatment with Mapbox before using this design outside the take-home; if necessary, change the routing provider or retention model rather than weakening the event architecture silently.

If entitlement is uncertain or a reviewer must run without a Mapbox account, MapLibre GL JS with a suitably licensed tile source and an alternative routing provider is the fallback evaluation path.

## Source-Controlled Operating World

The simulation must not generate arbitrary latitude/longitude destinations. Random coordinates may be off-road, across water, outside the service area, or impossible to route. The stable world consists of:

```text
assets/world/
  service-area.geojson
  service-zones.geojson
  destinations.json
```

### Operating area

`service-area.geojson` contains one WGS84 polygon. It is the authoritative simulation boundary and supplies:

- Destination validation.
- The dashboard's initial `fitBounds` extent.
- Mapbox `maxBounds` with a small visual margin.
- The outer boundary rendered as a fill/line layer.

The boundary should cover one compact urban area so the fleet remains visible at a useful zoom level.

### Destinations

`destinations.json` contains approximately 200 curated records—roughly two destinations per vehicle:

```ts
type Destination = {
  id: string;
  name: string;
  coordinate: [longitude: number, latitude: number];
  serviceZoneId: string;
};
```

The list provides enough variety for customer trips and repositioning without creating coordinates dynamically. Each destination must be inside the service area, associated with a valid zone, and deliberately located on or near a routable road. Human-readable names can be fictional operational labels, so Mapbox Geocoding is unnecessary.

Destination coordinates are durable source-controlled application data loaded into an in-memory `WorldCatalog`. They must be authored by the project, obtained from a source whose license permits persistence, or obtained through a geocoding product and plan that explicitly permits permanent storage. Temporary Mapbox Geocoding results cannot be stored.

Startup validation rejects invalid coordinates, duplicate IDs, missing zones, points outside the operating polygon, and coordinates within a configured duplicate tolerance. Route failures are still possible as road data changes and are handled at request time.

## Runtime Routing Flow

The simulation package owns the transport-neutral port used by customer trips and dispatch-command execution:

```ts
interface RoutingPort {
  planRoute(origin: Position, destination: Destination): Promise<PlannedRoute>;
}

type PlannedRoute = {
  geometry: GeoJSON.LineString;
  distanceMeters: number;
  durationSeconds: number;
};
```

The Mapbox adapter requests:

```text
GET /directions/v5/mapbox/driving/{origin};{destination}
  ?geometries=geojson
  &overview=full
  &steps=false
```

Exact optional parameters should remain localized to the adapter. The application should not expose Mapbox response types outside it.

### Customer trip

1. A `FREE` vehicle becomes eligible for simulated customer demand.
2. The simulator selects a different destination from the persisted list.
3. It requests a route through `RoutingPort`.
4. If routing and battery validation succeed, it retains the plan in active memory and transitions to `WITH_CUSTOMER`.
5. It interpolates telemetry along the returned geometry.
6. On completion, it moves the vehicle to the destination and discards the plan.

Customer-trip geometry is not displayed because the assignment only requires route display for `EN_ROUTE`, but it still determines realistic movement and energy use.

### Dispatch assignment

1. `RandomDispatchStrategy` selects an eligible `FREE` vehicle and a persisted destination.
2. The dispatch engine creates a job and sends an idempotent command containing only application IDs and the destination ID through `VehicleCommandPort`.
3. The simulator resolves the destination and asks its `RoutingPort` for a route.
4. The simulator rejects the command if routing fails or returned distance exceeds available range.
5. On acceptance it retains the plan, transitions to `EN_ROUTE`, and emits the route lifecycle event.
6. The plan is exposed to the dashboard while active and discarded on completion or cancellation. Dispatch never receives geometry or Mapbox types.

### Transient active-route store

The simulation runtime owns an in-memory `ActiveRouteStore` keyed by the application route ID; the server composition root wires its reader to the API. It is working state, not a durable route cache.

- It exists only for active `WITH_CUSTOMER` and `EN_ROUTE` movement.
- It supplies geometry to the simulator and browser.
- It is removed promptly when movement ends.
- It is excluded from database backups, event payloads, logs, and debug dumps.
- On application boot, the local MVP clears the previous simulation run and starts with an empty active-route store; it does not spend Directions requests reacquiring old work.

Persisted `route_current` contains only application-owned facts: route ID, vehicle ID, origin coordinate or destination ID, destination ID, version, lifecycle state, and timestamps. Mapbox geometry, distance, duration, and raw responses are not persisted.

## Request Budget and Failure Controls

Two hundred destinations do not themselves consume Directions requests. Requests occur only when movement is attempted. The important driver is trip turnover, especially when simulation time is accelerated.

There are 39,800 possible directed pairs among 200 destinations, but the application does not precompute them. Approximate usage is:

```text
Directions requests per hour ~= moving vehicles * 60 / mean real-time trip minutes
```

For example, 50 moving vehicles completing a route every five real minutes generate about 600 requests per hour. The 100,000-request allowance supports roughly 166 hours at that rate, which is ample for a short evaluation but not for an unrestricted continuously accelerated environment. Destination count affects variety; movement turnover determines API usage.

The routing adapter must enforce:

- Maximum concurrent requests.
- A token-bucket rate below Mapbox's 300 requests/minute limit.
- A configurable daily/monthly application budget below the 100,000-request free allowance.
- A timeout and at most a small bounded retry for transient failures.
- No retry for `NoRoute`, `NoSegment`, invalid input, or authorization failure.
- Metrics for attempts, successes, provider failures, no-route responses, latency, and remaining application budget.
- Redaction of access tokens and raw request URLs from logs.

Simulation configuration must include minimum trip duration and maximum new trip starts per tick. Increasing the simulated time multiplier must not increase real-time trip starts beyond the request budget.

Failure behavior is explicit:

- `NoRoute` or `NoSegment`: choose another destination on a later bounded attempt; otherwise leave the vehicle `FREE`.
- Timeout, provider 5xx, or rate limit: apply short backoff and reduce new route starts; do not invent straight-line movement.
- Invalid token or exhausted application budget: stop starting new movements, surface a degraded-system indicator, and allow active routes to finish.
- Missing active geometry during a run: reject or cancel the affected movement and allow normal dispatch to replace it; application restart begins a clean run.

## Mapbox Usage Inventory

### Operator dashboard: Mapbox GL JS

Mapbox GL JS is used for:

- Loading and displaying a standard vector basemap.
- Applying the operating area's initial camera and maximum bounds.
- Rendering the service-area polygon and service-zone fills.
- Rendering destinations as an optional circle/symbol layer.
- Rendering vehicles as one GeoJSON source with data-driven status color, heading rotation, freshness, and selection.
- Rendering active `EN_ROUTE` geometry as a line layer.
- Handling click/hover selection through rendered-feature queries.
- Clustering or aggregating healthy vehicles as the fleet grows.

Use style layers rather than one HTML `Marker` per vehicle. Vehicle updates should be accumulated and applied with `GeoJSONSource#setData` at a controlled visual cadence.

| Source | Geometry | Layer purpose |
| --- | --- | --- |
| `service-area` | Polygon | Boundary fill and outline |
| `service-zones` | Polygon collection | Coverage/health overlay |
| `destinations` | Point collection | Optional destination nodes |
| `vehicles` | Point collection | Vehicle symbol, heading, status, stale state, selection |
| `active-routes` | LineString collection | Ephemeral geometry for all visible `EN_ROUTE` vehicles |
| `route-destinations` | Point collection | Named final destination for each visible active route |

### Server: Mapbox Directions

The server-side adapter calls Directions and converts its response into the application-owned `PlannedRoute` type. It owns HTTP timeouts, error translation, throttling, budget enforcement, and token handling.

### Simulation engine

The simulator depends only on `RoutingPort` and `PlannedRoute`, not Mapbox types. It selects destinations, requests customer-trip routes, and interpolates movement along accepted geometry.

### Dispatch engine

The dispatch engine depends only on the domain-owned `VehicleCommandPort`. Its strategy selects a vehicle and destination; the simulator obtains and validates ephemeral geometry while executing the destination-only command.

### World catalog, database, and event log

The `WorldCatalog` loads destinations and boundaries from canonical files at startup; they are not copied into Postgres. The database and event log persist route lifecycle facts but no Directions response data. The backend joins active in-memory geometry into browser responses only when it is currently available.

## Tokens and Secrets

Use separate credentials for the two integration points:

- `VITE_MAPBOX_ACCESS_TOKEN`: public browser token for GL JS. It is necessarily visible to users and should have least privilege and allowed-origin restrictions.
- `MAPBOX_DIRECTIONS_ACCESS_TOKEN`: dedicated server-side token for Directions. Keep it in the runtime environment, never send it to the browser, and never log it. Use only the minimum scopes required by Mapbox.

Commit only `.env.example` with placeholders. A URL-restricted browser token may require explicit localhost entries. Server-to-server requests may not carry browser referrer headers, so token restriction behavior must be tested rather than assumed.

Set Mapbox usage notifications where available, inspect account statistics during development, and keep the application budget below the provider allowance.

## Map and Routing Degraded Behavior

- Missing browser token: show a setup message in the map panel while tables, KPIs, and dispatch queue continue working.
- Map style/network failure: show `Map unavailable` while continuing SSE updates for non-map views.
- Missing Directions token: simulator loads, but no new customer or dispatch routes start; surface routing degradation.
- Directions outage or budget exhaustion: active movements continue from their in-memory geometry; new movements pause.
- Slow browser rendering: coalesce vehicle updates and prefer the newest projection rather than queue every animation.

The README should state that the base map and runtime route creation require internet access and Mapbox credentials. Docker Compose makes application services local, not Mapbox services.

## Verification

- Unit-test destination validation and deterministic destination selection.
- Unit-test the simulator with a fake `RoutingPort` returning fixture geometry, and unit-test dispatch with a fake `VehicleCommandPort` so it never observes routes.
- Unit-test Mapbox response translation and error mapping with recorded hand-authored response shapes that contain no real persisted provider result.
- Test rate limiting, request budgets, timeouts, retry classification, and token redaction.
- Test that no Directions geometry or raw response is written to Postgres or the event log.
- Test removal of active geometry on completion and cancellation.
- Component-test missing-token and provider-degraded states.
- With development tokens, run one opt-in integration test for Directions and one browser smoke test for map rendering. Do not make live Mapbox tests part of the default test suite.
- Verify that React state updates do not create additional `Map` instances.

## Exit Strategy

Keep both integrations behind application-owned interfaces and use standard GeoJSON internally. Mapbox GL JS can then be replaced by MapLibre GL JS, and Mapbox Directions can be replaced by another routing provider, without changing the simulator state machine, dispatch strategy, event model, or persisted data.
