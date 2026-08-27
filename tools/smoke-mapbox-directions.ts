import { loadWorldCatalog } from "../packages/world/src/load.ts";

const token = process.env.MAPBOX_DIRECTIONS_ACCESS_TOKEN ?? process.env.MAPBOX_TOKEN;
if (!token) throw new Error("Set MAPBOX_DIRECTIONS_ACCESS_TOKEN or MAPBOX_TOKEN before running the Directions smoke check");

const world = await loadWorldCatalog();
const pairs = [
  ["dst-lv-0001", "dst-lv-0041"],
  ["dst-lv-0070", "dst-lv-0140"],
  ["dst-lv-0166", "dst-lv-0200"],
] as const;

for (const [fromId, toId] of pairs) {
  const from = world.getDestination(fromId);
  const to = world.getDestination(toId);
  if (!from || !to) throw new Error(`Smoke-test destination ${fromId} or ${toId} is missing`);
  const coordinates = `${from.coordinate.join(",")};${to.coordinate.join(",")}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("overview", "false");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = (await response.json()) as { code?: string; routes?: unknown[]; message?: string };
  if (!response.ok || body.code !== "Ok" || !body.routes?.length) {
    throw new Error(`Directions ${fromId} → ${toId} failed (${response.status}, ${body.code ?? body.message ?? "unknown"})`);
  }
  console.log(`Directions ${fromId} → ${toId}: routable`);
}

