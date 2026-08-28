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

packages/world: a set of scripts to extract 200 real world destinations within a rectangular bounding box 


## Trade Offs

## Scaling to 1,000 Vehicles



### Simulation Configuration

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
