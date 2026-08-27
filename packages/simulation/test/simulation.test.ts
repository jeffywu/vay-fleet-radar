import { describe, expect, it, vi } from "vitest";
import { generateWorld, isInsideBounds, parseWorldData, type Destination } from "@fleet-radar/world";
import { WorldCatalog } from "@fleet-radar/world/load";
import { SequencedFleetEventFactory, type AnyFleetEvent, type EventPublisher } from "@fleet-radar/domain/events";
import { ConcurrencyLimiter, MapboxDirectionsRouter, RateLimiter, RequestBudget, RoutingError, SimulationEngine, SimulationEventEmitter,
  SimulationRunner, batteryPercentageForDistance, bearingDegrees, haversineMeters, interpolateLine, parseSimulationConfig, validatePlannedRoute,
  type PlannedRoute, type RoutingPort, type SimulationConfig } from "../src/index.ts";

const generated = generateWorld();
const world = new WorldCatalog(parseWorldData(generated.serviceArea, generated.serviceZones, generated.destinations));

function config(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return parseSimulationConfig({
    seed: "test", vehicleCount: 3, tickIntervalMs: 1000, timeMultiplier: 1, maximumAdvanceMs: 5000,
    customerTripProbabilityPerSimulatedMinute: 0, minimumFreeDwellSeconds: 0, maximumRouteStartsPerTick: 2,
    maximumRouteStartsPerRealMinute: 120, maximumDestinationAttempts: 3, batteryCapacityKwh: 60,
    energyConsumptionKwhPerKm: 0.18, minimumMovementBatteryPercentage: 20, rechargeThresholdPercentage: 15,
    rechargeDelaySimulatedSeconds: 120, rechargeTargetPercentage: 85, telemetryGapProbabilityPerSimulatedMinute: 0,
    minimumTelemetryGapSeconds: 5, maximumTelemetryGapSeconds: 20,
    routing: { timeoutMs: 100, maximumRetries: 0, maximumConcurrency: 2, requestsPerMinute: 100_000,
      maximumRequestsPerRun: 20, endpointSnapToleranceMeters: 150 }, ...overrides,
  });
}

function route(origin: readonly [number, number], destination: Destination, durationSeconds = 10): PlannedRoute {
  return { geometry: { type: "LineString", coordinates: [origin, destination.coordinate] },
    distanceMeters: Math.max(1, haversineMeters(origin, destination.coordinate)), durationSeconds };
}

function harness(options: { config?: SimulationConfig; random?: () => number; routing?: RoutingPort } = {}) {
  const events: AnyFleetEvent[] = [];
  const publisher: EventPublisher = { publish: vi.fn(async (event) => { events.push(structuredClone(event)); }) };
  let eventId = 0;
  const emitter = new SimulationEventEmitter(publisher, new SequencedFleetEventFactory(() => `event-${++eventId}`, () => new Date("2026-01-01T00:00:00Z")));
  const routing: RoutingPort = options.routing ?? { planRoute: vi.fn(async (origin, destination) => route(origin, destination)) };
  const engine = new SimulationEngine({ config: options.config ?? config(), world, routing, events: emitter, random: options.random });
  return { engine, events, routing };
}

describe("configuration and deterministic initialization", () => {
  it("validates field and cross-field constraints", () => {
    expect(() => config({ vehicleCount: 0 })).toThrow("vehicleCount");
    expect(() => config({ rechargeThresholdPercentage: 90 })).toThrow("rechargeTargetPercentage");
    expect(() => config({ minimumTelemetryGapSeconds: 30 })).toThrow("minimumTelemetryGapSeconds");
  });
  it("creates stable distinct vehicles from the same seed", () => {
    const first = harness().engine.snapshots();
    const second = harness().engine.snapshots();
    expect(first).toEqual(second);
    expect(first.map(({ id }) => id)).toEqual(["vehicle-0001", "vehicle-0002", "vehicle-0003"]);
    expect(new Set(first.map(({ currentDestinationId }) => currentDestinationId)).size).toBe(3);
  });
  it("changes deterministic initialization with a different seed", () => {
    const first = harness({ config: config({ seed: "first-seed" }) }).engine.snapshots();
    const second = harness({ config: config({ seed: "second-seed" }) }).engine.snapshots();
    expect(first.map(({ currentDestinationId }) => currentDestinationId))
      .not.toEqual(second.map(({ currentDestinationId }) => currentDestinationId));
  });
  it("rejects more vehicles than destinations", () => expect(() => harness({ config: config({ vehicleCount: 201 }) })).toThrow("vehicleCount"));
});

describe("movement and energy", () => {
  it("interpolates multi-segment routes, skips zero segments and normalizes heading", () => {
    const line = [[-115.2, 36.1], [-115.2, 36.1], [-115.1, 36.1], [-115.1, 36.2]] as const;
    expect(interpolateLine(line, 0).coordinate).toEqual(line[0]);
    const middle = interpolateLine(line, 0.5);
    expect(middle.coordinate[0]).toBeGreaterThanOrEqual(-115.2);
    expect(middle.heading).toBeGreaterThanOrEqual(0);
    expect(middle.heading).toBeLessThan(360);
    expect(interpolateLine(line, 1).coordinate).toEqual(line.at(-1));
    expect(bearingDegrees([0, 0], [-0.001, 1])).toBeGreaterThan(359);
  });
  it("computes proportional battery usage", () => expect(batteryPercentageForDistance(10_000, 60, 0.18)).toBeCloseTo(3));
});

describe("SimulationRunner", () => {
  it("does not overlap ticks and stops idempotently", async () => {
    const { engine } = harness();
    let finishTick!: () => void;
    const pendingTick = new Promise<void>((resolve) => { finishTick = resolve; });
    const advance = vi.spyOn(engine, "advance").mockReturnValue(pendingTick);
    let now = 0;
    let nextTimer = 0;
    const callbacks = new Map<number, () => void>();
    const runner = new SimulationRunner(engine, config(), {
      now: () => now,
      setTimeout: (callback) => {
        const id = ++nextTimer;
        callbacks.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (timer) => { callbacks.delete(timer as unknown as number); },
    });

    runner.start();
    runner.start();
    expect(callbacks.size).toBe(1);
    const [timerId, callback] = callbacks.entries().next().value!;
    callbacks.delete(timerId);
    now = 1_000;
    callback();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    finishTick();
    await pendingTick;
    await Promise.resolve();
    expect(callbacks.size).toBe(1);
    await runner.stop();
    await runner.stop();
    expect(callbacks.size).toBe(0);
  });
});

describe("dispatch command boundary", () => {
  it("accepts idempotently, moves, completes once and clears ephemeral geometry", async () => {
    const { engine, events, routing } = harness();
    const vehicle = engine.snapshots()[0];
    const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    const command = { commandId: "command-1", dispatchJobId: "job-1", vehicleId: vehicle.id, routeId: "route-1", routeVersion: 1, destinationId: destination.id };
    const first = await engine.assignRoute(command);
    expect(await engine.assignRoute(command)).toEqual(first);
    expect(first).toEqual({ accepted: true, routeId: "route-1", routeVersion: 1 });
    expect(routing.planRoute).toHaveBeenCalledTimes(1);
    expect(engine.activeRoutes.listDispatchRoutes()).toHaveLength(1);
    await engine.advance(11_000);
    expect(engine.snapshots()[0]).toMatchObject({ status: "FREE", currentDestinationId: destination.id });
    expect(engine.activeRoutes.get("route-1")).toBeUndefined();
    expect(events.filter(({ eventType }) => eventType === "route.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("geometry");
  });
  it("accepts a new version-one route after a vehicle completes an earlier route", async () => {
    const { engine } = harness();
    const vehicle = engine.snapshots()[0];
    const firstDestination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    await expect(engine.assignRoute({ commandId: "command-1", dispatchJobId: "job-1", vehicleId: vehicle.id,
      routeId: "route-1", routeVersion: 1, destinationId: firstDestination.id })).resolves.toMatchObject({ accepted: true });
    await engine.advance(11_000);
    const secondDestination = world.destinations.find((value) => value.id !== firstDestination.id)!;
    await expect(engine.assignRoute({ commandId: "command-2", dispatchJobId: "job-2", vehicleId: vehicle.id,
      routeId: "route-2", routeVersion: 1, destinationId: secondDestination.id })).resolves.toEqual({
      accepted: true, routeId: "route-2", routeVersion: 1,
    });
  });
  it("coalesces concurrent retries of one assignment command", async () => {
    let finishRoute!: (value: PlannedRoute) => void;
    const deferred = new Promise<PlannedRoute>((resolve) => { finishRoute = resolve; });
    const { engine, events, routing } = harness({ routing: { planRoute: vi.fn(() => deferred) } });
    const vehicle = engine.snapshots()[0];
    const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    const command = { commandId: "same-command", dispatchJobId: "job", vehicleId: vehicle.id, routeId: "route", routeVersion: 1, destinationId: destination.id };
    const first = engine.assignRoute(command);
    const retry = engine.assignRoute(command);
    finishRoute(route(vehicle.coordinate, destination));

    await expect(Promise.all([first, retry])).resolves.toEqual([
      { accepted: true, routeId: "route", routeVersion: 1 },
      { accepted: true, routeId: "route", routeVersion: 1 },
    ]);
    expect(routing.planRoute).toHaveBeenCalledTimes(1);
    expect(events.filter(({ eventType }) => eventType === "route.assigned")).toHaveLength(1);
    expect(events.filter(({ eventType }) => eventType === "route.assignment-rejected")).toHaveLength(0);
  });
  it("cancels only the matching version and returns isolated store views", async () => {
    const { engine } = harness();
    const vehicle = engine.snapshots()[0];
    const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    await engine.assignRoute({ commandId: "a", dispatchJobId: "j", vehicleId: vehicle.id, routeId: "r", routeVersion: 1, destinationId: destination.id });
    const view = engine.activeRoutes.get("r")!;
    view.geometry.coordinates[0][0] = 0;
    expect(engine.activeRoutes.get("r")!.geometry.coordinates[0][0]).not.toBe(0);
    expect(await engine.cancelRoute({ commandId: "c1", vehicleId: vehicle.id, routeId: "r", routeVersion: 2 })).toMatchObject({ cancelled: false });
    expect(await engine.cancelRoute({ commandId: "c2", vehicleId: vehicle.id, routeId: "r", routeVersion: 1 })).toEqual({ cancelled: true });
    expect(engine.activeRoutes.get("r")).toBeUndefined();
  });
  it("rejects invalid and failed-route commands with stable reasons", async () => {
    const failed = harness({ routing: { planRoute: vi.fn().mockRejectedValue(new RoutingError("NO_ROUTE")) } });
    expect(await failed.engine.assignRoute({ commandId: "x", dispatchJobId: "j", vehicleId: "missing", routeId: "r", routeVersion: 1, destinationId: world.destinations[0].id }))
      .toEqual({ accepted: false, reason: "UNKNOWN_VEHICLE" });
    const vehicle = failed.engine.snapshots()[0];
    expect(await failed.engine.assignRoute({ commandId: "y", dispatchJobId: "j", vehicleId: vehicle.id, routeId: "r", routeVersion: 1, destinationId: world.destinations[1].id }))
      .toEqual({ accepted: false, reason: "ROUTING_UNAVAILABLE" });
  });
});

describe("customer trips, telemetry and integration", () => {
  it("starts a customer trip only after routing and returns to FREE", async () => {
    let randomValue = 0;
    let finishRoute!: (value: PlannedRoute) => void;
    const deferred = new Promise<PlannedRoute>((resolve) => { finishRoute = resolve; });
    const { engine } = harness({ config: config({ vehicleCount: 1, customerTripProbabilityPerSimulatedMinute: 1 }), random: () => randomValue,
      routing: { planRoute: vi.fn(() => deferred) } });
    await engine.advance(1_000);
    expect(engine.snapshots()[0]).toMatchObject({ status: "FREE", routePending: true });
    randomValue = 1;
    const vehicle = engine.snapshots()[0];
    const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    finishRoute(route(vehicle.coordinate, destination));
    await engine.settle();
    expect(engine.snapshots()[0].status).toBe("WITH_CUSTOMER");
    await engine.advance(11_000);
    expect(engine.snapshots()[0].status).toBe("FREE");
  });
  it("does not try other destinations for a terminal routing failure", async () => {
    const routing: RoutingPort = { planRoute: vi.fn().mockRejectedValue(new RoutingError("AUTHENTICATION")) };
    const { engine } = harness({ config: config({ vehicleCount: 1, customerTripProbabilityPerSimulatedMinute: 1 }), random: () => 0, routing });
    await engine.advance(1_000);
    await engine.settle();
    expect(routing.planRoute).toHaveBeenCalledTimes(1);
    expect(engine.snapshots()[0]).toMatchObject({ status: "FREE", routePending: false });
  });
  it("supports ten simultaneous dispatch routes across a 100-vehicle fleet", async () => {
    const { engine, events } = harness({ config: config({ vehicleCount: 100 }) });
    for (let index = 0; index < 10; index += 1) {
      const vehicle = engine.snapshots()[index];
      const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
      await engine.assignRoute({ commandId: `c-${index}`, dispatchJobId: `j-${index}`, vehicleId: vehicle.id,
        routeId: `r-${index}`, routeVersion: 1, destinationId: destination.id });
    }
    expect(engine.snapshots().filter(({ status }) => status === "EN_ROUTE")).toHaveLength(10);
    expect(engine.activeRoutes.listDispatchRoutes()).toHaveLength(10);
    await engine.advance(1_000);
    const sequences = events.reduce<Record<string, number[]>>((result, event) => ((result[event.vehicleId] ??= []).push(event.sequence), result), {});
    for (const values of Object.values(sequences)) expect(values).toEqual([...values].sort((a, b) => a - b));
    await engine.shutdown();
    expect(engine.activeRoutes.listDispatchRoutes()).toHaveLength(0);
  });
  it("suppresses samples during a deterministic telemetry gap and emits the recovered state", async () => {
    const { engine, events } = harness({ config: config({ vehicleCount: 1, telemetryGapProbabilityPerSimulatedMinute: 1,
      minimumTelemetryGapSeconds: 5, maximumTelemetryGapSeconds: 5 }), random: () => 0 });
    await engine.advance(1_000);
    expect(events.filter(({ eventType }) => eventType === "vehicle.telemetry-received")).toHaveLength(1);
    await engine.advance(1_000);
    expect(events.filter(({ eventType }) => eventType === "vehicle.telemetry-received")).toHaveLength(1);
    await engine.advance(5_000);
    expect(events.filter(({ eventType }) => eventType === "vehicle.telemetry-received")).toHaveLength(2);
  });
  it("publishes route lifecycle events but not telemetry during a gap", async () => {
    const { engine, events } = harness({ config: config({ vehicleCount: 1, telemetryGapProbabilityPerSimulatedMinute: 1,
      minimumTelemetryGapSeconds: 5, maximumTelemetryGapSeconds: 5 }), random: () => 0 });
    await engine.advance(1_000);
    await engine.advance(1_000);
    const vehicle = engine.snapshots()[0];
    const destination = world.destinations.find((value) => value.id !== vehicle.currentDestinationId)!;
    await engine.assignRoute({ commandId: "gap-command", dispatchJobId: "gap-job", vehicleId: vehicle.id,
      routeId: "gap-route", routeVersion: 1, destinationId: destination.id });
    expect(events.filter(({ eventType }) => eventType === "route.assigned")).toHaveLength(1);
    expect(events.filter(({ eventType }) => eventType === "vehicle.telemetry-received")).toHaveLength(1);
  });
  it("applies the bounded demo recharge rule without a new display status", async () => {
    const { engine } = harness({ config: config({ vehicleCount: 1, rechargeThresholdPercentage: 90,
      rechargeTargetPercentage: 95, rechargeDelaySimulatedSeconds: 1 }), random: () => 0 });
    await engine.advance(1_000);
    expect(engine.snapshots()[0]).toMatchObject({ status: "FREE", rechargeUntilSimulatedMs: 2_000 });
    await engine.advance(1_000);
    expect(engine.snapshots()[0]).toMatchObject({ status: "FREE", batteryPercentage: 95, rechargeUntilSimulatedMs: undefined });
  });
  it("keeps a deterministic 100-vehicle run bounded with monotonic event sequences", async () => {
    const { engine, events } = harness({ config: config({ vehicleCount: 100, customerTripProbabilityPerSimulatedMinute: 0.5,
      maximumRouteStartsPerTick: 3 }), random: (() => { let value = 0; return () => (value = (value + 0.173) % 1); })() });
    for (let tick = 0; tick < 20; tick += 1) {
      await engine.advance(1_000);
      await engine.settle();
    }
    expect(engine.snapshots()).toHaveLength(100);
    expect(engine.snapshots().every(({ coordinate }) => isInsideBounds(coordinate))).toBe(true);
    expect(new Set(engine.snapshots().flatMap(({ activeRouteId }) => activeRouteId ? [activeRouteId] : [])).size)
      .toBe(engine.snapshots().filter(({ activeRouteId }) => activeRouteId).length);
    const sequences = events.reduce<Record<string, number[]>>((result, event) => ((result[event.vehicleId] ??= []).push(event.sequence), result), {});
    for (const values of Object.values(sequences)) expect(values).toEqual([...values].sort((left, right) => left - right));
  });
});

describe("route validation and controls", () => {
  it("validates metrics and endpoint snapping", () => {
    const destination = world.destinations[1];
    const valid = route(world.destinations[0].coordinate, destination);
    expect(validatePlannedRoute(valid, world.destinations[0].coordinate, destination, 1)).toEqual(valid);
    expect(() => validatePlannedRoute({ ...valid, distanceMeters: 0 }, world.destinations[0].coordinate, destination, 1)).toThrow("invalid metrics");
    expect(() => validatePlannedRoute(valid, [0, 0], destination, 1)).toThrow("snap tolerance");
  });
  it("enforces per-run request budget", () => {
    const budget = new RequestBudget(1);
    budget.reserve();
    expect(() => budget.reserve()).toThrowError(expect.objectContaining({ code: "BUDGET_EXHAUSTED" }));
  });
  it("spaces starts using injected fake time", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(60, () => now, async (milliseconds) => { waits.push(milliseconds); now += milliseconds; });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([1_000, 1_000]);
  });
  it("never exceeds the concurrency ceiling", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = Array.from({ length: 4 }, () => limiter.use(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
    }));
    await Promise.resolve();
    release();
    await Promise.all(jobs);
    expect(maximum).toBe(2);
  });
});

describe("Mapbox Directions adapter", () => {
  it("translates a minimal response without leaking provider fields", async () => {
    const origin = world.destinations[0].coordinate;
    const destination = world.destinations[1];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("geometries=geojson");
      return new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: { type: "LineString", coordinates: [origin, destination.coordinate] }, distance: 100, duration: 10, provider: "ignored" }] }), { status: 200 });
    });
    const router = new MapboxDirectionsRouter("secret-test-token", config().routing, { fetch: fetchMock });
    await expect(router.planRoute(origin, destination)).resolves.toEqual({ geometry: { type: "LineString", coordinates: [origin, destination.coordinate] }, distanceMeters: 100, durationSeconds: 10 });
    expect(JSON.stringify(router.metrics())).not.toContain("secret-test-token");
  });
  it.each([[401, "AUTHENTICATION"], [429, "RATE_LIMITED"], [500, "PROVIDER_UNAVAILABLE"]] as const)("maps HTTP %s to %s", async (status, code) => {
    const router = new MapboxDirectionsRouter("token", config().routing, { fetch: vi.fn(async () => new Response("{}", { status })) });
    await expect(router.planRoute(world.destinations[0].coordinate, world.destinations[1])).rejects.toMatchObject({ code });
  });
  it("translates provider no-route bodies on non-success responses", async () => {
    const router = new MapboxDirectionsRouter("token", config().routing, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ code: "NoSegment", message: "provider detail" }), { status: 422 })),
    });
    await expect(router.planRoute(world.destinations[0].coordinate, world.destinations[1])).rejects.toMatchObject({ code: "NO_SEGMENT" });
  });
  it("does not retain a token-bearing native fetch error", async () => {
    const token = "secret-never-surface";
    const router = new MapboxDirectionsRouter(token, config().routing, { fetch: vi.fn(async () => { throw new TypeError(`failed https://example.test?access_token=${token}`); }) });
    const error = await router.planRoute(world.destinations[0].coordinate, world.destinations[1]).catch((failure: unknown) => failure);
    expect(String(error)).not.toContain(token);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
  it("maps caller cancellation independently", async () => {
    const controller = new AbortController();
    controller.abort();
    const router = new MapboxDirectionsRouter("token", config().routing, { fetch: vi.fn() });
    await expect(router.planRoute(world.destinations[0].coordinate, world.destinations[1], controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("does not start a provider request when cancelled in the concurrency queue", async () => {
    const origin = world.destinations[0].coordinate;
    const destination = world.destinations[1];
    let release!: () => void;
    const firstResponse = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: { type: "LineString",
        coordinates: [origin, destination.coordinate] }, distance: 1, duration: 1 }] }), { status: 200 }));
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(new Response("unexpected request", { status: 500 }));
    const router = new MapboxDirectionsRouter("token", { ...config().routing, maximumConcurrency: 1 },
      { fetch: fetchMock, delay: async () => undefined });
    const first = router.planRoute(origin, destination);
    await Promise.resolve();
    const controller = new AbortController();
    const queued = router.planRoute(origin, destination, controller.signal);
    controller.abort();
    release();
    await expect(first).resolves.toMatchObject({ distanceMeters: 1 });
    await expect(queued).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries transient failures without sleeping in tests", async () => {
    const origin = world.destinations[0].coordinate;
    const destination = world.destinations[1];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "Ok", routes: [{ geometry: { type: "LineString", coordinates: [origin, destination.coordinate] }, distance: 1, duration: 1 }] }), { status: 200 }));
    const routingConfig = { ...config().routing, maximumRetries: 1 };
    const router = new MapboxDirectionsRouter("token", routingConfig, { fetch: fetchMock, delay: async () => undefined });
    await expect(router.planRoute(origin, destination)).resolves.toMatchObject({ distanceMeters: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.metrics()).toMatchObject({ attempts: 2, retries: 1, successes: 1 });
  });
  it("times out an unresponsive provider", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const router = new MapboxDirectionsRouter("token", { ...config().routing, timeoutMs: 10 }, { fetch: fetchMock });
    const result = router.planRoute(world.destinations[0].coordinate, world.destinations[1]);
    const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    vi.useRealTimers();
  });
});
