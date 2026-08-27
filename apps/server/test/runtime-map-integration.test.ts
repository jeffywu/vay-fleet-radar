import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSimulationConfig, type RoutingPort } from "@fleet-radar/simulation";
import { defaultWorldPaths, loadWorldCatalog } from "@fleet-radar/world/load";
import type { WorldCatalogView } from "@fleet-radar/world";
import type { ServerConfig } from "../src/config/loadServerConfig.ts";
import { createServerRuntime } from "../src/createServerRuntime.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const serverConfig: ServerConfig = { databaseUrl: databaseUrl ?? "postgresql://unused", host: "127.0.0.1", port: 0,
  staleAfterSeconds: 10, poolSize: 5, statementTimeoutMs: 5_000, heartbeatMs: 1_000, streamPollMs: 50,
  streamPageSize: 10, dispatchTargetActive: 0, dispatchIntervalMs: 5_000, dispatchMaxPerCycle: 1,
  streamRetentionRows: 10_000, streamRetentionHours: 24, logLevel: "silent" };
const simulationConfig = parseSimulationConfig({
  seed: "map-integration", vehicleCount: 2, tickIntervalMs: 500, timeMultiplier: 1, maximumAdvanceMs: 500,
  customerTripProbabilityPerSimulatedMinute: 0, minimumFreeDwellSeconds: 30, maximumRouteStartsPerTick: 0,
  maximumRouteStartsPerRealMinute: 1, maximumDestinationAttempts: 1, batteryCapacityKwh: 60,
  energyConsumptionKwhPerKm: 0.18, minimumMovementBatteryPercentage: 20, rechargeThresholdPercentage: 15,
  rechargeDelaySimulatedSeconds: 120, rechargeTargetPercentage: 85, telemetryGapProbabilityPerSimulatedMinute: 0,
  minimumTelemetryGapSeconds: 5, maximumTelemetryGapSeconds: 20,
  routing: { timeoutMs: 100, maximumRetries: 0, maximumConcurrency: 1, requestsPerMinute: 100,
    maximumRequestsPerRun: 10, endpointSnapToleranceMeters: 150 },
});
const routing: RoutingPort = { planRoute: async (origin, destination) => ({
  geometry: { type: "LineString", coordinates: [origin, destination.coordinate] }, distanceMeters: 1, durationSeconds: 1,
}) };

suite("server-owned map feed startup", () => {
  let pool: pg.Pool;
  let world: WorldCatalogView;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
  });
  beforeEach(async () => pool.query(
    "TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log RESTART IDENTITY CASCADE",
  ));
  afterAll(async () => pool?.end());

  it("listens before starting one simulation and fills an empty snapshot through SSE", async () => {
    const runtime = await createServerRuntime({ world, simulationConfig, serverConfig, routing });
    const originalStart = runtime.runner.start.bind(runtime.runner);
    const startRunner = vi.spyOn(runtime.runner, "start").mockImplementation(() => {
      expect(runtime.app.server.listening).toBe(true);
      originalStart();
    });
    const startDispatch = vi.spyOn(runtime.dispatchRunner, "start");
    const initialStreamAbort = new AbortController();
    const movementStreamAbort = new AbortController();

    try {
      await runtime.start();
      await runtime.start();
      expect(startRunner).toHaveBeenCalledTimes(1);
      expect(startDispatch).toHaveBeenCalledTimes(1);
      const address = runtime.app.server.address();
      if (!address || typeof address === "string") throw new Error("Runtime did not bind a TCP port");
      const origin = `http://127.0.0.1:${address.port}`;
      const initial = await fetch(`${origin}/api/vehicles`).then((response) => response.json()) as FleetSnapshot;
      expect(initial.data).toEqual([]);
      expect(initial.meta).toMatchObject({ count: 0, streamCursor: "0", staleAfterSeconds: 10 });

      const stream = await fetch(`${origin}/api/events?after=${initial.meta.streamCursor}`, { signal: initialStreamAbort.signal });
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const update = await readEvent(stream, "vehicle.updated");
      initialStreamAbort.abort();
      expect(update.id).toBe("1");
      expect(update.data).toMatchObject({ vehicleId: "vehicle-0001", status: "FREE" });

      const populated = await waitForSnapshot(origin, 2);
      expect(populated.meta.streamCursor).toBe("2");
      const projected = populated.data.find((vehicle) => vehicle.vehicleId === update.data.vehicleId);
      const { isStale: _isStale, ...mapRecord } = projected!;
      expect(update.data).toEqual(mapRecord);

      const movementStream = await fetch(`${origin}/api/events?after=${populated.meta.streamCursor}`, { signal: movementStreamAbort.signal });
      const destination = world.destinations.find(({ coordinate }) => coordinate[0] !== projected!.coordinate[0] ||
        coordinate[1] !== projected!.coordinate[1])!;
      await expect(runtime.engine.assignRoute({ commandId: "map-movement-command", dispatchJobId: "map-movement-job",
        vehicleId: projected!.vehicleId, routeId: "map-movement-route", routeVersion: 1, destinationId: destination.id }))
        .resolves.toMatchObject({ accepted: true });
      const moved = await readEvent(movementStream, "vehicle.updated", (record) => record.vehicleId === projected!.vehicleId &&
        (record.coordinate[0] !== projected!.coordinate[0] || record.coordinate[1] !== projected!.coordinate[1]));
      movementStreamAbort.abort();
      expect(moved.data).toMatchObject({ vehicleId: projected!.vehicleId, status: "EN_ROUTE" });
    } finally {
      initialStreamAbort.abort();
      movementStreamAbort.abort();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runtime.close();
    }
  }, 15_000);
});

type FleetRecord = { vehicleId: string; coordinate: [number, number]; heading: number; batteryPercentage: number;
  status: "FREE" | "WITH_CUSTOMER" | "EN_ROUTE"; serviceZoneId: string; lastOccurredAt: string; lastReceivedAt: string; isStale: boolean };
type FleetSnapshot = { data: FleetRecord[]; meta: { count: number; streamCursor: string; staleAfterSeconds: number } };

async function readEvent(response: Response, eventName: string,
  accept: (record: Omit<FleetRecord, "isStale">) => boolean = () => true): Promise<{ id: string; data: Omit<FleetRecord, "isStale"> }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response did not have a body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`SSE stream ended before ${eventName}`);
    buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r", "");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const fields = Object.fromEntries(block.split("\n").filter((line) => line.includes(":"))
        .map((line) => { const separator = line.indexOf(":"); return [line.slice(0, separator), line.slice(separator + 1).trimStart()]; }));
      if (fields.event === eventName) {
        const data = JSON.parse(fields.data!) as Omit<FleetRecord, "isStale">;
        if (accept(data)) {
          await reader.cancel();
          return { id: fields.id!, data };
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function waitForSnapshot(origin: string, expectedCount: number): Promise<FleetSnapshot> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const snapshot = await fetch(`${origin}/api/vehicles`).then((response) => response.json()) as FleetSnapshot;
    if (snapshot.data.length === expectedCount) return snapshot;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expectedCount} vehicles`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
