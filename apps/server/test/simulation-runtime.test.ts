import { describe, expect, it } from "vitest";
import { generateWorld, parseWorldData } from "@fleet-radar/world";
import { WorldCatalog } from "@fleet-radar/world/load";
import { parseSimulationConfig, type RoutingPort } from "@fleet-radar/simulation";
import { createSimulationRuntime } from "../src/simulation/createSimulationRuntime.ts";

const generated = generateWorld();
const world = new WorldCatalog(parseWorldData(generated.serviceArea, generated.serviceZones, generated.destinations));
const config = parseSimulationConfig({
  seed: "runtime", vehicleCount: 2, tickIntervalMs: 1000, timeMultiplier: 1, maximumAdvanceMs: 5000,
  customerTripProbabilityPerSimulatedMinute: 0, minimumFreeDwellSeconds: 30, maximumRouteStartsPerTick: 1,
  maximumRouteStartsPerRealMinute: 10, maximumDestinationAttempts: 1, batteryCapacityKwh: 60,
  energyConsumptionKwhPerKm: 0.18, minimumMovementBatteryPercentage: 20, rechargeThresholdPercentage: 15,
  rechargeDelaySimulatedSeconds: 120, rechargeTargetPercentage: 85, telemetryGapProbabilityPerSimulatedMinute: 0,
  minimumTelemetryGapSeconds: 5, maximumTelemetryGapSeconds: 20,
  routing: { timeoutMs: 100, maximumRetries: 0, maximumConcurrency: 1, requestsPerMinute: 100,
    maximumRequestsPerRun: 10, endpointSnapToleranceMeters: 150 },
});

describe("simulation runtime composition", () => {
  it("starts in an explicit stationary degraded state without a server token", async () => {
    const runtime = await createSimulationRuntime({ world, config, token: "" });
    expect(runtime.routingHealth()).toEqual({ state: "DEGRADED", reason: "MISSING_DIRECTIONS_TOKEN" });
    await runtime.engine.advance(1000);
    expect(runtime.engine.snapshots()).toHaveLength(2);
    await runtime.close();
  });

  it("accepts an injected router for deterministic tests", async () => {
    const routing: RoutingPort = { planRoute: async (origin, destination) => ({ geometry: { type: "LineString", coordinates: [origin, destination.coordinate] }, distanceMeters: 1, durationSeconds: 1 }) };
    const runtime = await createSimulationRuntime({ world, config, routing });
    expect(runtime.engine.snapshots()).toHaveLength(2);
    await runtime.close();
    await runtime.close();
  });

  it("surfaces an exhausted routing budget before starting movement", async () => {
    const exhaustedConfig = { ...config, routing: { ...config.routing, maximumRequestsPerRun: 0 } };
    const runtime = await createSimulationRuntime({ world, config: exhaustedConfig, token: "server-test-token" });
    expect(runtime.routingHealth()).toMatchObject({ state: "DEGRADED", reason: "BUDGET_EXHAUSTED" });
    await runtime.close();
  });
});
