# Fleet Radar

Fleet Radar is a local operational fleet simulation for the Las Vegas service area.

## Run locally with Docker

Requirements: Docker with Compose v2 and an available local port 3000. MAPBOX_ACCESS_TOKEN is committed into .env.example for convenience, it is a free account and the repo will remain private so this is a reasonable security trade off.

Starting the simulation:

```sh
npm install
cp .env.example .env
docker compose up --build --wait
```

Open <http://localhost:3000>. The server starts one simulation automatically; no browser action is required.

Update simulation configuration in config/simulation.json.

Shut down the simulation:

```sh
docker compose down
```

## Architecture

The application is split between a simulated external fleet and the Fleet Radar system itself. The simulator is intentionally treated as a black box: Fleet Radar observes vehicle state through events rather than directly accessing simulator state.

Data flow

Simulation → simulated Kafka event stream → server state projection/Postgres → SSE → React UI

Dispatch commands flow in the opposite direction:

Dispatch → simulation command → simulation → telemetry/route events

This mirrors a production architecture where vehicle and operational systems publish events to Kafka and Fleet Radar builds a read-optimized representation of current fleet state from those events.

### Simulation

packages/world: a set of scripts to extract 200 real world destinations within a rectangular bounding box from MapBox. The service area and destinations are exported as static assets in assets/world and loaded in memory by the application.

packages/simulation: a simulation engine that manages an internal state of the world and emits telemetry events. Should be treated as a "black box" by the Fleet Radar application. The simulation is configured by config/simulation.json. The possible state transitions for each car are:

- `FREE -> WITH_CUSTOMER`: simulated customer demand starts a trip. The simulator follows a route, but that route is not shown as a remote-driving assignment.
- `WITH_CUSTOMER -> FREE`: the customer trip completes.
- `FREE -> EN_ROUTE`: only an accepted dispatch assignment command can start remote repositioning.
- `EN_ROUTE -> FREE`: the assigned route completes or is cancelled.
- `WITH_CUSTOMER <-> EN_ROUTE`: invalid; the MVP returns through `FREE`.

### Fleet Radar

These systems below would be considered part of a Vay Fleet Radar MVP:

- packages/domain: defines the shared domain event schema
- packages/dispatch: a minimal command-producing dispatch service. It assigns a free vehicle to a destination and sends a dispatch command to the simulator. The simulator then emits the resulting route and telemetry events.
- apps/server: runs all the services in a single typescript application, including the Web API, simulated Kafka event stream, the simulation engine and the dispatch service.
- apps/web: React UI that uses MapBox to display the map, vehicle state is streamed over SSE

### Documentation

All architecture and AI generated execution plans are in plans/. The Codex discussion thread is in plans/Codex-Discussion.md.

## Trade Offs

Given the scope and timebox requirement, I favored demonstrating the end to end data flow over production or visual polish. I directed the architectural decision, but I used AI-assisted development extensively to fit the scope into the timebox.

- Single process backend: the simulation engine, dispatch engine, and API all run inside a single application. This was done to speed up implementation but in production these would be separate applications.
- Dispatch engine: was intentionally kept simple but this was important to demonstrate a realistic event lifecycle.
- Limited operator UX: given the focus on data flows, I intentionally kept the UI simple enough to clearly demonstrate basic operator features.
- Data model and persistence: the Postgres data model was kept simple, but in a production system a data model would be carefully designed along with specialized storage requirements for geospatial, time series and performance considerations.

Given more time, I would focus first on improving the operator workflows and data model: defining a canonical fleet data dictionary, adding clearer operational metrics, and validating the UI against concrete operator use cases.

## Scaling to 1,000 Vehicles

1,000 vehicles is not particularly challenging from a raw throughput perspective. Even at one telemetry event per vehicle per second, the system only processes roughly 1,000 events/sec. The more important scaling concerns are whether the business trust the information that it is given, whether the system can adjust to rapidly changing requirements, and whether multiple engineering teams can quickly and reliably ship new features.

For a production deployment I would focus on:

- Durable event ingestion and replay using Kafka or equivalent. Fleet Radar should derive its state from versioned vehicle/route events and be capable of reconstructing data stores via replay. Durable, resilient data stores ensure that derived information is trustworthy and engineering can focus on value added work.
- Establish a versioned data model and canonical data dictionary across vehicle, fleet, customer and operational systems. Clear semantics, provenance and data ownership ensure that multiple business and engineering teams are speaking the same language.
- Storage based on access patterns. Keep current operational state in a low-latency store while moving historical telemetry into analytical/time-series storage as requirements emerge. Introduce geospatial indexing for proximity and coverage queries.
- Operational reliability and observability. Add comprehensive logging, metrics, monitoring and alerting to the system. Engineers should be aware of issues as they arise and respond quickly. Operators should be able to distinguish real fleet problems with data availability issues.
- Continuous integration and deployment. Applications should be testable and able to be deployed quickly, reliably and independently. Prefer idempotent services where appropriate so that the application layer is resilient.
- Independent dispatch/optimization. Treat dispatch as a consumer of fleet state that produces commands. Keep this modular so simple rules can evolve into optimization systems and new policies can be shadow tested against production data.
- Optimize the Fleet UI for learning before polish. The underlying event architecture, data model and operational APIs have predictable technical requirements and are worth investing in early. The operator UI does not, its requirements emerge from observing real workflows. I would initially favor rapidly changeable prototypes—even if somewhat rough—while building a solid data and API layer underneath them. Once the valuable workflows are understood a production UI can be built on top of a solid foundation.

The simulation environment has a different scaling objective. Rather than processing more live vehicles, I would make it useful for running repeatable experiments: realistic historical demand/traffic, configurable operational constraints, interchangeable dispatch policies, richer metrics and the ability to run many simulations across different service areas.

## Appendix: Simulation Configuration

| Variable | Description |
|---|---|
| `seed` | Seed used to make initial vehicle placement, dispatch choices, and other random simulation behavior reproducible. |
| `vehicleCount` | Number of vehicles created when the simulation engine starts. |
| `tickIntervalMs` | Real-time delay between simulation updates. |
| `timeMultiplier` | Ratio of simulated time to real time. `10` makes the simulation advance approximately ten times faster than real time. |
| `maximumAdvanceMs` | Maximum simulated time processed in one tick, preventing a delayed process from making one unusually large movement jump. |
| `customerTripProbabilityPerSimulatedMinute` | Per-eligible-vehicle probability of starting a customer trip during one simulated minute. |
| `minimumFreeDwellSeconds` | Minimum simulated time a vehicle must remain `FREE` before starting a customer trip. Also used as backoff after a failed trip attempt. |
| `maximumRouteStartsPerTick` | Maximum number of customer routes that may begin during one simulation tick. |
| `maximumRouteStartsPerRealMinute` | Real-time rate limit on customer route starts, protecting the Directions API when simulated time is accelerated. |
| `maximumDestinationAttempts` | Number of alternative destinations attempted when a destination cannot be routed or the vehicle lacks sufficient range. |
| `batteryCapacityKwh` | Assumed usable battery capacity for each simulated vehicle. |
| `energyConsumptionKwhPerKm` | Energy consumed per kilometre, used to reduce battery percentage as vehicles move. |
| `minimumMovementBatteryPercentage` | Minimum battery reserve required to accept a route. A route is rejected if completing it would leave the vehicle below this value. |
| `rechargeThresholdPercentage` | A `FREE` vehicle at or below this battery level enters the simulated recharge delay. |
| `rechargeDelaySimulatedSeconds` | Simulated time required to complete the simplified recharge operation. |
| `rechargeTargetPercentage` | Battery percentage assigned when simulated recharging completes. Must exceed the recharge threshold. |
| `telemetryGapProbabilityPerSimulatedMinute` | Per-vehicle probability of beginning a telemetry outage during one simulated minute. |
| `minimumTelemetryGapSeconds` | Minimum simulated duration of a generated telemetry outage. |
| `maximumTelemetryGapSeconds` | Maximum simulated duration of a generated telemetry outage. |
| `routing.timeoutMs` | Timeout for each individual Mapbox Directions request attempt. |
| `routing.maximumRetries` | Number of retries after the initial request. `1` permits at most two total attempts. |
| `routing.maximumConcurrency` | Maximum number of simultaneous Directions requests. |
| `routing.requestsPerMinute` | Directions request rate limit. Requests are spaced to remain within this rate. |
| `routing.maximumRequestsPerRun` | Hard request-attempt budget for one server process, including retries. Routing becomes degraded when exhausted. |
| `routing.endpointSnapToleranceMeters` | Maximum allowed distance between requested endpoints and the returned route geometry’s endpoints. Protects against badly snapped or invalid routes. |

| Variable | Description |
|---|---|
| `STALE_AFTER_SECONDS=10` | Marks telemetry stale when its backend receipt time is more than 10 seconds old. The value is returned to the browser so frontend and backend use the same rule. |
| `DISPATCH_TARGET_ACTIVE=10` | Desired number of nonterminal dispatch jobs in `REQUESTED`, `ACCEPTED`, or `IN_PROGRESS` state. |
| `DISPATCH_INTERVAL_MS=5000` | How often the dispatch runner checks whether more assignments are required. It also runs once immediately at startup. |
| `DISPATCH_MAX_PER_CYCLE=2` | Maximum number of new assignments the dispatcher may create during one dispatch cycle. This prevents sudden assignment bursts. |
| `SSE_RETENTION_ROWS=10000` | Minimum number of recent committed projection updates retained for SSE reconnection and backfill. |
| `SSE_RETENTION_HOURS=24` | Minimum age window for retained SSE projection updates. A record is pruned only when it is both older than this window and outside the retained-row count. |
