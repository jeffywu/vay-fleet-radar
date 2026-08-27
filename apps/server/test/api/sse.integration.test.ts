import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventSource } from "@fleet-radar/domain/events";
import { defaultWorldPaths, loadWorldCatalog } from "@fleet-radar/world/load";
import { ProjectionStreamHub } from "../../src/api/ProjectionStreamHub.ts";
import { ProjectionUpdateRepository } from "../../src/database/ProjectionUpdateRepository.ts";
import type { ProjectionUpdate } from "../../src/database/types.ts";
import { PostgresFleetEventConsumer } from "../../src/eventing/PostgresFleetEventConsumer.ts";
import { ProjectionReducer } from "../../src/eventing/ProjectionReducer.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const source: EventSource = { async subscribe() { return async () => undefined; } };

suite("commit-backed projection stream", () => {
  let pool: pg.Pool;
  let hub: ProjectionStreamHub;
  let consumer: PostgresFleetEventConsumer;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
    consumer = new PostgresFleetEventConsumer(source, pool, new ProjectionReducer(world));
    hub = new ProjectionStreamHub(pool, new ProjectionUpdateRepository(), 50, 10);
    await hub.start();
  });
  beforeEach(async () => pool.query("TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log RESTART IDENTITY CASCADE"));
  afterAll(async () => { await hub?.stop(); await pool?.end(); });

  it("streams committed rows in order and resumes through durable backfill", async () => {
    const firstConnection: ProjectionUpdate[] = [];
    const detach = hub.attach("0", async (update) => { firstConnection.push(update); }, () => undefined);
    await consumer.consume(telemetry("event-1", 1, 70));
    await waitFor(() => firstConnection.length === 1);
    expect(firstConnection.map((row) => row.streamId)).toEqual(["1"]);
    detach();

    await consumer.consume(telemetry("event-2", 2, 69));
    const resumed: ProjectionUpdate[] = [];
    const detachResumed = hub.attach("1", async (update) => { resumed.push(update); }, () => undefined);
    await waitFor(() => resumed.length === 1);
    expect(resumed.map((row) => [row.streamId, row.updateType])).toEqual([["2", "vehicle.updated"]]);
    detachResumed();
  });

  it("does not stream stale or rolled-back events", async () => {
    await consumer.consume(telemetry("latest", 2, 70));
    const streamed: ProjectionUpdate[] = [];
    const detach = hub.attach("1", async (update) => { streamed.push(update); }, () => undefined);
    await consumer.consume(telemetry("stale", 1, 5));
    const outside = telemetry("outside", 3, 50) as unknown as { payload: { coordinate: [number, number] } };
    outside.payload.coordinate = [0, 0];
    await expect(consumer.consume(outside)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(streamed).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS count FROM event_log")).rows[0].count).toBe(2);
    detach();
  });
});

function telemetry(eventId: string, sequence: number, batteryPercentage: number) {
  return { eventId, eventType: "vehicle.telemetry-received" as const, schemaVersion: 1 as const, vehicleId: "vehicle-0001", sequence,
    occurredAt: "2026-01-01T00:00:00.000Z", payload: { coordinate: [-115.17, 36.12] as const, heading: 90, batteryPercentage, status: "FREE" as const } };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for projection stream");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
