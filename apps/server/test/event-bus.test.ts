import { describe, expect, it, vi } from "vitest";
import { SequencedFleetEventFactory } from "@fleet-radar/domain/events";
import { InMemoryEventBus } from "../src/eventing/InMemoryEventBus.ts";

function fixture() {
  let id = 0;
  const factory = new SequencedFleetEventFactory(() => `event-${++id}`, () => new Date("2026-01-01T00:00:00Z"));
  return () => factory.create({
    eventType: "vehicle.telemetry-received",
    vehicleId: "vehicle-1",
    payload: { coordinate: [-115.1, 36.1], heading: 90, batteryPercentage: 75, status: "FREE" },
  });
}

describe("InMemoryEventBus", () => {
  it("delivers concurrent publishes asynchronously and in call order", async () => {
    const event = fixture();
    const bus = new InMemoryEventBus();
    const received: number[] = [];
    await bus.subscribe(async (value) => {
      await Promise.resolve();
      received.push(value.sequence);
    });

    const first = bus.publish(event());
    expect(received).toEqual([]);
    await Promise.all([first, bus.publish(event()), bus.publish(event())]);
    expect(received).toEqual([1, 2, 3]);
  });

  it("fan-outs to subscribers and supports idempotent unsubscribe", async () => {
    const event = fixture();
    const bus = new InMemoryEventBus();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = await bus.subscribe(first);
    await bus.subscribe(second);
    await bus.publish(event());
    await unsubscribe();
    await unsubscribe();
    await bus.publish(event());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("accepts an immutable transport copy that producer mutation cannot change", async () => {
    const event = fixture()();
    const bus = new InMemoryEventBus();
    let received: typeof event | undefined;
    await bus.subscribe(async (value) => {
      received = value as typeof event;
    });

    const delivery = bus.publish(event);
    (event.payload as { batteryPercentage: number }).batteryPercentage = 1;
    await delivery;

    expect(received?.payload.batteryPercentage).toBe(75);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.payload)).toBe(true);
  });

  it("reports handler failures, still attempts all handlers, and continues the queue", async () => {
    const event = fixture();
    const bus = new InMemoryEventBus();
    const failing = vi.fn().mockRejectedValueOnce(new Error("projection unavailable")).mockResolvedValue(undefined);
    const healthy = vi.fn().mockResolvedValue(undefined);
    await bus.subscribe(failing);
    await bus.subscribe(healthy);

    await expect(bus.publish(event())).rejects.toThrow("Failed to deliver fleet event event-1");
    expect(healthy).toHaveBeenCalledTimes(1);
    await expect(bus.publish(event())).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed events at ingress", async () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.publish({ eventId: "bad" } as never)).toThrow(TypeError);
  });
});
