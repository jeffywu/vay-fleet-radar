import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorldCatalogView } from "@fleet-radar/world";
import { defaultWorldPaths, loadWorldCatalog } from "@fleet-radar/world/load";
import { ActiveRouteStore, MapboxDirectionsRouter, parseSimulationConfig, SimulationEngine, SimulationRunner,
  type RoutingPort, type SimulationConfig, UnavailableRouter } from "@fleet-radar/simulation";
import { createEventBoundary } from "../eventing/createEventBoundary.ts";

export type CreateSimulationRuntimeOptions = {
  readonly repositoryRoot?: string;
  readonly token?: string;
  readonly world?: WorldCatalogView;
  readonly config?: SimulationConfig;
  readonly routing?: RoutingPort;
};

export async function createSimulationRuntime(options: CreateSimulationRuntimeOptions = {}) {
  const root = options.repositoryRoot ?? process.cwd();
  const [world, config] = await Promise.all([
    options.world ?? loadWorldCatalog(defaultWorldPaths(root)),
    options.config ?? readFile(resolve(root, "config/simulation.json"), "utf8").then((json) => parseSimulationConfig(JSON.parse(json))),
  ]);
  const boundary = await createEventBoundary();
  const routes = new ActiveRouteStore();
  const token = options.token ?? process.env.MAPBOX_DIRECTIONS_ACCESS_TOKEN ?? "";
  const routing = options.routing ?? (token ? new MapboxDirectionsRouter(token, config.routing) : new UnavailableRouter());
  const engine = new SimulationEngine({ config, world, routing, routes, events: boundary.simulationEvents });
  const runner = new SimulationRunner(engine, config);
  let closed = false;
  return {
    engine, runner, routes,
    routingHealth() {
      if (!(routing instanceof MapboxDirectionsRouter)) return { state: "DEGRADED" as const, reason: "MISSING_DIRECTIONS_TOKEN" as const };
      const metrics = routing.metrics();
      if (metrics.remainingBudget === 0) return { state: "DEGRADED" as const, reason: "BUDGET_EXHAUSTED" as const, metrics };
      if ((metrics.failures.AUTHENTICATION ?? 0) > 0) return { state: "DEGRADED" as const, reason: "AUTHENTICATION" as const, metrics };
      return { state: "AVAILABLE" as const, metrics };
    },
    start() { runner.start(); },
    async close() {
      if (closed) return;
      closed = true;
      try { await runner.stop(); }
      finally { await boundary.close(); }
    },
  };
}
