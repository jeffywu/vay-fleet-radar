import { describe, expect, it } from "vitest";
import { SequencedFleetEventFactory, validateFleetEvent } from "../src/events/index.ts";

describe("fleet event contracts", () => {
  it("creates globally shared per-vehicle sequences and producer timestamps", () => {
    let id = 0;
    const factory = new SequencedFleetEventFactory(() => `event-${++id}`, () => new Date("2026-01-01T00:00:00.000Z"));
    const telemetry = factory.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-1",
      payload: { coordinate: [-115.1, 36.1], heading: 0, batteryPercentage: 100, status: "FREE" },
    });
    const route = factory.create({
      eventType: "route.assigned",
      vehicleId: "vehicle-1",
      correlationId: "job-1",
      payload: { routeId: "route-1", version: 1, destinationId: "dst-1", assignmentState: "ACCEPTED" },
    });
    const otherVehicle = factory.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-2",
      payload: { coordinate: [-115.2, 36.2], heading: 359.9, batteryPercentage: 0, status: "EN_ROUTE" },
    });

    expect([telemetry.sequence, route.sequence, otherVehicle.sequence]).toEqual([1, 2, 1]);
    expect(route.correlationId).toBe("job-1");
    expect(telemetry.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(() => validateFleetEvent(route)).not.toThrow();
  });

  it.each([
    ["unknown event type", { eventType: "unknown" }],
    ["invalid coordinate", { payload: { coordinate: [-181, 36], heading: 0, batteryPercentage: 100, status: "FREE" } }],
    ["out-of-range heading", { payload: { coordinate: [-115, 36], heading: 360, batteryPercentage: 100, status: "FREE" } }],
    ["non-UTC timestamp", { occurredAt: "2026-01-01T00:00:00+01:00" }],
    ["non-positive sequence", { sequence: 0 }],
  ])("rejects %s", (_name, override) => {
    const valid = {
      eventId: "event-1",
      eventType: "vehicle.telemetry-received",
      schemaVersion: 1,
      vehicleId: "vehicle-1",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { coordinate: [-115, 36], heading: 0, batteryPercentage: 100, status: "FREE" },
    };
    expect(() => validateFleetEvent({ ...valid, ...override })).toThrow(TypeError);
  });
});
