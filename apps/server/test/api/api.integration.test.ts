import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorldCatalog, defaultWorldPaths } from "@fleet-radar/world/load";
import type { ActiveRouteReader } from "@fleet-radar/simulation";
import type { EventSource } from "@fleet-radar/domain/events";
import { createApiServer } from "../../src/api/createApiServer.ts";
import { PostgresFleetEventConsumer } from "../../src/eventing/PostgresFleetEventConsumer.ts";
import { ProjectionReducer } from "../../src/eventing/ProjectionReducer.ts";
import type { ServerConfig } from "../../src/config/loadServerConfig.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const config: ServerConfig = { databaseUrl: databaseUrl ?? "postgresql://unused", host: "127.0.0.1", port: 3000, staleAfterSeconds: 10,
  poolSize: 4, statementTimeoutMs: 5_000, heartbeatMs: 1_000, streamPollMs: 50, streamPageSize: 10,
  dispatchTargetActive: 10, dispatchIntervalMs: 5_000, dispatchMaxPerCycle: 2, streamRetentionRows: 10_000, streamRetentionHours: 24,
  logLevel: "silent" };

suite("backend API", () => {
  let pool: pg.Pool;
  let app: Awaited<ReturnType<typeof createApiServer>>["app"];
  let hub: Awaited<ReturnType<typeof createApiServer>>["hub"];
  let consumer: PostgresFleetEventConsumer;
  const source: EventSource = { async subscribe() { return async () => undefined; } };
  const routes: ActiveRouteReader = { get: (id) => id === "route-1" ? { routeId: id, vehicleId: "vehicle-0001", routeVersion: 1,
    destinationId: "destination-0001", purpose: "DISPATCH", geometry: { type: "LineString", coordinates: [[-115.17, 36.12], [-115.16, 36.13]] } } : undefined,
    listDispatchRoutes: () => [] };
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
    consumer = new PostgresFleetEventConsumer(source, pool, new ProjectionReducer(world), undefined, () => new Date("2026-01-01T00:00:05.000Z"));
    ({ app, hub } = await createApiServer({ pool, config, routes, health: { database: async () => true, consumer: () => "ready", routing: () => "degraded" },
      repositoryRoot: "/path/without/web", now: () => new Date("2026-01-01T00:00:10.000Z") }));
  });
  beforeEach(async () => pool.query("TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log RESTART IDENTITY CASCADE"));
  afterAll(async () => { await hub?.stop(); await app?.close(); await pool?.end(); });

  it("returns cursor-consistent snapshots, validates input, and joins detail-only geometry", async () => {
    await consumer.consume({ eventId: "telemetry", eventType: "vehicle.telemetry-received", schemaVersion: 1, vehicleId: "vehicle-0001", sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z", payload: { coordinate: [-115.17, 36.12], heading: 90, batteryPercentage: 75, status: "EN_ROUTE" } });
    await consumer.consume({ eventId: "route", eventType: "route.assigned", schemaVersion: 1, vehicleId: "vehicle-0001", sequence: 2,
      occurredAt: "2026-01-01T00:00:01.000Z", payload: { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED" } });
    const list = await app.inject({ method: "GET", url: "/api/vehicles" });
    expect(list.statusCode).toBe(200);
    expect(list.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(list.json()).toMatchObject({ data: [{ vehicleId: "vehicle-0001", isStale: false, activeRoute: { geometryAvailable: false } }], meta: { count: 1, streamCursor: "2" } });
    expect(JSON.stringify(list.json())).not.toContain("coordinates");
    const detail = await app.inject({ method: "GET", url: "/api/vehicles/vehicle-0001" });
    expect(detail.json().data.activeRoute).toMatchObject({ geometryAvailable: true, geometry: { type: "LineString" } });
    expect((await app.inject({ method: "GET", url: "/api/vehicles/%20" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/vehicles/missing" })).statusCode).toBe(404);
  });

  it("reports routing-only degradation without failing readiness", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "degraded", database: "ready", eventConsumer: "ready", routing: "degraded" });
  });

  it("requests a snapshot reset when an SSE cursor predates retained updates", async () => {
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      await consumer.consume({ eventId: `telemetry-${sequence}`, eventType: "vehicle.telemetry-received", schemaVersion: 1,
        vehicleId: "vehicle-0001", sequence, occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { coordinate: [-115.17, 36.12], heading: 90, batteryPercentage: 75, status: "FREE" } });
    }
    await pool.query("DELETE FROM projection_update WHERE stream_id=1");
    const response = await app.inject({ method: "GET", url: "/api/events?after=0" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: stream.reset-required");
  });
});
