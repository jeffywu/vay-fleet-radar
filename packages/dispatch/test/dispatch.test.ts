import { describe, expect, it } from "vitest";
import { generateWorld, parseWorldData } from "@fleet-radar/world";
import { WorldCatalog } from "@fleet-radar/world/load";
import { RandomDispatchStrategy, type DispatchVehicle } from "../src/index.ts";

const generated = generateWorld();
const world = new WorldCatalog(parseWorldData(generated.serviceArea, generated.serviceZones, generated.destinations));

describe("RandomDispatchStrategy", () => {
  it("assigns a catalog destination to an eligible free vehicle", () => {
    const vehicles: DispatchVehicle[] = [
      { id: "busy", coordinate: [-115.1, 36.1], batteryPercentage: 80, status: "WITH_CUSTOMER" },
      { id: "low", coordinate: [-115.2, 36.1], batteryPercentage: 10, status: "FREE" },
      { id: "eligible", coordinate: [-115.15, 36.12], batteryPercentage: 70, status: "FREE" },
    ];
    const assignment = new RandomDispatchStrategy(() => 0).assign(vehicles, world);
    expect(assignment?.vehicle.id).toBe("eligible");
    expect(assignment?.destination).toBe(world.destinations[0]);
  });

  it("returns no assignment when operational rules exclude every vehicle", () => {
    const vehicles: DispatchVehicle[] = [{ id: "low", coordinate: [-115.2, 36.1], batteryPercentage: 10, status: "FREE" }];
    expect(new RandomDispatchStrategy(() => 0).assign(vehicles, world)).toBeUndefined();
  });
});

