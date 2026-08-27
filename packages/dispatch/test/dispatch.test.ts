import { describe, expect, it, vi } from "vitest";
import { SequencedFleetEventFactory, type EventPublisher } from "@fleet-radar/domain/events";
import type { VehicleCommandPort } from "@fleet-radar/domain/commands";
import { generateWorld, parseWorldData } from "@fleet-radar/world";
import { WorldCatalog } from "@fleet-radar/world/load";
import { DispatchEngine, DispatchEventEmitter, RandomDispatchStrategy, type DispatchVehicle } from "../src/index.ts";

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

  it("submits a destination-only command without importing routing", async () => {
    const commands: VehicleCommandPort = {
      assignRoute: vi.fn().mockResolvedValue({ accepted: true, routeId: "route-000001", routeVersion: 1 }),
      cancelRoute: vi.fn(),
    };
    const publisher: EventPublisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const engine = new DispatchEngine(new RandomDispatchStrategy(() => 0), commands,
      new DispatchEventEmitter(publisher, new SequencedFleetEventFactory()), "random");
    await engine.assignOne([{ id: "vehicle-1", coordinate: [-115.2, 36.1], batteryPercentage: 80, status: "FREE",
      currentDestinationId: world.destinations[0].id }], world);
    expect(commands.assignRoute).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: "vehicle-1", destinationId: world.destinations[1].id }));
    expect(JSON.stringify(vi.mocked(commands.assignRoute).mock.calls)).not.toContain("geometry");
  });
});
