# Data Backend, REST API, and Local Docker Execution Plan

## Objective

Implement the durable operational backend for Fleet Radar. The backend consumes validated fleet events from the existing transport-independent `EventSource`, appends accepted events to Postgres, updates current-state projections in the same transaction, and exposes consistent REST snapshots plus a resumable Server-Sent Events stream.

Package Postgres, the Node server, simulation/dispatch runtime, and built React application so the complete system starts locally through one Docker Compose command. Mapbox remains an external runtime dependency; Directions results stay ephemeral and must never be written to Postgres or the event log.

## Deliverables

- Postgres schema and versioned migrations.
- A connection-pool and transaction boundary using `pg`/node-postgres.
- A `PostgresFleetEventConsumer` implementing the existing event-consumption semantics.
- Durable event-log, vehicle, route, dispatch-job, projection-cursor, and SSE update repositories.
- Projection rebuild tooling from the append-only event log.
- A Fastify HTTP server with validated REST and SSE endpoints.
- Joining of transient `EN_ROUTE` geometry from `ActiveRouteReader` without persisting it.
- Database and application health/readiness reporting.
- Graceful startup and shutdown wiring in `apps/server`.
- Dockerfiles, `.dockerignore`, `compose.yaml`, health checks, persistent Postgres volume, and migration service.
- `.env.example` and concise local run/reset instructions.
- Unit, Postgres integration, API integration, SSE reconnect, and Docker smoke tests.

## Scope and Non-Goals

### In scope

- Reading all supported `FleetEvent` records from the in-memory event bus through `EventSource`.
- At-least-once-safe ingestion using `eventId` idempotency.
- Atomic event append and projection updates.
- Rejection of stale/out-of-order per-vehicle sequences and route versions.
- Durable current state for approximately 100 vehicles and dispatch jobs.
- Read-only REST endpoints required by the dashboard.
- Resumable server-to-browser projection updates over SSE.
- One local application process containing the server, simulator, dispatch engine, and in-memory event bus.
- Postgres and application services orchestrated through Docker Compose.

### Out of scope

- Running Kafka locally or implementing Kafka protocol behavior.
- Public mutation endpoints, authentication, or role-based authorization.
- Persisting Mapbox route geometry, distance, duration, or raw provider responses.
- PostGIS, spatial indexes, or database-backed route/geofence calculations.
- Production Kubernetes/Railway topology, database replicas, or multi-region failover.
- A general analytics warehouse or long-term event-retention pipeline.
- GraphQL, WebSockets, or a generic repository/ORM framework.
- Production-grade secrets management; local Compose uses environment variables and safe examples.

## Fixed Technology Decisions

- **HTTP server:** Fastify. It provides a small Node surface, lifecycle hooks, schema validation, and direct access to the raw response needed for SSE.
- **Database client:** `pg` (node-postgres) with explicit parameterized SQL and transactions.
- **Migrations:** `node-pg-migrate` with versioned migrations checked into the repository. Do not rely on `/docker-entrypoint-initdb.d`, which only runs for a new volume.
- **Database:** a pinned supported Postgres Alpine image without PostGIS.
- **API validation:** Fastify JSON schemas for path/query/response boundaries, backed by shared TypeScript DTO types where useful.
- **Static web delivery:** the Fastify application serves the built Vite assets. REST, SSE, and the browser application therefore share one origin and require no production CORS configuration.
- **SSE wake-up:** committed `projection_update` rows are authoritative; Postgres `LISTEN/NOTIFY` is only a low-latency wake-up with periodic polling as a fallback.
- **Docker topology:** one persistent `postgres` service, one one-shot `migrate` service, and one `app` service.

Avoid an ORM for this slice. Conditional projection updates, partial unique indexes, event idempotency, and replay are clearer as focused SQL than as an abstraction layer.

## Required Architecture Reconciliation

Before backend implementation, update `plans/ARCHITECTURE.md` with the decisions in this plan:

- `PostgresFleetEventConsumer` replaces `FleetProjectionConsumer` in runtime composition; the in-memory consumer remains a fast reference/test implementation.
- Every accepted event is appended and projected in one transaction.
- SSE reads committed `projection_update` records rather than publishing directly from an uncommitted consumer callback.
- A REST fleet snapshot includes the stream cursor captured with that snapshot.
- The API joins route geometry only from `ActiveRouteReader` in process memory.
- The local deployment is a single application container plus Postgres, even though package boundaries remain separate.
- Correct the duplicate `packages/simulation` infrastructure entry and ensure runtime routing is described as simulation-owned rather than server-owned.

### Event-sequence restart semantics

The current architecture describes `sequence` as monotonic only within a simulator run. That is insufficient once Postgres survives application restarts: a new run starting at sequence `1` would be permanently older than the stored projection.

For the local MVP, preserve a single monotonic sequence domain across restarts:

1. Before starting simulation or dispatch producers, read the maximum accepted sequence for every vehicle from Postgres.
2. Seed the shared `FleetEventFactory` with those values.
3. Allocate each later sequence synchronously from that shared factory.
4. Start event producers only after sequence hydration and consumer subscription complete.

Add the initialization capability to the sequence factory without adding database dependencies to `packages/domain`. A real external event source is responsible for its own durable partition/sequence semantics. Multiple producer processes require a different allocator and remain future work.

### Exact event validation

The database must not persist unknown payload properties merely because required properties are valid. Change event ingestion to parse a canonical event shape and reject unknown envelope/payload fields for each event type. In particular, route events containing `geometry`, `distance`, `duration`, a raw response, or a token-bearing URL must fail validation before `event_log` insertion.

Extend `dispatch.assignment-requested` with required `commandId`. The durable job projection cannot enforce command idempotency or rebuild its `command_id` column unless that application-owned identifier is part of the source event. Update the domain schema, dispatch emitter, exact validator, and fixtures together. This event still carries identifiers and decision facts only—never route geometry.

## Proposed File Layout

```text
db/
  migrations/
    001_initial_backend.ts
    002_projection_stream.ts

apps/server/
  src/
    config/
      loadServerConfig.ts
    database/
      pool.ts
      transaction.ts
      EventStore.ts
      FleetReadRepository.ts
      DispatchJobRepository.ts
      ProjectionUpdateRepository.ts
      SequenceRepository.ts
    eventing/
      PostgresFleetEventConsumer.ts
      ProjectionReducer.ts
    api/
      dto.ts
      errors.ts
      registerVehicleRoutes.ts
      registerDispatchRoutes.ts
      registerEventStream.ts
      registerHealthRoutes.ts
      ProjectionStreamHub.ts
    createServerRuntime.ts
    main.ts
  test/
    database/
    api/
    eventing/

Dockerfile
compose.yaml
.dockerignore
.env.example
```

Keep SQL close to the repository that owns it. Do not create a generic query-builder or base-repository hierarchy.

## Postgres Schema

Use `TIMESTAMPTZ` for all timestamps, `TEXT` for application identifiers, `BIGINT` for event/stream sequences, separate longitude/latitude numeric columns, and `JSONB` only where the event payload or stream update is intentionally polymorphic.

### `event_log`

Append-only accepted source events:

```text
ingest_id          BIGSERIAL NOT NULL UNIQUE
event_id           TEXT PRIMARY KEY
event_type         TEXT NOT NULL
schema_version     SMALLINT NOT NULL
vehicle_id         TEXT NOT NULL
sequence           BIGINT NOT NULL CHECK (sequence > 0)
occurred_at        TIMESTAMPTZ NOT NULL
received_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
correlation_id     TEXT NULL
payload            JSONB NOT NULL
```

Indexes:

- `(vehicle_id, sequence)` for replay and diagnostics. Do not make it unique because `eventId` is the idempotency key and historical producer faults should remain observable.
- `(received_at DESC)` for operational inspection and replay windows.
- `(event_type, received_at DESC)` for type-specific diagnostics.
- `(correlation_id)` where non-null for dispatch lifecycle tracing.

No update/delete methods are exposed by the application. Retention/archival is future work.

`ingest_id` supplies the database-assigned total append order used for deterministic replay. It is not a domain sequence, Kafka offset, or public stream cursor.

### `vehicle_projection_cursor`

Tracks the newest logically applied event per vehicle, including terminal route tombstones:

```text
vehicle_id         TEXT PRIMARY KEY
last_sequence      BIGINT NOT NULL
last_event_id      TEXT NOT NULL
updated_at         TIMESTAMPTZ NOT NULL
```

The cursor prevents a late route assignment from being reinserted after a newer completion deleted `route_current`. It is locked with `SELECT ... FOR UPDATE` during projection.

### `vehicle_current`

One current telemetry row per vehicle:

```text
vehicle_id              TEXT PRIMARY KEY
longitude               DOUBLE PRECISION NOT NULL CHECK (-180 <= longitude AND longitude <= 180)
latitude                DOUBLE PRECISION NOT NULL CHECK (-90 <= latitude AND latitude <= 90)
heading                 DOUBLE PRECISION NOT NULL CHECK (0 <= heading AND heading < 360)
battery_percentage      DOUBLE PRECISION NOT NULL CHECK (0 <= battery_percentage AND battery_percentage <= 100)
status                   TEXT NOT NULL CHECK (status IN ('FREE', 'WITH_CUSTOMER', 'EN_ROUTE'))
service_zone_id          TEXT NOT NULL
last_telemetry_sequence  BIGINT NOT NULL
last_occurred_at         TIMESTAMPTZ NOT NULL
last_received_at         TIMESTAMPTZ NOT NULL
updated_at               TIMESTAMPTZ NOT NULL
```

The consumer derives `service_zone_id` from the canonical in-memory `WorldCatalog`; no PostGIS query is needed. Staleness is calculated from `last_received_at`, never producer time.

Indexes support `(status)`, `(service_zone_id)`, `(last_received_at)`, and low-battery ordering where justified by the query plan. With 100 rows, clarity is more important than speculative indexing.

### `route_current`

At most one active operational route per vehicle:

```text
vehicle_id          TEXT PRIMARY KEY
route_id            TEXT NOT NULL UNIQUE
version             INTEGER NOT NULL CHECK (version > 0)
destination_id      TEXT NOT NULL
dispatch_job_id     TEXT NULL
state               TEXT NOT NULL CHECK (state IN ('ACCEPTED', 'IN_PROGRESS'))
origin_longitude    DOUBLE PRECISION NULL
origin_latitude     DOUBLE PRECISION NULL
last_event_sequence BIGINT NOT NULL
assigned_at         TIMESTAMPTZ NOT NULL
updated_at          TIMESTAMPTZ NOT NULL
```

There are deliberately no geometry, distance, duration, provider-response, or provider-URL columns. Origin is copied from the current vehicle projection at assignment time when available.

### `dispatch_job`

Durable operational lifecycle:

```text
dispatch_job_id     TEXT PRIMARY KEY
vehicle_id          TEXT NOT NULL
route_id            TEXT NOT NULL
route_version       INTEGER NOT NULL CHECK (route_version > 0)
destination_id      TEXT NOT NULL
strategy            TEXT NOT NULL
decision_reason     TEXT NULL
command_id          TEXT NOT NULL UNIQUE
correlation_id      TEXT NOT NULL
state               TEXT NOT NULL
requested_at        TIMESTAMPTZ NOT NULL
accepted_at         TIMESTAMPTZ NULL
started_at          TIMESTAMPTZ NULL
completed_at        TIMESTAMPTZ NULL
updated_at          TIMESTAMPTZ NOT NULL
```

Allowed states are `REQUESTED`, `ACCEPTED`, `IN_PROGRESS`, `COMPLETED`, `REJECTED`, `CANCELLED`, and `FAILED`. A partial unique index on `vehicle_id` for `REQUESTED`, `ACCEPTED`, and `IN_PROGRESS` prevents multiple active jobs per vehicle.

Lifecycle updates are conditional so terminal jobs cannot move backward. Route lifecycle events locate the job through `correlationId`/dispatch job ID.

### `projection_update`

A short-lived, commit-backed stream for browser deltas:

```text
stream_id       BIGSERIAL PRIMARY KEY
event_id        TEXT NOT NULL REFERENCES event_log(event_id)
update_type     TEXT NOT NULL
aggregate_id    TEXT NOT NULL
payload         JSONB NOT NULL
created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
```

Add `UNIQUE (event_id, update_type, aggregate_id)`. A single event may legitimately update both a route and its correlated dispatch job, so `event_id` alone cannot be unique in this table.

Supported update types initially:

```text
vehicle.updated
route.updated
route.removed
dispatch-job.updated
```

The payload is a complete replacement DTO for that projection, not a field-level patch, so client application is idempotent. `route.removed` identifies the vehicle/route but contains no geometry.

Retain a configurable bounded window suitable for reconnecting a local demo. Pruning occurs outside the event transaction and keeps at least the newest configured row count or time window. It does not delete `event_log`.

### Optional `event_outbox`

Add this table only when the dispatch implementation writes a job and publishes `dispatch.assignment-requested` as two separate actions. In that case, make job creation and outbox insertion one transaction, and have a small at-least-once publisher deliver pending rows through `EventPublisher`.

If dispatch publishes first and awaits the in-memory consumer commit before issuing a vehicle command, the outbox is unnecessary for the local single-process MVP. Choose one flow during dispatch integration and document it; do not leave a database write followed by a best-effort publish gap.

## Event Consumption Flow

`PostgresFleetEventConsumer` depends only on `EventSource`, database repositories, `WorldCatalog`, and a backend clock. It does not depend on `InMemoryEventBus` directly.

For each delivered event:

1. Parse and validate an exact canonical `FleetEvent`.
2. Begin a database transaction.
3. Insert into `event_log` using `ON CONFLICT (event_id) DO NOTHING RETURNING received_at`.
4. When the event ID already exists, commit and return `DUPLICATE` without touching projections.
5. Insert the vehicle cursor if absent, then lock it.
6. When `event.sequence <= cursor.last_sequence`, keep the accepted event in `event_log`, commit, and return `STALE` without a stream update.
7. Apply the type-specific projection transition.
8. Update the vehicle cursor to the event sequence.
9. If a projection changed, insert one or more `projection_update` rows containing the committed replacement DTO.
10. Call `pg_notify` with the newest stream ID inside the transaction; Postgres delivers it only after commit.
11. Commit and return the backend-assigned `receivedAt`, disposition, and stream IDs.

Any validation, SQL, constraint, or projection failure rolls back both append and projection. The `EventSource` handler rejects, so the in-memory publisher observes failure and a future Kafka consumer would not commit its offset.

### Projection rules

- `vehicle.telemetry-received`: upsert `vehicle_current` only when the global cursor accepts the event; derive its service zone through `WorldCatalog`.
- `route.assigned`: upsert `route_current`, capture current origin when available, correlate and advance the dispatch job to `ACCEPTED` or `IN_PROGRESS`.
- `route.updated`: update only the matching route with a higher route version and accepted event sequence.
- `route.cancelled`: delete only the matching active route/version and mark the correlated job `CANCELLED`.
- `route.completed`: delete only the matching active route/version and advance the correlated job to `COMPLETED`.
- `route.assignment-rejected`: leave `route_current` unchanged and mark the correlated job `REJECTED` with its reason.
- `dispatch.assignment-requested`: insert or idempotently reconcile the `REQUESTED` job.
- `dispatch.assignment-completed`: advance the matching job to `COMPLETED` without recreating a missing active route.

Only changed projections create SSE updates. Duplicates, stale events, and semantic no-ops remain observable in the event log but do not generate UI churn.

### Consumer lifecycle and backpressure

- Subscribe before starting simulation or dispatch producers.
- `publish` currently resolves after subscribers finish, naturally applying database backpressure to the in-memory runtime.
- Bound the Postgres pool and do not introduce unbounded consumer concurrency.
- Process the existing in-memory source serially; a Kafka adapter may process different vehicle partitions concurrently while preserving per-vehicle order.
- On shutdown, stop producers, flush accepted bus work, unsubscribe the consumer, and then close the pool.

## Projection Rebuild

Provide an explicit administrative script, not a public endpoint:

```text
npm run db:rebuild-projections
```

The script:

1. Acquires a Postgres advisory lock so only one rebuild runs.
2. Stops or requires stopped event producers.
3. Truncates `vehicle_current`, `route_current`, `dispatch_job`, `vehicle_projection_cursor`, and `projection_update`, but never `event_log`.
4. Replays events ordered by database `ingest_id`, using their stored `receivedAt` rather than assigning a new one.
5. Applies the same projection reducer without reinserting event-log rows.
6. Reports counts for applied, stale, duplicate/impossible, and failed events.
7. Commits atomically where practical for the MVP dataset.

Refactor projection semantics so live consumption and replay cannot silently diverge. SQL orchestration may differ, but event-to-transition rules and fixtures must be shared.

## Repository and Transaction Boundaries

Define narrow interfaces rather than exporting a pool throughout the application:

```ts
interface EventIngestor {
  consume(event: AnyFleetEvent): Promise<ConsumeResult>;
}

interface FleetReadRepository {
  listVehicles(query: VehicleQuery): Promise<VehicleSnapshot>;
  getVehicle(vehicleId: string): Promise<VehicleRecord | undefined>;
}

interface DispatchJobReadRepository {
  listJobs(query: DispatchJobQuery): Promise<DispatchJobPage>;
}

interface ProjectionUpdateReader {
  currentCursor(): Promise<string>;
  readAfter(cursor: string, limit: number): Promise<readonly ProjectionUpdate[]>;
}
```

Pass a transaction-scoped `PoolClient` explicitly to repository methods used by ingestion. Use parameterized SQL only. Configure connection, statement, query, and idle-transaction timeouts; never interpolate identifiers from request input.

## REST API

All JSON uses camelCase, ISO 8601 UTC timestamp strings, and coordinates in `[longitude, latitude]` order. Bigint stream cursors are decimal strings to avoid JavaScript precision loss.

### `GET /api/vehicles`

Returns a consistent fleet snapshot sorted by vehicle ID:

```ts
type VehicleListResponse = {
  data: VehicleSummary[];
  meta: {
    count: number;
    generatedAt: string;
    streamCursor: string;
    staleAfterSeconds: number;
  };
};
```

`VehicleSummary` contains:

- `vehicleId`
- `coordinate`
- `heading`
- `batteryPercentage`
- `status`
- `serviceZoneId`
- `lastOccurredAt`
- `lastReceivedAt`
- `isStale`
- Optional active-route summary: application route ID, version, destination ID, state, and `geometryAvailable`.

The list response never contains route geometry. Capture the rows and current `projection_update` cursor in one `REPEATABLE READ`, read-only transaction so the browser can safely subscribe after that cursor.

Optional validated filters may include `status`, `zoneId`, `stale`, `lowBattery`, and exact/prefix vehicle search. With approximately 100 vehicles, returning the complete snapshot remains the default.

### `GET /api/vehicles/:vehicleId`

Returns the same vehicle fields plus active route detail. When the vehicle has a current `EN_ROUTE` route, join its geometry from `ActiveRouteReader` by application route ID:

- Geometry present: include the ephemeral GeoJSON `LineString` and `geometryAvailable: true`.
- Database route present but memory geometry absent: omit geometry and return `geometryAvailable: false`.
- Never query or reconstruct geometry from `event_log`.

Return `404` for an unknown vehicle and `400` for an invalid identifier shape.

### `GET /api/dispatch-jobs`

Returns active and recent jobs ordered by newest update:

- Optional state filter.
- Bounded `limit` with a small default and maximum.
- Stable cursor pagination using `(updatedAt, dispatchJobId)` rather than offset.
- Fields include job/vehicle/route/destination IDs, strategy, reason, lifecycle state, and relevant timestamps.

### `GET /api/events`

SSE stream of committed projection replacements.

Initial cursor resolution order:

1. `Last-Event-ID` header on automatic reconnect.
2. Validated `after` query parameter for the initial connection after a REST snapshot.
3. Current cursor when neither is supplied, meaning future updates only.

Wire format:

```text
id: 1842
event: vehicle.updated
data: {"vehicleId":"vehicle-0001",...}

```

Requirements:

- `Content-Type: text/event-stream`.
- `Cache-Control: no-cache, no-transform`.
- Keep-alive and proxy-buffering disabled where applicable.
- Send heartbeat comments at a configurable interval.
- Backfill committed rows after the requested cursor before switching to live notifications.
- Preserve stream-ID order.
- Await socket drain and bound per-client buffering; disconnect slow clients rather than accumulating memory indefinitely.
- Clean listeners, timers, and database resources immediately when a client disconnects.
- If the requested cursor predates retained projection updates, emit `stream.reset-required` and close so the browser reloads a snapshot.

The server may later coalesce high-rate telemetry, but the MVP streams complete committed replacements and lets the browser batch Mapbox updates at a controlled cadence.

### `GET /health`

Returns a minimal operational result:

```ts
type HealthResponse = {
  status: "ok" | "degraded" | "unavailable";
  database: "ready" | "unavailable";
  eventConsumer: "ready" | "stopped" | "failed";
  routing: "ready" | "degraded";
};
```

- Return `200` when the server and database are ready, even if routing is degraded; stationary telemetry remains useful.
- Return `503` when Postgres or the event consumer is unavailable.
- Do not expose credentials, hostnames, stack traces, request budgets, or raw provider messages.

Docker uses this endpoint for application readiness. A separate `/health/live` may be added if the container runtime needs a process-only liveness check.

## API Error and Request Handling

- Use a small consistent error shape: `code`, `message`, and `requestId`.
- Return `400` for invalid path/query input, `404` for missing resources, `500` for unexpected errors, and `503` for unavailable dependencies.
- Generate or accept a bounded request ID and include it in response headers/log context.
- Log method, route template, status, duration, and request ID; do not log query strings containing secrets, event payloads, active geometry, or database URLs.
- Set a request body limit even though the MVP exposes no mutation endpoints.
- Disable CORS in the composed same-origin deployment. Vite development uses a proxy for `/api` and `/health`.
- Add standard security headers suitable for the Mapbox application without blocking required map assets.

## Projection Stream Hub

`ProjectionStreamHub` owns one dedicated Postgres connection for `LISTEN projection_updates` and maintains connected SSE clients.

1. A committed notification wakes the hub.
2. The hub reads rows after its last observed stream ID in bounded pages.
3. It broadcasts each row in order to eligible clients.
4. A short polling fallback performs the same read if a notification is missed or the listener reconnects.
5. A newly connected client performs its own database backfill before joining live broadcast at the captured high-water mark.

Treat notifications as hints only; their payload is just the newest stream ID. The durable row is the source of truth. On listener connection loss, reconnect with bounded backoff and rely on cursor reads to recover gaps.

## Server Composition and Lifecycle

`createServerRuntime` performs startup in this order:

1. Parse and validate environment/server configuration.
2. Create the Postgres pool and verify connectivity.
3. Load and validate `WorldCatalog`.
4. Load the last per-vehicle event sequences.
5. Create the shared seeded `FleetEventFactory`.
6. Create the in-memory event bus.
7. Create and subscribe `PostgresFleetEventConsumer`.
8. Create the simulation routing/runtime and active-route reader.
9. Create dispatch using database/read ports and `VehicleCommandPort`.
10. Create the projection stream hub and Fastify routes.
11. Start listening, then start simulation and dispatch producers.
12. Mark readiness only after all required steps succeed.

Graceful shutdown reverses dependency flow:

1. Stop accepting HTTP connections and new SSE clients.
2. Stop dispatch and simulation producers; abort pending route requests.
3. Flush the event bus.
4. Unsubscribe the Postgres consumer.
5. Close SSE clients and the listener connection.
6. Clear ephemeral route geometry.
7. Close the Postgres pool.

Handle `SIGTERM` and `SIGINT`, make shutdown idempotent, and enforce a bounded final timeout.

## Docker Build and Compose Topology

### Application image

Use one root multi-stage `Dockerfile` because the server imports workspace packages and serves the built web application.

Build stage:

1. Copy package manifests and lockfile first for dependency caching.
2. Run `npm ci`.
3. Copy source, plans needed by build tooling, configuration, and world assets.
4. Build/type-check all workspaces.
5. Produce an executable ESM server bundle or emitted server output plus `apps/web/dist`.

Runtime stage:

- Use a pinned Node LTS slim image.
- Run as a non-root user.
- Install/copy only required production dependencies.
- Copy server output, web build, world assets, simulation configuration, and migrations.
- Set `NODE_ENV=production`.
- Expose one application port.
- Start `node` directly; do not run the Vite development server in the runtime image.

Use a small bundler such as `tsup` for the server if the existing TypeScript workspace `.ts` import specifiers make direct `tsc` output unsuitable. Keep Fastify/pg runtime dependencies external and installed normally rather than building a custom module loader.

The public Vite Mapbox token may be supplied as an explicit Docker build argument because it is browser-visible. Never use the Directions token as a build argument; it is runtime-only.

### Compose services

```text
postgres
  Pinned postgres:<major>-alpine image
  Named data volume
  pg_isready health check
  Local-only credentials from environment

migrate
  Same application image
  Waits for healthy Postgres
  Runs node-pg-migrate once
  Exits successfully before app starts

app
  Same application image
  Waits for migrate service completion
  Runs server + simulation + dispatch
  Serves REST, SSE, health, world assets, and React build
  Exposes one host port
  Uses /health readiness check
```

`depends_on` conditions express ordering, but the application must still retry initial database connectivity for a short bounded window because container ordering is not a network guarantee.

Persist Postgres in a named volume. Normal `docker compose down` preserves it; document `docker compose down --volumes` as the explicit destructive reset operation.

### Compose environment

Commit `.env.example` containing names and safe placeholders only:

```text
APP_PORT=3000
POSTGRES_DB=fleet_radar
POSTGRES_USER=fleet_radar
POSTGRES_PASSWORD=replace-local-password
DATABASE_URL=postgresql://fleet_radar:replace-local-password@postgres:5432/fleet_radar
VITE_MAPBOX_ACCESS_TOKEN=pk.replace-with-public-token
MAPBOX_DIRECTIONS_ACCESS_TOKEN=replace-with-server-token
ROUTING_MAX_REQUESTS_PER_RUN=5000
STALE_AFTER_SECONDS=10
LOG_LEVEL=info
```

Compose-internal `DATABASE_URL` uses the service name `postgres`; host-run development uses `localhost` and a separate documented value. Do not print either URL.

### `.dockerignore`

Exclude at least:

```text
.git
.env
.env.*.local
node_modules
**/node_modules
dist
**/dist
coverage
playwright-report
test-results
```

Do not exclude `.env.example`, migrations, world assets, or source-controlled runtime configuration.

## Local Developer Workflows

Add root scripts with one clear purpose:

```text
npm run db:migrate
npm run db:migrate:down
npm run db:rebuild-projections
npm run dev:server
npm run dev:web
npm run test:db
npm run test:api
npm run docker:config
npm run docker:smoke
```

Document the primary container workflow:

```text
cp .env.example .env
docker compose up --build --wait
open http://localhost:3000
```

The map may show its existing missing-token state when no public token is configured. The backend remains healthy with degraded routing when the server Directions token is absent.

## Tests

### Migration and repository tests

- Apply all migrations to an empty real Postgres database.
- Re-run migration startup without changing schema.
- Validate all database checks and partial unique indexes.
- Verify parameterized query behavior and transaction rollback.
- Verify a second active dispatch job for one vehicle is rejected while terminal history remains allowed.

Do not use an in-memory Postgres substitute for transaction, locking, JSONB, partial-index, or notification behavior. Run these tests against a disposable Postgres database through `TEST_DATABASE_URL` or a dedicated Compose test profile.

### Event-consumer tests

- Append and project every supported event type.
- Assign backend `receivedAt` independently of producer `occurredAt`.
- Deliver one event twice and prove one log row and one projection update.
- Deliver out-of-order sequences and prove they remain logged but cannot regress projections.
- Complete/delete a route, then deliver an older assignment and prove the cursor prevents resurrection.
- Reject invalid schemas and unknown payload properties before insertion.
- Reject route-event payloads containing geometry, distance, duration, raw response, or URLs.
- Roll back the event row when projection SQL fails.
- Correlate requested, assigned, rejected, cancelled, and completed dispatch lifecycle events.
- Prove no database table or event JSON contains active Directions geometry or provider metrics.
- Restart sequence allocation from stored maximums and prove new telemetry advances existing projections.

### Projection-rebuild tests

- Rebuild projections from a mixed event log and compare them with live-consumer results.
- Preserve original `receivedAt` freshness semantics.
- Reproduce route tombstones and terminal dispatch states.
- Prove rebuild never mutates or deletes event-log rows.
- Refuse a concurrent rebuild through the advisory lock.

### REST API tests

- Return a stable 100-vehicle snapshot with metadata and stream cursor.
- Validate filters, identifier shapes, pagination, and error responses.
- Return `404` for an unknown vehicle.
- Join active route geometry from a fake `ActiveRouteReader` only on vehicle detail.
- Return `geometryAvailable: false` after simulated process-memory loss.
- Never include geometry in the fleet list or dispatch job response.
- Calculate `isStale` from backend `lastReceivedAt` using a fake clock.
- Return `503` health when Postgres/consumer readiness fails and `200 degraded` for routing-only failure.

### SSE tests

- Stream committed projection updates in stream-ID order.
- Bridge the snapshot-to-subscription race using the returned cursor.
- Resume from `Last-Event-ID` without duplicates or gaps.
- Backfill rows committed while a client was disconnected.
- Emit `stream.reset-required` for a pruned cursor.
- Send heartbeats and clean up on disconnect.
- Recover from a dropped `LISTEN` connection through polling/cursor reads.
- Bound slow-client buffering.
- Prove rolled-back and stale events are never streamed.

### Docker smoke tests

1. `docker compose config` succeeds with the example environment.
2. Build the application image from a clean dependency state.
3. Start Compose and wait for all health checks.
4. Verify migrations completed once.
5. Verify `/health` returns ready.
6. Verify `/api/vehicles` reaches the configured fleet count after startup.
7. Open one SSE connection and observe a vehicle update.
8. Restart only `app` and verify Postgres data remains and event sequences continue forward.
9. Stop Compose without deleting the named volume.

Keep Docker/Postgres tests outside the fastest unit-test loop if necessary, but they are required before the backend execution plan is considered complete.

## Security and Operational Checks

- Use a non-superuser application database role; local migrations may use the same role for simplicity, documented as an MVP tradeoff.
- Parameterize every request-derived SQL value.
- Set pool size, connection timeout, statement timeout, and idle transaction timeout.
- Redact database URLs, passwords, Mapbox tokens, and token-bearing URLs from errors/logs.
- Do not return raw SQL errors or stack traces to clients.
- Limit API query values, job page size, SSE backfill page size, connections, and buffered bytes.
- Set graceful container stop timeouts long enough to flush accepted events.
- Back up nothing for the take-home, but make the named-volume behavior and destructive reset command explicit.
- Add request, DB transaction, consumer failure, duplicate/stale event, SSE client, and projection-lag metrics as structured counters/log fields; a metrics platform is future work.

## Execution Order

1. Update architecture for durable projection, SSE cursor, sequence restart, and local deployment semantics.
2. Add Fastify, `pg`, migration, and server-build dependencies.
3. Harden event parsing to reject unknown fields and seed sequence allocation from persisted maxima.
4. Add the initial database migration and verify it against a clean Postgres container.
5. Implement pool configuration, transaction helper, and narrow repositories.
6. Implement the Postgres event consumer and projection transition tests.
7. Implement dispatch lifecycle constraints and optional outbox flow if required by dispatch integration.
8. Implement projection rebuild and live/replay equivalence tests.
9. Define API DTOs and implement vehicle, detail, dispatch-job, and health routes.
10. Implement `projection_update`, `LISTEN/NOTIFY`, polling fallback, SSE backfill, and reconnect tests.
11. Wire `ActiveRouteReader` into vehicle detail without adding route persistence.
12. Implement server startup/shutdown and replace the in-memory consumer in runtime composition.
13. Add Vite development proxies and Fastify static production delivery.
14. Add the application Dockerfile, Compose services, health checks, environment example, and `.dockerignore`.
15. Add local run, migration, rebuild, reset, and troubleshooting documentation.
16. Run unit, real-Postgres integration, API/SSE integration, build, and Docker smoke checks.
17. Inspect the database and built images for secrets or forbidden Directions data.

## Acceptance Criteria

- The runtime consumer reads events only through `EventSource`; it has no dependency on the concrete in-memory bus.
- Valid events are appended and projected atomically in Postgres.
- Duplicate event IDs are harmless, and stale sequences/versions cannot regress or resurrect projections.
- Backend `receivedAt` drives freshness and remains stable during replay.
- Application restart continues per-vehicle event sequences above stored maxima.
- Current vehicles, routes, and dispatch jobs can be rebuilt from `event_log`.
- No unknown route payload fields or Directions geometry/metrics can enter the event log or schema.
- `/api/vehicles` returns a consistent snapshot and matching resumable stream cursor.
- Vehicle detail joins ephemeral geometry only from memory and reports its absence explicitly.
- `/api/dispatch-jobs`, `/api/events`, and `/health` satisfy the documented contracts.
- SSE emits only committed projection replacements, resumes without gaps inside retention, and requests a snapshot reset outside retention.
- API input is validated, SQL is parameterized, and errors/logs reveal no credentials or provider data.
- One Docker Compose command runs migrations, Postgres, the backend/simulator/dispatch runtime, and the React application locally.
- Postgres data survives an application-container restart, and producer sequences continue correctly.
- Missing Mapbox tokens produce the existing browser setup/routing-degraded behavior without making Postgres or REST unavailable.
- Default unit tests make no live Mapbox calls.
- Unit, Postgres integration, API/SSE integration, production build, Docker smoke, and `git diff --check` all pass.

## Future Extensions

- Replace the in-memory `EventSource` adapter with Kafka and acknowledge only after the database transaction commits.
- Partition concurrent consumption by vehicle while retaining per-vehicle ordering.
- Move sequence/producer epochs to the real event source rather than hydrating the local simulator factory.
- Add durable retention/archival for `event_log` and configurable stream retention.
- Separate migration and application database roles.
- Add read replicas, connection pooling infrastructure, structured tracing, and formal metrics.
- Coalesce high-rate telemetry updates for 1,000-vehicle browser sessions while retaining exception immediacy.
- Split simulator, dispatch, API, and consumers into independent services only when operational scaling requires it.
