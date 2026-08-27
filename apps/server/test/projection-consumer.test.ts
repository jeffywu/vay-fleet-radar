import { describe, expect, it } from "vitest";
import { type AnyFleetEvent, SequencedFleetEventFactory } from "@fleet-radar/domain/events";
import { FleetProjectionConsumer } from "../src/eventing/FleetProjectionConsumer.ts";
import { InMemoryEventBus } from "../src/eventing/InMemoryEventBus.ts";

function factory() {
  let id = 0;
  return new SequencedFleetEventFactory(() => `event-${++id}`, () => new Date("2026-01-01T00:00:00Z"));
}

describe("FleetProjectionConsumer", () => {
  it("assigns receivedAt, ignores duplicate IDs, and does not let stale telemetry overwrite state", async () => {
    const bus = new InMemoryEventBus();
    const consumer = new FleetProjectionConsumer(bus, () => new Date("2026-01-01T00:00:10Z"));
    await consumer.start();
    const events = factory();
    const latest = events.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-1",
      occurredAt: "2025-12-31T23:59:00Z",
      payload: { coordinate: [-115.1, 36.1], heading: 90, batteryPercentage: 75, status: "FREE" },
    });
    const newer = { ...latest, eventId: "event-newer", sequence: 5, payload: { ...latest.payload, batteryPercentage: 50 } };
    const stale = { ...latest, eventId: "event-stale", sequence: 2, payload: { ...latest.payload, batteryPercentage: 1 } };

    await bus.publish(newer);
    await bus.publish(newer);
    await bus.publish(stale);

    expect(consumer.eventLog()).toHaveLength(2);
    expect(consumer.vehicle("vehicle-1")).toMatchObject({ batteryPercentage: 50, lastSequence: 5 });
    expect(consumer.vehicle("vehicle-1")?.lastReceivedAt).toBe("2026-01-01T00:00:10.000Z");
    expect(consumer.eventLog()[0].occurredAt).not.toBe(consumer.eventLog()[0].receivedAt);
  });

  it("projects only newer route versions and removes a completed active route", async () => {
    const bus = new InMemoryEventBus();
    const consumer = new FleetProjectionConsumer(bus);
    await consumer.start();
    const events = factory();
    const assigned = events.create({
      eventType: "route.assigned",
      vehicleId: "vehicle-1",
      payload: { routeId: "route-1", version: 2, destinationId: "dst-2", assignmentState: "ACCEPTED" },
    });
    const stale = {
      ...assigned,
      eventId: "event-stale-route",
      sequence: 2,
      payload: { ...assigned.payload, version: 1, destinationId: "dst-stale" },
    } satisfies AnyFleetEvent;
    await bus.publish(assigned);
    await bus.publish(stale);
    expect(consumer.route("vehicle-1")).toMatchObject({ version: 2, destinationId: "dst-2" });

    await bus.publish(events.create({
      eventType: "route.completed",
      vehicleId: "vehicle-1",
      payload: { routeId: "route-1", version: 2, destinationId: "dst-2" },
    }));
    expect(consumer.route("vehicle-1")).toBeUndefined();
  });

  it("stops consuming after cleanup", async () => {
    const bus = new InMemoryEventBus();
    const consumer = new FleetProjectionConsumer(bus);
    await consumer.start();
    await consumer.stop();
    const events = factory();
    await bus.publish(events.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-1",
      payload: { coordinate: [-115.1, 36.1], heading: 0, batteryPercentage: 80, status: "FREE" },
    }));
    expect(consumer.eventLog()).toHaveLength(0);
  });
});
