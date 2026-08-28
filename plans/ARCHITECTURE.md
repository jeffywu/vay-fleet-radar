# Fleet Radar Architecture

This project is a take-home exercise for Vay, a remote-driving company. The objective is to build a small, operator-focused Fleet Radar while demonstrating full-stack delivery, event-driven thinking, real-time state handling, and pragmatic architectural choices. See `plans/ASSIGNMENT.md` for the original requirements, `plans/MAPBOX_INTEGRATION.md` for the Mapbox dependency and integration boundary, and `plans/FUTURE_WORK_AND_SCALING.md` for deferred capabilities and the operational changes required to grow from approximately 100 to 1,000 vehicles.

The implementation is deliberately a narrow end-to-end slice that can be completed and explained within the assignment timebox. A lightweight dispatch engine is part of that slice because dispatch is a real operational-system responsibility, not simulator behavior.

## Goals and Non-Goals

### MVP goals

- Simulate approximately 100 vehicles, including approximately 10 simultaneously in `EN_ROUTE` status.
- Display every vehicle's location, heading, battery percentage, required status, and data freshness.
- Display the current route for vehicles in `EN_ROUTE` status.
- Persist a bounded operating area and approximately 200 curated destinations, while retrieving route geometry ephemerally through Mapbox Directions.
- Update the dashboard as telemetry and route events arrive.
- Give an operator a clear map, fleet table, filters, legend, low-battery signal, and stale-data signal.
- Treat immutable telemetry and route events as the source of truth and maintain queryable current-state projections.
- Use a separate dispatch package to keep approximately 10 eligible vehicles `EN_ROUTE` through a replaceable assignment strategy.
- Run the complete application locally with Docker Compose.
- Preserve a clean boundary at which a simulated event source can be replaced by a Kafka consumer.

### MVP non-goals

- Running Kafka or reproducing Kafka's wire protocol, partitions, replication, consumer-group coordination, or offset storage.
- Production-grade dispatch optimization or teledriver scheduling.
- Charging-station workflows, field-agent dispatch, or customer-support workflows.
- Authentication and authorization, which the assignment explicitly excludes.
- A historical business-intelligence dashboard.
- Production deployment or production-scale infrastructure.

## System Context and Data Flow

The operating area, service zones, and approximately 200 curated destinations are persisted, repository-owned world data. Route geometry is deliberately not persisted: customer trips and dispatch assignments request an ephemeral route from Mapbox Directions at runtime. The simulator and event-source adapter represent the external vehicle/Kafka environment. Dispatch, event consumption, projections, APIs, and the dashboard are operational-system responsibilities.

```mermaid
flowchart LR
    S[Vehicle simulator] -->|telemetry and route events| M[In-memory event bus]
    M --> C
    C -->|append and project in one transaction| P[(Postgres)]
    P -->|current fleet and jobs| D[Dispatch engine]
    X[In-memory WorldCatalog] --> D
    X --> S
    D -->|vehicle and destination command| S
    S -->|customer trip request| R
    R -->|ephemeral route| S
    R[Routing port / Mapbox Directions]
    D -->|dispatch events| M
    P -->|snapshot plus captured stream cursor| A[REST snapshot API]
    P -->|committed projection_update rows| E[SSE event stream]
    S -->|active geometry in process memory| A
    A --> W[Operator dashboard]
    E --> W
```

The browser first loads a consistent snapshot over REST and then applies deltas from a Server-Sent Events stream. SSE is preferred over WebSockets because communication is primarily server-to-browser and automatic reconnection is useful. On an unrecoverable gap or server restart, the browser reloads the snapshot.

## Event-Driven Boundary

Kafka is not required to run for this assignment. The application defines the smallest transport-independent boundary it needs:

```ts
interface EventSource {
  subscribe(handler: (event: FleetEvent) => Promise<void>): Promise<() => Promise<void>>;
}

interface EventPublisher {
  publish(event: FleetEvent): Promise<void>;
}
```

The MVP uses an `InMemoryEventBus` implementing both ports with a small asynchronous queue or Node's built-in event primitives. This is not intended to simulate Kafka itself. It delivers typed records through transport-independent ports. The consumer, simulator, and dispatch engine must not depend on transport-specific metadata or on each other's concrete implementations.

Ownership is explicit rather than represented by a separate event-bus package:

- `packages/domain/src/events` owns the immutable event envelope and payload schemas, runtime validation, the `EventSource`, `EventPublisher`, and `FleetEventFactory` contracts, and the shared per-vehicle sequence allocator.
- `packages/simulation` and `packages/dispatch` publish their domain facts through those contracts. Neither imports the concrete bus or backend consumer.
- `apps/server/src/eventing` owns the `InMemoryEventBus`, consumer/projections, and composition wiring. A future Kafka adapter belongs here (or in a dedicated transport package only when its serialization, retry, configuration, and observability justify that boundary).

The in-memory adapter validates and takes an immutable transport copy before queuing each publish, so later producer mutation cannot change an accepted record. It delivers each accepted event to all subscribers in call order. A publish resolves after all current subscribers finish. If one or more handlers fail, all handlers are still attempted and the publish rejects explicitly; the failure does not poison later queued events. Unsubscribe is idempotent, stops future publications, and provides deterministic cleanup. These are intentionally documented application semantics, not an attempt to reproduce Kafka consumer groups or acknowledgements.

`PostgresFleetEventConsumer` is the runtime consumer. It parses every event into its exact canonical shape, assigns backend `receivedAt`, and appends the event plus its current-state and stream projections in one database transaction. `FleetProjectionConsumer` remains a fast process-local reference and test implementation with the same duplicate and stale-event semantics. Neither consumer changes the producer contracts or transport boundary.

SSE never publishes from an uncommitted consumer callback. It reads committed `projection_update` rows, using Postgres notification only as a low-latency wake-up and polling as a fallback. A REST fleet snapshot captures and returns the corresponding stream cursor so the browser can resume without a snapshot-to-stream race.

There is no mature, framework-neutral TypeScript package that provides a drop-in in-memory Kafka broker and is justified for this MVP. Kafka clients such as KafkaJS or `@confluentinc/kafka-javascript` still require a broker. `@nest-native/kafka` includes an in-memory test broker, but it is a pre-1.0 NestJS-specific integration and does not justify selecting NestJS for this project.

This boundary demonstrates the Kafka-relevant application behavior:

- Events are immutable and may be delivered at least once.
- Vehicle ID is the ordering key, preserving per-vehicle order.
- Event IDs make consumption idempotent.
- Per-vehicle sequence numbers prevent older telemetry from overwriting newer state.
- Events are parsed at ingestion into an exact canonical envelope and payload; missing or unknown fields fail explicitly.
- Current-state projections can be rebuilt from the event log.

## Event Model

Every event uses a common envelope:

```ts
type FleetEvent<TType extends string = string, TPayload = unknown> = {
  eventId: string;
  eventType: TType;
  schemaVersion: 1;
  vehicleId: string;
  sequence: number;
  occurredAt: string;
  correlationId?: string;
  payload: TPayload;
};
```

`receivedAt` is assigned by the backend rather than trusted from the producer. A dispatch job ID is used as the correlation ID across an assignment command and the events it causes.

MVP event types are:

- `vehicle.telemetry-received`: location, heading, battery percentage, and display status.
- `route.assigned`: application route ID, version, destination ID, and assignment state. Provider route geometry is transient and is not written to the event log.
- `route.updated`: a newer version of an active route.
- `route.cancelled`: the active route is no longer valid.
- `route.completed`: the vehicle has completed the route.
- `route.assignment-rejected`: the vehicle could not accept a dispatch assignment.
- `dispatch.assignment-requested`: the dispatcher selected a vehicle and route; it includes the application-owned `commandId` used for command idempotency.
- `dispatch.assignment-completed`: the correlated route completed.

Route geometry is not repeated in telemetry events or persisted route events. Unknown payload properties are rejected, so geometry, distance, duration, provider responses, and provider URLs cannot leak into the event log. Geometry remains transient working state for the active movement and is discarded on completion. Route events and telemetry have independent timestamps and versions so the UI can distinguish stale vehicle data from stale route data.

### Data semantics

- Coordinates use WGS84 and GeoJSON order: `[longitude, latitude]`.
- Heading is degrees in the range `[0, 360)`, where `0` is north.
- Battery percentage is in the range `[0, 100]`.
- Event timestamps are ISO 8601 UTC timestamps.
- `sequence` is monotonically increasing per vehicle across local application restarts.
- The composition root shares one `FleetEventFactory` across simulator and dispatch publishers so their events use one per-vehicle sequence domain. Before either producer starts, it reads each vehicle's maximum accepted sequence from Postgres and hydrates the factory; consumer subscription also completes before producers start. The sequence is not a database version or Kafka offset.
- A real external source owns its durable partition and sequence semantics. Multiple producer processes would require a different durable allocator and remain future work.
- `routeId` identifies a route assignment; `version` increases on route updates.
- Staleness is based on backend `receivedAt`, not producer clock time.

The MVP uses the assignment's `FREE | WITH_CUSTOMER | EN_ROUTE` display status.

## Simulation Engine

The simulator is a deterministic, parameterized state model and is external to the operational system. A seeded random-number generator makes runs and tests reproducible.

On each tick it:

1. Advances moving vehicles along their current route.
2. Updates heading and battery based on distance travelled.
3. Performs permitted state transitions.
4. Emits one telemetry event for each vehicle unless that vehicle is simulating a telemetry gap.
5. Emits route lifecycle events when assignments change or complete.

The simulator also implements the domain-owned `VehicleCommandPort`. An assignment command contains only application identifiers: command ID, dispatch job ID, vehicle ID, application route ID, route version, and destination ID. The simulator resolves the persisted destination and obtains the ephemeral route through its own `RoutingPort`, then validates vehicle state and range. It either retains the plan as active working state, starts movement, and emits `route.assigned`, or leaves the vehicle unchanged and emits `route.assignment-rejected`. Dispatch never receives Mapbox geometry or provider types.

The valid MVP display-status transitions are:

- `FREE -> WITH_CUSTOMER`: simulated customer demand starts a trip. The simulator follows a route, but that route is not shown as a remote-driving assignment.
- `WITH_CUSTOMER -> FREE`: the customer trip completes.
- `FREE -> EN_ROUTE`: only an accepted dispatch assignment command can start remote repositioning.
- `EN_ROUTE -> FREE`: the assigned route completes or is cancelled.
- `WITH_CUSTOMER <-> EN_ROUTE`: invalid; the MVP returns through `FREE`.

The simulator never chooses `EN_ROUTE` independently; this status always has an accepted dispatch job and route assignment. The dispatch engine, not the simulator, is responsible for maintaining the target number of active assignments.

Configuration is read from the runtime-validated `config/simulation.json` file:

- Seed and number of vehicles.
- Tick interval and simulated time multiplier.
- Customer-trip probability and free-time range.
- Battery capacity, energy consumption per distance, and low-battery threshold.
- Telemetry-gap probability and maximum gap duration.
- Service-area, service-zone, and destination-data locations.

A lightweight demo recharge rule restores low-battery vehicles after a simulated delay so the fleet does not eventually become inert.

### Bounded simulation world

Implementation details for generating the Las Vegas metro assets are defined in `plans/BOUNDED_SIMULATION_WORLD_PLAN.md`.

The simulation runs inside one explicitly configured operating area rather than choosing arbitrary coordinates. Its persistent world data consists of:

- `service-area.geojson`: one WGS84 polygon defining valid simulation geography and the dashboard's initial and maximum map bounds.
- `service-zones.geojson`: named operational subdivisions used for coverage and filtering.
- `destinations.json`: approximately 200 curated stable destination IDs, display names, coordinates, and service-zone IDs. Coordinates must be inside the operating polygon and deliberately located on or near routable roads.

Vehicles initialize at destination coordinates. A `FREE` vehicle remains associated with its current destination. Customer trips and dispatch assignments choose another persisted destination and request a runtime route through `RoutingPort`. When a vehicle reaches the route endpoint, its current destination becomes the selected destination.

Two destinations per vehicle provide enough spatial variety that repositioning and customer trips do not repeatedly cycle through a tiny set of points. Startup validation fails with a clear error if destination data is invalid, a destination references a missing service zone, coordinates are duplicated beyond a configured tolerance, or a destination is outside the operating polygon. Destination data must be authored by the project or obtained from a source whose license permits persistence; temporary Mapbox Geocoding results may not be stored.

The simulator interpolates position, heading, distance, and energy consumption along the ephemeral `LineString` returned for an accepted trip. If Directions returns `NoRoute`, `NoSegment`, times out, or is rate-limited, the transition is rejected and the vehicle remains `FREE`; a bounded retry may select another destination. The simulator never invents an arbitrary coordinate or falls back to a straight line that contradicts the displayed route.

### Runtime routing

The simulation package owns the transport-neutral routing port used for both customer trips and dispatch-command execution:

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

The MVP adapter calls Mapbox Directions with the `mapbox/driving` profile, `geometries=geojson`, and an appropriate overview. `PlannedRoute` is simulation-owned active working state, not command or durable data. The simulator installs it in an in-memory `ActiveRouteStore` after accepting a movement and the API may expose active dispatch geometry to the browser. It is removed when the route completes or is cancelled.

Persisted route events and `route_current` keep only application-owned facts such as route ID, vehicle ID, origin coordinate or destination ID, destination ID, version, lifecycle state, and timestamps. They do not store Mapbox geometry, distance, duration, or the raw provider response. If active geometry is missing after a process restart, the adapter requests a new ephemeral route from the persisted endpoints.

Directions is called once per attempted trip or dispatch assignment, never once per telemetry tick. The adapter enforces a concurrency limit, a request timeout, bounded retries, the provider's rate limit, and an application-level monthly request budget. Accelerating simulated movement must not accelerate trip turnover past that request budget. Tests use a deterministic fake `RoutingPort`, not live Mapbox requests.

## Dispatch Engine

Dispatch is an MVP package and part of the operational system. It is not bundled into the simulator. The package runs in the same Node process for the local MVP and communicates through explicit ports.

The dispatch package owns:

- Dispatch-job creation and lifecycle.
- Selection of an eligible vehicle and destination through a configured strategy.
- Prevention of more than one active dispatch job per vehicle.
- Submission of idempotent assignment commands through `VehicleCommandPort`.
- Correlation of accepted, rejected, completed, and cancelled route events with jobs.
- Maintaining the configured target of approximately 10 active `EN_ROUTE` assignments.

The dispatch package depends on shared domain ports and immutable inputs supplied by the server-side runner:

```ts
interface DispatchStrategy {
  assign(vehicles: readonly DispatchVehicle[], world: WorldCatalogView): DispatchAssignment | undefined;
}

interface EventPublisher {
  publish(event: AnyFleetEvent): Promise<void>;
}

interface FleetStateReader {
  listEligibleVehicles(): Promise<readonly DispatchVehicle[]>;
}

interface VehicleCommandPort {
  assignRoute(command: AssignRouteCommand): Promise<AssignmentResult>;
}
```

The server-side `DispatchRunner` reads fresh vehicle projections and the active-job count, then supplies an immutable candidate snapshot to the engine. A strategy proposes a vehicle and destination; the engine creates application identifiers, publishes the requested job fact, and submits an idempotent command. The Postgres event consumer owns the durable lifecycle projection and the partial unique constraint resolves active-job races. The simulator obtains and validates the route while handling the command.

The MVP uses `RandomDispatchStrategy`. On a configurable interval, the runner compares active accepted jobs with its target, chooses randomly among `FREE`, fresh, sufficiently charged vehicles without an active job, and selects a different persisted destination inside the operating area. It creates a job and sends the destination-only command through `VehicleCommandPort`; the simulator obtains the route and checks range. The random generator is seeded so the decision is reproducible; live Mapbox geometry is not expected to be byte-for-byte deterministic. Command rejection returns the job to a terminal `REJECTED` state and permits another candidate on a later dispatch cycle. Dispatch pauses when routing is degraded rather than producing an unbounded stream of known-to-fail jobs.

For the single-process MVP, dispatch publishes `dispatch.assignment-requested` and awaits the in-memory publisher, which resolves only after the Postgres consumer transaction commits, before issuing the vehicle command. This removes a database-write/best-effort-publish gap without an outbox. A durable outbox becomes necessary if dispatch job creation and event delivery are later separated across processes.

The job lifecycle is `REQUESTED -> ACCEPTED -> IN_PROGRESS -> COMPLETED`, with `REJECTED`, `CANCELLED`, and `FAILED` alternatives. Job state is distinct from vehicle display status. The strategy is selected by configuration from an explicit registry; dynamic plug-in loading or a generic rules framework is unnecessary for the MVP.

MVP dispatch configuration includes the strategy name, target active assignments, dispatch interval, seeded-random configuration, and maximum new jobs per cycle.

## Data Backend

Postgres is the durable store. PostGIS is not required because the MVP does not perform database-backed spatial queries.

The minimum tables are:

### `event_log`

An append-only record of accepted events with `event_id`, event type, schema version, vehicle ID, sequence, occurred time, received time, and JSON payload. `event_id` is unique for idempotency. The event log is the replayable source of truth.

### `vehicle_current`

One current row per vehicle containing location, heading, battery, display status, last sequence, last occurred time, and last received time. An event only updates this projection when its sequence is newer than the stored sequence.

### `route_current`

At most one active route record per vehicle, including application route ID, version, origin coordinate or destination ID, destination ID, lifecycle state, and update time. Mapbox geometry, distance, duration, and raw responses are not persisted. A route update only applies when its version is newer than the stored version.

### `dispatch_job`

One row per dispatch attempt containing job ID, vehicle ID, route ID and version, strategy name, lifecycle state, decision reason, command ID, correlation ID, and timestamps. A partial unique constraint prevents more than one active job per vehicle. Dispatch-job history supports operator visibility.

The consumer parses an event into its canonical shape, appends it to `event_log`, and updates the relevant current-state and `projection_update` records in one database transaction. A duplicate event is acknowledged without changing state. Projection-rebuild code can truncate derived tables and replay the log in database-assigned ingest order.

Database views are reserved for stable domain calculations such as zone coverage. REST response shapes, UI widgets, and ad hoc presentation calculations should not each become database views.

## API and Real-Time Updates

Minimum endpoints are:

- `GET /api/vehicles`: a consistent current vehicle snapshot and its captured SSE stream cursor, with active route summaries where applicable.
- `GET /api/vehicles/:vehicleId`: vehicle details plus active ephemeral route geometry when available.
- `GET /api/dispatch-jobs`: active and recent dispatch jobs.
- `GET /api/events`: SSE stream of accepted vehicle, route, and dispatch projection updates.
- `GET /health`: application and database readiness.

SSE messages come from committed `projection_update` records, include a resumable stream ID, and contain only the changed projection. The implemented browser feed loads `GET /api/vehicles` first, indexes its complete replacement records by vehicle ID, and opens the named SSE stream after the snapshot's opaque cursor. Native `Last-Event-ID` reconnection handles ordinary interruptions; `stream.reset-required` closes the old connection and atomically installs a new snapshot before reconnecting. Malformed individual stream records are ignored without discarding the last known fleet.

Browser replacements are flushed to React at most once per animation frame and stale state is recalculated once per second from backend receipt time. One Mapbox GeoJSON source and two layers render all vehicle locations, status colors, stale treatment, and headings. This avoids one DOM marker or one source update per telemetry event and remains suitable for the expected increase from approximately 100 to 1,000 vehicles.

The API joins route geometry only from the simulation-owned `ActiveRouteReader` in process memory. No REST or SSE repository reads geometry from Postgres, and missing geometry after a restart is an expected transient state until routing reacquires it.

There are no public mutation endpoints in the MVP.

## Operator Dashboard

The implemented integration spike is one map-first operator view. It displays the Las Vegas service area and zones, all current vehicles in one GeoJSON source, vehicle heading, status color, stale treatment, fleet count, and explicit Starting, Live, Reconnecting, Resetting, and Error feed states. For visible `EN_ROUTE` vehicles, the browser renders the ephemeral Directions geometry as an active-route line and marks the persisted destination coordinate with its catalog name. Route summaries arrive in the snapshot and named route SSE events; the browser fetches detail geometry only when an active route appears and never persists it. Operators can filter the in-memory map view by any combination of `FREE`, `WITH_CUSTOMER`, and `EN_ROUTE`, then optionally restrict that selection to vehicles with battery strictly below 20%. These client-side filters apply to vehicles, routes, and destination markers without changing the backend feed or retained fleet state, so clearing a filter immediately restores the latest known records. Backend feed operation is independent from Mapbox readiness, so a missing public token or basemap failure does not stop snapshot/SSE observation or hide the fleet count.

The next dashboard capabilities are deliberately incremental future work: selected-vehicle detail, a fleet table, a stale-only filter, dispatch-job visibility, and zone coverage. Staleness will remain conspicuous, and future coverage calculations will use named operational zones rather than arbitrary empty map cells.

## Infrastructure

- TypeScript for simulator, backend, shared event schemas, and frontend.
- Fastify with JSON-schema boundary validation for REST and direct response access for SSE.
- `pg` with explicit parameterized SQL and `node-pg-migrate` versioned migrations; no ORM or PostGIS.
- React with Mapbox GL JS for basemap rendering, camera controls, and client-side GeoJSON layers in the dashboard.
- Postgres without PostGIS.
- Dockerfiles for application services and Docker Compose for reproducible local orchestration.
- Environment variables for database credentials, the Mapbox browser token, the server-side Directions token, and the Directions request budget; `.env.example` contains names and safe placeholders only.

The TypeScript workspace is separated by responsibility:

- `packages/domain`: shared event schemas, commands, identifiers, and transport-neutral types.
- `packages/world`: validated, immutable bounded-world assets and the in-memory `WorldCatalog`.
- `packages/simulation`: vehicle state model, simulator-owned event publisher, runtime-routing port and Mapbox adapter, request controls, transient active-route store, and the simulated implementation of `VehicleCommandPort`.
- `packages/dispatch`: dispatch engine, strategy contract, random MVP strategy, job rules, and its required ports.
- `apps/server`: composition root, in-memory event bus, event consumer, Postgres projections, REST, and SSE.
- `apps/web`: React map-first operator view, snapshot/SSE fleet feed, and batched Mapbox vehicle rendering.

Package boundaries prevent dispatch from importing simulator state or mutating vehicles directly. The local deployment uses one application container containing the server, simulation and dispatch runtimes, and built React assets, plus one Postgres container; these package boundaries remain valid despite the single-process MVP topology.

Mapbox has two explicit integration points. Mapbox GL JS renders a Mapbox-hosted basemap plus application-owned GeoJSON sources for the operating polygon, service zones, destinations, vehicles, headings, and active routes. Separately, the simulation package's server-side `RoutingPort` adapter calls Mapbox Directions once per attempted movement and keeps the response only as active in-memory working state. The database never persists Directions results. See `plans/MAPBOX_INTEGRATION.md` for the complete inventory and fallback behavior.

Mapbox browser tokens are necessarily visible to the browser. Use a least-privilege public token, configure localhost/deployment URL restrictions where practical, and never expose a secret token. Use a separate least-privilege Directions token in the server environment and never send it to the browser. The current Mapbox Product Terms prohibit caching or storing Directions API results, so route geometry remains ephemeral and is discarded after use.

Docker Compose is the local runtime contract.

## Testing

Tests should cover both happy paths and edge conditions:

- Valid and invalid simulator transitions.
- Deterministic movement, heading, battery depletion, and demo recharge.
- Validation and persistence of approximately 200 bounded destinations.
- Deterministic destination selection with a fake `RoutingPort`.
- Directions timeout, rate-limit, no-route, budget-exhaustion, and provider-degraded behavior.
- Proof that provider geometry, distance, duration, and raw responses never enter the database or event log.
- Required `EN_ROUTE` count and associated route presence.
- Deterministic random-strategy decisions and strategy selection by configuration.
- Dispatch eligibility, one-active-job-per-vehicle, target concurrency, command rejection, and retry on a later cycle.
- Dispatch job correlation across requested, accepted, completed, and rejected events.
- Event-schema validation.
- Duplicate and out-of-order event handling.
- Atomic event append and projection update.
- Route assignment, update, cancellation, and completion.
- Projection rebuild from the event log.
- Telemetry staleness after a simulated gap.
- REST snapshot and SSE update integration.
- Browser-owned snapshot parsing, cursor handoff, named SSE replacement, reconnect/reset behavior, cleanup, and batched fleet updates.
- Mapbox source/layer lifecycle plus an opt-in live fleet-map smoke test.

## Deliverables and Tradeoffs

The repository must include backend and frontend code, the bounded operating area and approximately 200 source-controlled destinations loaded in memory, Docker-based local-run instructions, configuration examples, test instructions, and a concise README describing the 100-vehicle data, runtime routing, dispatch flow, and explicit MVP non-goals.
