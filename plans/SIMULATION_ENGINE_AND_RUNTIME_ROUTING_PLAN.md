# Simulation Engine and Runtime Routing Execution Plan

## Objective

Implement a deterministic, configurable simulation engine for approximately 100 vehicles in the bounded Las Vegas world. The engine owns vehicle state, customer-trip generation, dispatch-command execution, runtime route acquisition, movement along accepted routes, battery consumption, telemetry gaps, and event publication.

Runtime routing lives inside `packages/simulation`. Mapbox Directions is an infrastructure adapter behind an application-owned `RoutingPort`; Mapbox response types, tokens, URLs, and failure codes must not leak into the simulator state model, dispatch package, event schemas, database, or browser.

The result must satisfy the assignment's live vehicle requirements while remaining straightforward to configure as fleet and operating dynamics change.

## Deliverables

- A deterministic `SimulationEngine` and real-time `SimulationRunner` in `packages/simulation`.
- Runtime-validated simulation configuration loaded from a source-controlled JSON file.
- A `RoutingPort` and application-owned `PlannedRoute` model.
- A server-side Mapbox Directions adapter owned by the simulation package.
- Request concurrency, rate, timeout, retry, and per-run budget controls.
- An in-memory `ActiveRouteStore` for ephemeral route geometry.
- An idempotent `VehicleCommandPort` contract in `packages/domain`, implemented by the simulation engine and used by dispatch.
- Customer-trip generation using only destinations from `WorldCatalog`.
- Position, heading, battery, status, telemetry-gap, recharge, and route-lifecycle behavior.
- Integration with the existing `EventPublisher` and `FleetEventFactory` boundary.
- Unit, integration, and opt-in live Mapbox tests.
- Composition wiring under `apps/server` and local run instructions.

## Scope and Non-Goals

### In scope

- Approximately 100 deterministic simulated vehicles.
- `FREE`, `WITH_CUSTOMER`, and `EN_ROUTE` display states.
- Customer trips initiated by configurable simulated demand.
- Remote-repositioning routes initiated only by dispatch commands.
- One active or pending movement per vehicle.
- Runtime Directions requests between persisted world destinations.
- Movement along returned GeoJSON geometry.
- Event publication suitable for the in-memory bus now and Kafka later.
- Explicit degraded behavior when routing is unavailable.

### Out of scope

- Kafka protocol emulation.
- Route optimization, matrix routing, traffic-aware rerouting, or multi-stop trips.
- Persisting or durably caching Mapbox Directions responses.
- A realistic charging-station or charging-queue model.
- Collision avoidance, road closures, traffic signals, or vehicle physics.
- Independent simulation-service deployment.
- Dispatch strategy or dispatch-job lifecycle implementation beyond the command boundary.
- Production-grade distributed rate limiting or durable monthly billing counters.

## Fixed Architecture Decisions

### Routing ownership

This plan intentionally refines the current architecture:

- Dispatch selects an eligible vehicle and persisted destination.
- Dispatch sends an idempotent assignment command containing application identifiers and the destination ID; it does not request or carry Mapbox geometry.
- The simulation engine resolves the destination through `WorldCatalog`, requests and validates the route, verifies simulated vehicle range, and accepts or rejects the command.
- An accepted command installs the route, transitions the vehicle to `EN_ROUTE`, and emits `route.assigned`.
- A rejected command leaves the vehicle unchanged and emits `route.assignment-rejected`.

This places runtime route execution with the component that owns vehicle movement. Dispatch remains a separate package and depends only on `VehicleCommandPort`. If routing later becomes a shared operational service, the adapter and request controls can move behind the same ports without changing either state machine.

Before implementation, update `plans/ARCHITECTURE.md` and `plans/MAPBOX_INTEGRATION.md` to remove statements that dispatch requests a route or sends a `PlannedRoute` in its command.

### Package ownership

```text
packages/domain
  Event contracts, vehicle command contracts, and application identifiers

packages/world
  Immutable WorldCatalog and persisted destinations

packages/simulation
  SimulationEngine, SimulationRunner, and VehicleCommandPort implementation
  RoutingPort, Mapbox adapter, request controls, ActiveRouteStore
  Movement and energy calculations

packages/dispatch
  Vehicle/destination selection and calls to VehicleCommandPort

apps/server
  Composition root, environment/config loading, event bus wiring
```

Do not create a separate routing package for the MVP. Keep routing files grouped under `packages/simulation/src/routing/` so they can be extracted later without mixing provider behavior into the state machine.

### Time model

Separate deterministic state advancement from wall-clock scheduling:

- `SimulationEngine.advance(deltaSimulatedMs)` performs one deterministic state transition using an explicit elapsed duration.
- `SimulationRunner` measures monotonic wall-clock elapsed time, applies the configured time multiplier, and invokes `advance` without overlapping ticks.
- Unit tests call `advance` directly and never sleep.
- Runtime scheduling uses a recursive timer rather than overlapping `setInterval` callbacks.
- Clamp an unexpectedly large wall-clock gap so a paused process does not teleport every vehicle across its route on resume.

Route-start requests run asynchronously outside the advancement loop. A vehicle enters an internal `ROUTE_PENDING` condition before the request begins, preventing duplicate customer or dispatch requests while leaving its externally visible display status unchanged until a route is accepted.

## Proposed File Layout

Keep each file focused on one concern:

```text
config/
  simulation.json

packages/domain/
  src/
    commands/
      vehicle.ts

packages/simulation/
  src/
    config.ts
    types.ts
    SimulationEngine.ts
    SimulationRunner.ts
    movement.ts
    energy.ts
    routing/
      types.ts
      errors.ts
      validateRoute.ts
      MapboxDirectionsRouter.ts
      RequestBudget.ts
      RateLimiter.ts
      ActiveRouteStore.ts
    events/
      SimulationEventEmitter.ts
    index.ts
  test/
    config.test.ts
    initialization.test.ts
    movement.test.ts
    customer-trips.test.ts
    dispatch-commands.test.ts
    telemetry-gaps.test.ts
    routing-adapter.test.ts
    routing-controls.test.ts
    simulation.integration.test.ts

apps/server/src/simulation/
  createSimulationRuntime.ts
```

The exact number of test files may be reduced when fixtures are shared, but production files should not become catch-all modules.

## Data Semantics

### Planned route

Replace the current coordinate-array route model with standard application-owned GeoJSON:

```ts
type PlannedRoute = {
  readonly geometry: GeoJSON.LineString;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
};

interface RoutingPort {
  planRoute(
    origin: Position,
    destination: Destination,
    signal?: AbortSignal,
  ): Promise<PlannedRoute>;
}
```

Validation requires:

- At least two finite WGS84 coordinates in `[longitude, latitude]` order.
- Positive finite distance and duration.
- A geometry start and end reasonably near the requested endpoints; use a configurable tolerance suitable for road snapping rather than exact equality.
- No provider-owned fields on the returned application object.

`PlannedRoute` is ephemeral working state. It must never appear in a fleet event, database row, source-controlled fixture copied from a live response, ordinary application log, or durable cache.

### Vehicle state

The internal vehicle model contains:

```ts
type SimulatedVehicle = {
  id: string;
  coordinate: Position;
  heading: number;
  batteryPercentage: number;
  status: "FREE" | "WITH_CUSTOMER" | "EN_ROUTE";
  currentDestinationId: string;
  freeSinceSimulatedMs: number;
  pendingMovement?: PendingMovement;
  activeMovement?: ActiveMovement;
  telemetryGapUntilSimulatedMs?: number;
  rechargeUntilSimulatedMs?: number;
};
```

Pending/recharge fields are simulator implementation details and do not expand the assignment's display-status enum. A low-battery vehicle waiting for the demo recharge rule remains visibly `FREE` but is ineligible for customer or dispatch movement.

### Active movement

```ts
type ActiveMovement = {
  readonly purpose: "CUSTOMER" | "DISPATCH";
  readonly routeId: string;
  readonly routeVersion: number;
  readonly destinationId: string;
  readonly dispatchJobId?: string;
  readonly route: PlannedRoute;
  elapsedSeconds: number;
  distanceTravelledMeters: number;
};
```

The active store is keyed by application `routeId`. It provides a read-only view for the server API and dashboard, but only `DISPATCH` routes are exposed as the assignment's `EN_ROUTE` overlay by default.

### Display-status transitions

Only these transitions are valid:

```text
FREE -> WITH_CUSTOMER   Accepted simulated customer route
WITH_CUSTOMER -> FREE   Customer route completed or cancelled
FREE -> EN_ROUTE        Accepted dispatch command
EN_ROUTE -> FREE        Dispatch route completed or cancelled
```

`WITH_CUSTOMER <-> EN_ROUTE` is invalid. A route request failure does not create a state transition. Status changes occur only after a route is accepted and installed.

## Configuration

Use `config/simulation.json` for non-secret business and simulation dynamics. Validate it at startup and fail with field-specific messages.

Suggested schema and initial defaults:

```json
{
  "seed": "vay-simulation-v1",
  "vehicleCount": 100,
  "tickIntervalMs": 1000,
  "timeMultiplier": 1,
  "maximumAdvanceMs": 5000,
  "customerTripProbabilityPerSimulatedMinute": 0.025,
  "minimumFreeDwellSeconds": 30,
  "maximumRouteStartsPerTick": 2,
  "maximumRouteStartsPerRealMinute": 120,
  "maximumDestinationAttempts": 3,
  "batteryCapacityKwh": 60,
  "energyConsumptionKwhPerKm": 0.18,
  "minimumMovementBatteryPercentage": 20,
  "rechargeThresholdPercentage": 15,
  "rechargeDelaySimulatedSeconds": 120,
  "rechargeTargetPercentage": 85,
  "telemetryGapProbabilityPerSimulatedMinute": 0.002,
  "minimumTelemetryGapSeconds": 5,
  "maximumTelemetryGapSeconds": 20,
  "routing": {
    "timeoutMs": 5000,
    "maximumRetries": 1,
    "maximumConcurrency": 4,
    "requestsPerMinute": 240,
    "maximumRequestsPerRun": 5000,
    "endpointSnapToleranceMeters": 750
  }
}
```

These are demo defaults, not claimed production values. The 750-meter endpoint tolerance accommodates the deliberately simple pseudorandom destination catalog while still rejecting unbounded provider snapping; a production catalog should place destinations closer to validated pickup and drop-off road segments and reduce this tolerance. Keep probability definitions tied to simulated time so changing tick frequency does not change business behavior. Convert a per-minute probability `p` for elapsed simulated minutes `m` using `1 - (1 - p)^m`.

Secrets remain environment-only:

```text
MAPBOX_DIRECTIONS_ACCESS_TOKEN
```

Do not fall back to the browser token in the normal runtime. The existing smoke script may retain an explicitly documented development fallback, but production composition must require the server token.

## Initialization

1. Load and validate `WorldCatalog` once in the server composition root.
2. Load and validate simulation configuration.
3. Fail startup when vehicle count is less than one or greater than available destinations for the MVP.
4. Use the configured seed to deterministically shuffle destinations.
5. Create stable IDs `vehicle-0001` through `vehicle-0100`.
6. Place each vehicle at a distinct destination coordinate.
7. Seed initial battery percentages within a configured safe range and headings in `[0, 360)`.
8. Initialize every vehicle as `FREE`; the simulator never invents initial `EN_ROUTE` vehicles. Dispatch is responsible for creating approximately ten accepted assignments after startup.
9. Emit an initial telemetry snapshot on the first advancement.

The same seed, world files, and configuration must produce the same initial state and customer-demand decisions when used with a deterministic fake router.

## Tick and Movement Algorithm

For each `advance(deltaSimulatedMs)` call:

1. Advance the internal simulated clock.
2. For every active movement, calculate its new elapsed fraction from route duration.
3. Convert that fraction into provider-reported route distance.
4. Interpolate a coordinate along the GeoJSON line using cumulative local haversine segment lengths.
5. Derive heading from the current non-zero segment bearing and normalize it to `[0, 360)`.
6. Reduce battery from the incremental provider-reported distance:

```text
consumed kWh = distance delta km * energyConsumptionKwhPerKm
battery delta percentage = consumed kWh / batteryCapacityKwh * 100
```

7. Complete movements whose elapsed time reaches route duration.
8. On completion, set the exact persisted destination coordinate and destination ID, remove active geometry, apply the valid status transition, and publish lifecycle/telemetry events.
9. Apply eligible demo recharge completions.
10. Decide whether a telemetry gap starts or ends.
11. Publish one telemetry event per vehicle unless it is currently inside a telemetry gap.
12. Select eligible customer-trip candidates and start no more than the configured real-time and per-tick limits.

Do not call Directions from position interpolation. One accepted movement uses one accepted route for its lifetime.

Use route duration to control simulated progress and route distance to control energy consumption. Geometry segment lengths are used only to locate the proportional point along the displayed path, avoiding inconsistent speed when provider distance differs slightly from local haversine length.

## Customer-Trip Flow

1. A `FREE` vehicle becomes eligible after its minimum free dwell and battery checks.
2. Seeded demand decides whether to attempt a trip based on elapsed simulated time.
3. Select a persisted destination different from `currentDestinationId`.
4. Mark the vehicle internally route-pending before any asynchronous work.
5. Request a route through `RoutingPort`.
6. If routing succeeds and estimated energy remains above the configured floor, install the movement and transition to `WITH_CUSTOMER`.
7. If the destination is unroutable, try another persisted destination up to `maximumDestinationAttempts`, subject to the global request controls.
8. On terminal failure, clear the pending marker, keep the vehicle `FREE`, and apply a short eligibility backoff so every tick does not repeat the same failure.
9. On completion, transition to `FREE`, update `currentDestinationId`, and discard geometry.

Customer-trip geometry drives motion but is not published as a dispatch route or displayed by default. Telemetry status communicates `WITH_CUSTOMER`.

## Dispatch Command Flow

Define the port in `packages/domain/src/commands/vehicle.ts`, independently of the concrete simulator:

```ts
type AssignRouteCommand = {
  readonly commandId: string;
  readonly dispatchJobId: string;
  readonly vehicleId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly destinationId: string;
};

interface VehicleCommandPort {
  assignRoute(command: AssignRouteCommand): Promise<AssignmentResult>;
  cancelRoute(command: CancelRouteCommand): Promise<CancellationResult>;
}
```

Assignment handling:

1. Return the previously recorded result when `commandId` has already been handled.
2. Reject unknown vehicles or destinations explicitly.
3. Reject a vehicle that is not `FREE`, is route-pending, is recharging, or lacks minimum battery.
4. Mark the vehicle route-pending.
5. Resolve the destination and request a runtime route internally.
6. Reject when routing fails or estimated consumption violates the battery floor.
7. Install accepted geometry in `ActiveRouteStore`, transition to `EN_ROUTE`, and publish `route.assigned` correlated by `dispatchJobId`.
8. On completion, publish `route.completed`, transition to `FREE`, and delete geometry.
9. On cancellation, validate route ID/version, publish `route.cancelled`, transition to `FREE`, and delete geometry.

Record only bounded idempotency metadata needed for the local run. A production command service would persist command results.

## Event Publication

Use the existing `SimulationEventEmitter`, `EventPublisher`, and shared `FleetEventFactory` from the server composition root.

- `vehicle.telemetry-received`: emitted on each non-gap tick and after important transition boundaries.
- `route.assigned`: emitted only after a dispatch route has been accepted and installed.
- `route.updated`: reserved for a newer application route version; the MVP does not perform autonomous rerouting.
- `route.cancelled`: emitted after an accepted dispatch route is cancelled.
- `route.completed`: emitted once after an accepted dispatch route reaches its destination.
- `route.assignment-rejected`: emitted once for a rejected dispatch command with a stable machine-readable reason.

Events contain application route IDs, versions, destination IDs, lifecycle state, and correlation identifiers. They never contain `PlannedRoute`, GeoJSON route geometry, provider distance/duration, token-bearing URLs, or raw Mapbox responses.

The engine mutates a vehicle synchronously before publishing the corresponding event and surfaces publication failure to the runner. A failed event publication must not cause the same movement transition to execute twice; use explicit transition flags and event IDs from the shared factory.

## Active Route Store

`ActiveRouteStore` is owned by the simulation runtime and exposes narrow reader/writer interfaces:

```ts
interface ActiveRouteReader {
  get(routeId: string): ActiveRouteView | undefined;
  listDispatchRoutes(): readonly ActiveRouteView[];
}
```

Required behavior:

- Deep-freeze or clone returned views so callers cannot mutate simulator state.
- Add geometry only after route acceptance.
- Remove it immediately on completion, cancellation, or failed installation.
- Clear it on shutdown.
- Never serialize it to database, event log, ordinary logs, snapshots, or generated assets.
- Allow the API layer to join active `EN_ROUTE` geometry into an in-memory response.

Process restart loses active geometry by design. Resume behavior is future work until durable dispatch facts and startup reconciliation exist; the MVP starts a fresh deterministic simulation run.

## Mapbox Directions Adapter

`MapboxDirectionsRouter` implements `RoutingPort` and is the only module aware of Mapbox response shapes.

Request shape:

```text
GET /directions/v5/mapbox/driving/{origin};{destination}
  ?geometries=geojson
  &overview=full
  &steps=false
  &alternatives=false
  &access_token=...
```

Implementation requirements:

- Build URLs with `URL` and `URLSearchParams`; never concatenate or log a token-bearing URL.
- Encode coordinates in longitude,latitude order.
- Inject `fetch`, clock, and delay/scheduler dependencies for deterministic tests.
- Use `AbortController` to combine caller cancellation and request timeout.
- Parse only the minimal response shape needed to create `PlannedRoute`.
- Reject an empty route list, malformed geometry, non-finite metrics, or invalid endpoint snapping.
- Return an application-owned object rather than the provider response.

Translate provider/network failures into a typed `RoutingError`:

```text
INVALID_INPUT
AUTHENTICATION
NO_ROUTE
NO_SEGMENT
RATE_LIMITED
TIMEOUT
PROVIDER_UNAVAILABLE
BUDGET_EXHAUSTED
INVALID_RESPONSE
CANCELLED
```

Do not expose provider response bodies in user-facing errors or logs.

## Request Controls and Degraded Behavior

Apply controls in this order:

1. Validate origin, destination, and token configuration.
2. Reserve one unit from the per-run request budget.
3. Wait for the token-bucket rate limiter.
4. Acquire a concurrency slot.
5. Execute with timeout and cancellation.
6. Release concurrency in `finally`.
7. Classify the result and optionally retry.

Each provider attempt, including a retry, consumes budget.

Retry at most the configured `maximumRetries` for network errors, timeouts, HTTP 429, and provider 5xx responses. Use a short capped backoff and honor a reasonable `Retry-After` value. Never retry invalid input, authentication failure, `NoRoute`, `NoSegment`, invalid response, budget exhaustion, or caller cancellation.

The MVP budget is a per-process-run safety cap, not a claim of durable monthly enforcement. Keep it comfortably below the account allowance and use Mapbox account notifications. Introduce a durable shared counter only when multiple processes or continuous deployment make it necessary.

Degraded behavior:

- Missing/invalid token or exhausted budget: start the simulator, emit stationary telemetry, and refuse new customer and dispatch movements with an explicit routing-health state.
- `NoRoute`/`NoSegment`: try a different customer destination within the bounded attempt count; reject a dispatch command without substituting its requested destination.
- Timeout, 429, or provider outage: back off new starts while active movements continue from retained geometry.
- Never fall back to straight-line movement.

Expose a read-only metrics snapshot with attempts, successes, failure counts by error code, in-flight requests, retry count, latency summary, and remaining per-run budget. Do not add a metrics platform for the MVP.

## Telemetry Gaps and Demo Recharge

### Telemetry gaps

- Decide gap starts with the seeded generator and a probability defined per simulated minute.
- Choose gap duration deterministically within configured bounds.
- Continue moving and consuming energy internally during a gap.
- Publish no telemetry samples for the affected vehicle until the gap ends.
- Publish the latest state on the first tick after recovery; do not replay every missed sample.
- Route lifecycle events are not suppressed by telemetry gaps.

This allows the backend's `receivedAt`-based stale indicator to become visible without corrupting simulator time.

### Recharge rule

- When a `FREE` vehicle falls at or below the recharge threshold, mark it internally unavailable.
- After the configured simulated delay, set it to the configured target percentage and make it eligible again.
- Emit telemetry before and after recharge so the change is observable.
- Do not invent charging stations, queues, route-to-charger behavior, or a new display status in this plan.

## Lifecycle and Shutdown

`createSimulationRuntime` composes:

- Validated `WorldCatalog`.
- Validated configuration.
- Seeded random generator.
- Shared event publisher/factory.
- `MapboxDirectionsRouter` and request controls.
- `ActiveRouteStore`.
- `SimulationEngine` and `SimulationRunner`.

Startup must fail for invalid world or simulation configuration, but a missing Directions token produces an explicit degraded routing state rather than preventing stationary Fleet Radar data from running.

Shutdown order:

1. Stop scheduling ticks.
2. Prevent new customer trips and dispatch commands.
3. Abort pending route requests.
4. Await tracked request and event-publication work with a bounded timeout.
5. Clear active route geometry.
6. Flush and close the event boundary at the server composition root.

All start/stop operations should be idempotent for tests and signal handling.

## Tests

### Configuration and initialization

- Accept valid defaults and reject each invalid range or cross-field relationship.
- Produce 100 stable vehicle IDs and distinct persisted starting destinations.
- Reject a vehicle count greater than the available destination count.
- Prove identical seed/config/world inputs create identical initial state.
- Prove a different seed changes assignment while preserving constraints.

### State machine and movement

- Cover every valid display-status transition.
- Reject `WITH_CUSTOMER <-> EN_ROUTE` and duplicate active movement.
- Interpolate the beginning, middle, segment boundary, and endpoint of a multi-segment route.
- Skip zero-length geometry segments safely.
- Normalize headings near north and across the 360/0 boundary.
- Deduct battery proportionally to incremental route distance without going below zero.
- Complete exactly once even when a tick overshoots duration.
- Set the exact persisted destination and clear active geometry on completion/cancellation.

### Customer trips

- Select only catalog destinations and never the current destination.
- Keep a vehicle `FREE` while routing is pending.
- Prevent duplicate requests for a pending vehicle.
- Transition only after a valid route and battery check.
- Bound destination retries and back off after terminal failure.
- Respect per-tick and real-time start caps under accelerated simulation time.

### Dispatch commands

- Accept a valid command and emit a correlated `route.assigned` event.
- Return the same result for a duplicate `commandId` without another Directions call or event.
- Reject unknown vehicle/destination, busy state, route pending, low battery, stale version, and routing failure.
- Emit one `route.assignment-rejected` with a stable reason.
- Complete and cancel the correct route ID/version only.
- Prove dispatch imports no concrete simulator or Mapbox adapter.

### Telemetry and events

- Emit valid initial and tick telemetry for all non-gap vehicles.
- Continue internal motion during a telemetry gap and emit only the latest recovered state.
- Preserve the shared per-vehicle event sequence across telemetry and route events.
- Verify lifecycle events are not hidden by telemetry gaps.
- Assert route-event payloads and the consumer event log contain no route geometry or raw response.

### Routing adapter and controls

- Translate a small hand-authored successful response into `PlannedRoute`.
- Reject malformed geometry, missing routes, invalid metrics, and excessive endpoint snapping.
- Map every provider/network failure to the expected `RoutingError`.
- Test timeout and caller cancellation independently.
- Test retryable versus non-retryable classifications.
- Prove concurrency never exceeds the configured maximum.
- Prove rate limiting and per-run budget behavior with fake time; default tests must not sleep.
- Assert errors and logs do not contain the access token or complete request URL.
- Assert active geometry is removed on all terminal paths.

### Integration and smoke tests

- Run an engine integration test with `WorldCatalog`, the in-memory event boundary, a deterministic fake router, and 100 vehicles for many simulated ticks.
- Submit ten valid dispatch commands through `VehicleCommandPort` and verify ten distinct vehicles become `EN_ROUTE` with ten corresponding active routes; the simulator must not create that target independently.
- Assert all coordinates remain inside the service area, status counts are valid, event sequences are monotonic, and no duplicate movement is created.
- Adapt `tools/smoke-mapbox-directions.ts` to exercise the real adapter against a few representative pairs only when explicitly invoked.
- Live Mapbox requests remain excluded from `npm test`.

## Observability and Security Checks

- Never log environment objects, tokens, full Directions URLs, raw provider responses, or active route geometry.
- Log application route ID, vehicle ID, destination ID, outcome/error code, attempt count, and duration only.
- Make routing-health and budget state available to the server health/readiness response.
- Keep a least-privilege server Directions token separate from the public browser token.
- Confirm `.env`, `.env.local`, runtime output, and debug dumps remain ignored.
- Verify no generated fixture or snapshot was copied from a live Directions response.

## Execution Order

1. Reconcile routing ownership in `ARCHITECTURE.md` and `MAPBOX_INTEGRATION.md`.
2. Define and validate simulation configuration.
3. Refactor `RoutingPort`, `PlannedRoute`, command, vehicle, and movement types.
4. Implement route validation, movement interpolation, bearing, and energy helpers with unit tests.
5. Implement request budget, rate limiter, concurrency limiter, errors, and metrics with fake-time tests.
6. Implement `MapboxDirectionsRouter` and response/error translation tests.
7. Implement deterministic vehicle initialization and `SimulationEngine.advance`.
8. Implement customer-trip eligibility, pending state, bounded destination retry, and recharge behavior.
9. Implement idempotent dispatch assignment/cancellation through `VehicleCommandPort`.
10. Connect telemetry and route lifecycle publication to the existing event boundary.
11. Implement `ActiveRouteStore`, `SimulationRunner`, startup composition, and shutdown.
12. Add the 100-vehicle integration test and update the opt-in Directions smoke script.
13. Run the full test/build suite and inspect emitted data for forbidden route persistence.
14. Run a short local demo and confirm stationary degraded mode without a token and moving vehicles with a development token.

## Acceptance Criteria

- A source-controlled configuration starts exactly 100 deterministic vehicles at valid, distinct Las Vegas destinations.
- The simulation advances without overlapping ticks and remains deterministic under a fake clock/router.
- Every vehicle publishes valid location, heading, battery, status, and freshness-driving telemetry events.
- Customer trips use only persisted destinations and transition `FREE -> WITH_CUSTOMER -> FREE` along valid runtime geometry.
- Dispatch communicates only through `VehicleCommandPort`; an accepted command transitions `FREE -> EN_ROUTE -> FREE` and publishes correlated route events.
- Ten distinct accepted dispatch commands can produce the assignment's approximately ten simultaneous `EN_ROUTE` vehicles and matching active route views.
- Duplicate dispatch commands do not create duplicate requests, transitions, or events.
- Mapbox Directions is called only when starting a movement, never on a telemetry tick.
- Routing request concurrency, rate, timeout, retry, and per-run budget limits are enforced and tested deterministically.
- Missing or failed routing pauses new movement without stopping stationary telemetry or inventing straight-line routes.
- Positions interpolate along the accepted GeoJSON line, headings are normalized, and battery decreases with distance.
- Telemetry gaps create observable stale data while internal movement continues.
- Active route geometry is available only in memory while movement is active and is removed on completion, cancellation, failure, and shutdown.
- No Directions geometry, distance, duration, raw response, token, or token-bearing URL is persisted or published as a fleet event.
- Default tests use fake routes and make no live Mapbox calls.
- The opt-in route smoke test succeeds for representative source-controlled destination pairs.
- `npm test`, `npm run build`, and `git diff --check` pass.

## Future Extensions

- Extract routing into a shared service or package when dispatch, simulation, and other workflows need independent route planning at scale.
- Replace the per-process budget with a durable shared counter for multiple replicas.
- Add durable startup reconciliation and route reacquisition from application-owned endpoints.
- Model charging stations, queues, energy prices, and field capacity.
- Add demand profiles by zone and time rather than a uniform probability.
- Add provider failover, traffic-aware route updates, and shadow routing evaluation.
- Add production metrics, tracing, alerting, and controlled simulation scenarios for operator training.
