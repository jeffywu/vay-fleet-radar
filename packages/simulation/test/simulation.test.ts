import { describe, expect, it, vi } from "vitest";
import { generateWorld, parseWorldData, type WorldCatalogView } from "@fleet-radar/world";
import { WorldCatalog } from "@fleet-radar/world/load";
import { startSimulatedTrip, type RoutingPort } from "../src/index.ts";

function catalog(): WorldCatalogView {
  const world = generateWorld();
  return new WorldCatalog(parseWorldData(world.serviceArea, world.serviceZones, world.destinations));
}

describe("simulated destination selection", () => {
  it("selects only catalog destinations and routes through the injected port", async () => {
    const routing: RoutingPort = {
      route: vi.fn().mockResolvedValue({ geometry: [[-115.2, 36.1], [-115.18, 36.12]], distanceMeters: 1000, durationSeconds: 120 }),
    };
    const trip = await startSimulatedTrip([-115.2, 36.1], catalog(), routing, () => 0.5);
    expect(trip.destination.id).toBe("dst-lv-0101");
    expect(routing.route).toHaveBeenCalledWith([-115.2, 36.1], trip.destination.coordinate);
  });
});

