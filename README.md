# Fleet Radar

Fleet Radar is a local operational fleet simulation for the Las Vegas service area. The composed application runs Postgres, applies migrations, starts the REST/SSE backend and simulation runtime, and serves the built React dashboard from one application container.

## Run locally with Docker

Requirements: Docker with Compose v2 and an available local port 3000. MAPBOX_ACCESS_TOKEN is committed into .env.example for convenience, it is a free account and the repo will remain private so this is a reasonable security trade off.

Starting the simulation:

```sh
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

packages/world: a set of scripts to extract 200 real world destinations within a rectangular bounding box from MapBox. The service area and destinations are exported as static assets in assets/world and loaded in memory by the application.

packages/simulation: a simulation engine that manages an internal state of the world and emits telemetry events. Should be treated as a "black box" by the Fleet Radar application. The simulation is configured by config/simulation.json. The possible state transitions for each car are:

- `FREE -> WITH_CUSTOMER`: simulated customer demand starts a trip. The simulator follows a route, but that route is not shown as a remote-driving assignment.
- `WITH_CUSTOMER -> FREE`: the customer trip completes.
- `FREE -> EN_ROUTE`: only an accepted dispatch assignment command can start remote repositioning.
- `EN_ROUTE -> FREE`: the assigned route completes or is cancelled.
- `WITH_CUSTOMER <-> EN_ROUTE`: invalid; the MVP returns through `FREE`.

### Fleet Radar

These systems below would be considered part of a Vay Fleet Radar MVP:

- packages/domain: simulates a Kafka event stream and manages the event schema
- packages/dispatch: a simple dispatch engine that puts car into the EN_ROUTE to a random destination by sending an event into the simulation engine.
- apps/server: runs all the services in a single typescript application, including the Web API, simulated Kafka event stream, the simulation engine and the dispatch service.
- apps/web: React UI that uses MapBox to display the map

### Documentation

All architecture and AI generated execution plans are in plans/. The Codex discussion thread is in plans/Codex-Discussion.md.

## Trade Offs

The scope of the assignment, the time limitation, and my own unfamiliarity with the MapBox API meant that I had to rely heavily on AI code generation in order to complete the task. The quality of the code, the cleanliness of the abstractions and the UX for the fleet operator are not as good as I would like. If given more time I would improve the following:

- Split the simulation engine, dispatch engine, REST API into separate applications to ensure a cleaner dependency chain.
- Spend more time on the backend data structures, matching data structures with desired metrics and potentially using different data stores like time series databases, PostGIS to generate more sophisticated measures.
- Define a clear data dictionary including the semantic meaning of every event, field and calculated metric.
- Build a more full fledged dashboard which includes more metrics around revenue generation, car and teledriver utilization, as well as the ability to dispatch events. I would focus on building the dashboard from a user story perspective and map each feature to a specific use case that a fleet operator requires.
- Deploy the application to a cloud service so it does not have to be run locally.

## Scaling to 1,000 Vehicles

Scaling this application would depend on the goals. If the goal is create a simulation environment for the fleet in order to test various assumptions, I would focus on:

    - making the destination list more realistic, maybe pulled from real historic data
    - applying realistic teledriver restrictions like no unprotected left turns
    - using the more restrictive service area map
    - using realistic historic traffic information
    - improving the configurability of the environment
    - collecting a lot more calculated metrics of the environment
    - making the dispatch engine more modular so different dispatch rules could be injected
    - replacing the interactive UI with the ability to run many experiments and the ability to view the results of those experiments
    - ability to apply the simulation to different potential markets

If the goal is to scale the Fleet Radar application in a production environment for the actual Vay fleet, I would focus on a different set of objectives:

    - a cloud services architecture for high throughput and reliability. (i.e. Kafka, Firehose, BigQuery, various cloud databases and services)
    - minimize the surface area where we deploy any custom code to places where we actually provide meaningful differentiation
    - defining a canonical data dictionary across all services and appoint sponsors and owners for various areas
    - defining the types of databases which are optimized for different use cases (i.e BigQuery for data lake, TimescaleDB for windowed aggregations, PostGIS for geospatial indexes, DataDog for operational monitoring and alerting)
    - the dispatch engine would be rebuilt to be highly modular so that we could easily stream data, experiment with new rulesets, and manually override automated dispatch decisions.
    - a clean REST or GraphQL interface to retrieve data across internal systems
    - I would investigate potential platforms for the fleet UI, maybe composing it from various no code options so that we could iterate quickly with fleet operators before we commit to building a full fledged react interface. It is more important to first discover what is useful before we spend time writing code.

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
