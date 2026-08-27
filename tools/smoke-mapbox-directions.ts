import { loadWorldCatalog } from "../packages/world/src/load.ts";
import { readFile } from "node:fs/promises";
import { MapboxDirectionsRouter, parseSimulationConfig } from "../packages/simulation/src/index.ts";

const token = process.env.MAPBOX_DIRECTIONS_ACCESS_TOKEN ?? process.env.MAPBOX_TOKEN;
if (!token) throw new Error("Set MAPBOX_DIRECTIONS_ACCESS_TOKEN or MAPBOX_TOKEN before running the Directions smoke check");

const world = await loadWorldCatalog();
const config = parseSimulationConfig(JSON.parse(await readFile("config/simulation.json", "utf8")));
const router = new MapboxDirectionsRouter(token, config.routing);
const pairs = [
  ["dst-lv-0001", "dst-lv-0041"],
  ["dst-lv-0070", "dst-lv-0140"],
  ["dst-lv-0166", "dst-lv-0200"],
] as const;

for (const [fromId, toId] of pairs) {
  const from = world.getDestination(fromId);
  const to = world.getDestination(toId);
  if (!from || !to) throw new Error(`Smoke-test destination ${fromId} or ${toId} is missing`);
  const route = await router.planRoute(from.coordinate, to, AbortSignal.timeout(10_000));
  console.log(`Directions ${fromId} → ${toId}: routable (${Math.round(route.distanceMeters)} m)`);
}
