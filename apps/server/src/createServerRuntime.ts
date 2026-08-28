import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DispatchEngine, DispatchEventEmitter, RandomDispatchStrategy } from "@fleet-radar/dispatch";
import { SequencedFleetEventFactory } from "@fleet-radar/domain/events";
import { ActiveRouteStore, MapboxDirectionsRouter, parseSimulationConfig, SimulationEngine, SimulationEventEmitter,
  SimulationRunner, UnavailableRouter, type RoutingPort, type SimulationConfig } from "@fleet-radar/simulation";
import { defaultWorldPaths, loadWorldCatalog } from "@fleet-radar/world/load";
import type { WorldCatalogView } from "@fleet-radar/world";
import { seededRandom } from "@fleet-radar/world";
import { createApiServer } from "./api/createApiServer.ts";
import { loadServerConfig, type ServerConfig } from "./config/loadServerConfig.ts";
import { createDatabasePool, verifyDatabase } from "./database/pool.ts";
import { resetSimulationState } from "./database/resetSimulationState.ts";
import { DispatchJobRepository } from "./database/DispatchJobRepository.ts";
import { FleetReadRepository } from "./database/FleetReadRepository.ts";
import { DispatchRunner } from "./dispatch/DispatchRunner.ts";
import { PostgresFleetEventConsumer } from "./eventing/PostgresFleetEventConsumer.ts";
import { ProjectionReducer } from "./eventing/ProjectionReducer.ts";
import { InMemoryEventBus } from "./eventing/InMemoryEventBus.ts";

export type CreateServerRuntimeOptions = { repositoryRoot?: string; serverConfig?: ServerConfig; simulationConfig?: SimulationConfig;
  world?: WorldCatalogView; routing?: RoutingPort; directionsToken?: string };

export async function createServerRuntime(options: CreateServerRuntimeOptions = {}) {
  const root = options.repositoryRoot ?? process.cwd();
  const serverConfig = options.serverConfig ?? loadServerConfig();
  const pool = createDatabasePool(serverConfig);
  await verifyDatabase(pool);
  try {
    const [world, simulationConfig] = await Promise.all([
      options.world ?? loadWorldCatalog(defaultWorldPaths(root)),
      options.simulationConfig ?? readFile(resolve(root, "config/simulation.json"), "utf8").then((text) => {
        const input = JSON.parse(text) as Record<string, unknown>;
        const maximumRequests = process.env.ROUTING_MAX_REQUESTS_PER_RUN;
        if (maximumRequests === undefined || maximumRequests === "") return parseSimulationConfig(input);
        return parseSimulationConfig({ ...input, routing: {
          ...(input.routing as Record<string, unknown>), maximumRequestsPerRun: Number(maximumRequests),
        } });
      }),
    ]);
    await resetSimulationState(pool);
    const factory = new SequencedFleetEventFactory();
    const bus = new InMemoryEventBus();
    const consumer = new PostgresFleetEventConsumer(bus, pool, new ProjectionReducer(world));
    await consumer.start();
    const dispatchJobs = new DispatchJobRepository(pool);
    const routes = new ActiveRouteStore();
    const token = options.directionsToken ?? process.env.MAPBOX_DIRECTIONS_ACCESS_TOKEN ?? process.env.MAPBOX_TOKEN ?? "";
    const routing = options.routing ?? (token ? new MapboxDirectionsRouter(token, simulationConfig.routing) : new UnavailableRouter());
    const engine = new SimulationEngine({ config: simulationConfig, world, routing, routes,
      events: new SimulationEventEmitter(bus, factory) });
    const runner = new SimulationRunner(engine, simulationConfig);
    const dispatch = new DispatchEngine(new RandomDispatchStrategy(seededRandom(`${simulationConfig.seed}-dispatch`)), engine,
      new DispatchEventEmitter(bus, factory), "random", () => crypto.randomUUID());
    const routingState = () => routing instanceof UnavailableRouter ||
      (routing instanceof MapboxDirectionsRouter && routing.metrics().remainingBudget <= 0) ? "degraded" as const : "ready" as const;
    const dispatchRunner = new DispatchRunner(dispatch, new FleetReadRepository(pool, serverConfig.staleAfterSeconds),
      dispatchJobs, world, serverConfig.dispatchTargetActive, serverConfig.dispatchIntervalMs,
      serverConfig.dispatchMaxPerCycle, () => routingState() === "ready");
    const { app, hub } = await createApiServer({ pool, config: serverConfig, routes,
      health: { database: async () => { await pool.query("SELECT 1"); return true; }, consumer: () => consumer.status(), routing: routingState },
      repositoryRoot: root });
    let started = false;
    let closed = false;
    return {
      app, pool, consumer, engine, runner, dispatch, dispatchRunner, routes, bus,
      async start() {
        if (started) return;
        await hub.start();
        await app.listen({ host: serverConfig.host, port: serverConfig.port });
        runner.start();
        dispatchRunner.start();
        started = true;
      },
      async close() {
        if (closed) return;
        closed = true;
        const closingHttp = app.close().catch(() => undefined);
        await dispatchRunner.stop().catch(() => undefined);
        await runner.stop().catch(() => undefined);
        await engine.shutdown().catch(() => undefined);
        await bus.flush().catch(() => undefined);
        await consumer.stop().catch(() => undefined);
        await hub.stop().catch(() => undefined);
        await closingHttp;
        routes.clear();
        await pool.end();
      },
    };
  } catch (error) { await pool.end(); throw error; }
}
