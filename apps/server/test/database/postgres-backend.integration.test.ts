import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorldCatalog, defaultWorldPaths } from "@fleet-radar/world/load";
import type { AnyFleetEvent, EventSource } from "@fleet-radar/domain/events";
import { PostgresFleetEventConsumer } from "../../src/eventing/PostgresFleetEventConsumer.ts";
import { ProjectionReducer } from "../../src/eventing/ProjectionReducer.ts";
import { SequenceRepository } from "../../src/database/SequenceRepository.ts";
import { rebuildProjections } from "../../src/database/rebuildProjections.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const source: EventSource = { async subscribe() { return async () => undefined; } };

suite("Postgres backend", () => {
  let pool: pg.Pool;
  let consumer: PostgresFleetEventConsumer;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
    consumer = new PostgresFleetEventConsumer(source, pool, new ProjectionReducer(world), undefined, () => new Date("2026-01-01T00:00:10.000Z"));
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log RESTART IDENTITY CASCADE");
  });
  afterAll(async () => pool?.end());

  it("atomically appends, projects, deduplicates and rejects stale regression", async () => {
    const latest = telemetry("event-2", 2, [-115.17, 36.12], 80);
    expect(await consumer.consume(latest)).toMatchObject({ disposition: "APPLIED", receivedAt: "2026-01-01T00:00:10.000Z" });
    expect(await consumer.consume(latest)).toMatchObject({ disposition: "DUPLICATE" });
    expect(await consumer.consume(telemetry("event-1", 1, [-115.18, 36.11], 10))).toMatchObject({ disposition: "STALE" });
    const counts = await pool.query("SELECT (SELECT count(*) FROM event_log)::int AS events,(SELECT count(*) FROM projection_update)::int AS updates");
    expect(counts.rows[0]).toEqual({ events: 2, updates: 1 });
    const vehicle = await pool.query("SELECT longitude,battery_percentage,last_telemetry_sequence FROM vehicle_current");
    expect(vehicle.rows[0]).toMatchObject({ longitude: -115.17, battery_percentage: 80, last_telemetry_sequence: "2" });
  });

  it("uses tombstone cursor semantics and never persists route provider data", async () => {
    await consumer.consume(telemetry("telemetry", 1, [-115.17, 36.12], 80));
    await consumer.consume(event("assigned", "route.assigned", 2, { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED" }));
    await consumer.consume(event("completed", "route.completed", 3, { routeId: "route-1", version: 1, destinationId: "destination-0001" }));
    expect((await pool.query("SELECT count(*)::int AS count FROM route_current")).rows[0].count).toBe(0);
    expect(await consumer.consume(event("late-assigned", "route.assigned", 2, { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED" }))).toMatchObject({ disposition: "STALE" });
    expect((await pool.query("SELECT count(*)::int AS count FROM route_current")).rows[0].count).toBe(0);
    const schema = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('route_current','event_log')");
    expect(schema.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(["geometry", "distance", "duration", "provider_response", "provider_url"]));
  });

  it("rejects unknown route fields before insert and rolls back projection failures", async () => {
    const invalid = { ...event("invalid", "route.assigned", 1, { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED" }),
      payload: { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED", geometry: { type: "LineString", coordinates: [] } } };
    await expect(consumer.consume(invalid)).rejects.toThrow(/unknown propert/i);
    await expect(consumer.consume(telemetry("outside", 1, [0, 0], 50))).rejects.toThrow(/outside the service area/i);
    expect((await pool.query("SELECT count(*)::int AS count FROM event_log")).rows[0].count).toBe(0);
  });

  it("projects dispatch lifecycle and rebuilds from the immutable log", async () => {
    await consumer.consume(event("requested", "dispatch.assignment-requested", 1, { dispatchJobId: "job-1", commandId: "command-1", routeId: "route-1", routeVersion: 1,
      destinationId: "destination-0001", strategy: "random" }, "job-1"));
    await consumer.consume(event("assigned", "route.assigned", 2, { routeId: "route-1", version: 1, destinationId: "destination-0001", assignmentState: "ACCEPTED" }, "job-1"));
    await consumer.consume(event("completed", "route.completed", 3, { routeId: "route-1", version: 1, destinationId: "destination-0001" }, "job-1"));
    expect((await pool.query("SELECT state,command_id FROM dispatch_job")).rows[0]).toEqual({ state: "COMPLETED", command_id: "command-1" });
    const logBefore = (await pool.query("SELECT count(*)::int AS count FROM event_log")).rows[0].count;
    const world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
    const rebuilt = await rebuildProjections(pool, new ProjectionReducer(world));
    expect(rebuilt.events).toBe(3);
    expect((await pool.query("SELECT state FROM dispatch_job")).rows[0].state).toBe("COMPLETED");
    expect((await pool.query("SELECT count(*)::int AS count FROM event_log")).rows[0].count).toBe(logBefore);
    expect(await new SequenceRepository().maximumByVehicle(pool)).toEqual(new Map([["vehicle-0001", 3]]));
  });

  it("enforces one active dispatch job per vehicle and rolls back the conflicting event", async () => {
    await consumer.consume(event("requested-1", "dispatch.assignment-requested", 1, { dispatchJobId: "job-1", commandId: "command-1",
      routeId: "route-1", routeVersion: 1, destinationId: "destination-0001", strategy: "random" }, "job-1"));
    await expect(consumer.consume(event("requested-2", "dispatch.assignment-requested", 2, { dispatchJobId: "job-2", commandId: "command-2",
      routeId: "route-2", routeVersion: 1, destinationId: "destination-0002", strategy: "random" }, "job-2"))).rejects.toMatchObject({ code: "23505" });
    expect((await pool.query("SELECT count(*)::int AS count FROM dispatch_job")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM event_log")).rows[0].count).toBe(1);
  });
});

function event(eventId: string, eventType: AnyFleetEvent["eventType"], sequence: number, payload: AnyFleetEvent["payload"], correlationId?: string): AnyFleetEvent {
  return { eventId, eventType, schemaVersion: 1, vehicleId: "vehicle-0001", sequence, occurredAt: "2026-01-01T00:00:00.000Z",
    ...(correlationId ? { correlationId } : {}), payload } as AnyFleetEvent;
}
function telemetry(eventId: string, sequence: number, coordinate: readonly [number, number], batteryPercentage: number): AnyFleetEvent {
  return event(eventId, "vehicle.telemetry-received", sequence, { coordinate, heading: 90, batteryPercentage, status: "FREE" });
}
