import { describe, expect, it } from "vitest";
import { createEventBoundary } from "../src/eventing/createEventBoundary.ts";

describe("event boundary composition", () => {
  it("wires simulation and dispatch producers through domain ports into projections", async () => {
    const boundary = await createEventBoundary();
    await boundary.simulationEvents.publishTelemetry({
      vehicleId: "vehicle-1",
      coordinate: [-115.1, 36.1],
      heading: 45,
      batteryPercentage: 80,
      status: "FREE",
    });
    await boundary.dispatchEvents.publishAssignmentRequested({
      dispatchJobId: "job-1",
      commandId: "assign-1",
      vehicleId: "vehicle-1",
      routeId: "route-1",
      routeVersion: 1,
      destinationId: "dst-lv-0001",
      strategy: "random",
    });
    await boundary.simulationEvents.publishRouteAssigned({
      dispatchJobId: "job-1",
      vehicleId: "vehicle-1",
      routeId: "route-1",
      version: 1,
      destinationId: "dst-lv-0001",
    });

    expect(boundary.consumer.eventLog().map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(boundary.consumer.vehicle("vehicle-1")?.status).toBe("FREE");
    expect(boundary.consumer.route("vehicle-1")?.routeId).toBe("route-1");
    expect(boundary.consumer.dispatchJob("job-1")).toMatchObject({ commandId: "assign-1", state: "REQUESTED", strategy: "random" });
    await boundary.close();
  });
});
