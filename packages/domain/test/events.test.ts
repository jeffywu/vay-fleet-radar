import { describe, expect, it } from "vitest";
import { parseFleetEvent, SequencedFleetEventFactory, validateFleetEvent } from "../src/events/index.ts";

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

  it("hydrates persisted sequence maxima before creating new events", () => {
    const factory = new SequencedFleetEventFactory(() => "event-next");
    factory.initializeSequences(new Map([["vehicle-1", 42], ["vehicle-2", 7]]));

    expect(factory.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-1",
      payload: { coordinate: [-115, 36], heading: 0, batteryPercentage: 100, status: "FREE" },
    }).sequence).toBe(43);
    expect(factory.create({
      eventType: "vehicle.telemetry-received",
      vehicleId: "vehicle-3",
      payload: { coordinate: [-115, 36], heading: 0, batteryPercentage: 100, status: "FREE" },
    }).sequence).toBe(1);
  });

  it("rejects invalid hydration and sequence rollback", () => {
    const factory = new SequencedFleetEventFactory();
    factory.initializeSequences([["vehicle-1", 3]]);
    expect(() => factory.initializeSequences([["vehicle-1", 2]])).toThrow(RangeError);
    expect(() => factory.initializeSequences([["", 1]])).toThrow(TypeError);
    expect(() => factory.initializeSequences([["vehicle-2", -1]])).toThrow(TypeError);
  });

  it("parses only the exact canonical envelope", () => {
    const valid = {
      eventId: "event-1",
      eventType: "vehicle.telemetry-received",
      schemaVersion: 1,
      vehicleId: "vehicle-1",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { coordinate: [-115, 36], heading: 0, batteryPercentage: 100, status: "FREE" },
    };
    const parsed = parseFleetEvent(valid);
    expect(parsed).not.toBe(valid);
    expect(parsed.payload).not.toBe(valid.payload);
    expect(() => parseFleetEvent({ ...valid, receivedAt: "2026-01-01T00:00:01.000Z" })).toThrow(/unknown properties: receivedAt/);
  });

  it.each(["geometry", "distance", "duration", "rawResponse", "providerUrl"])(
    "rejects forbidden or unknown route payload property %s",
    (property) => {
      const route = {
        eventId: "event-route",
        eventType: "route.assigned",
        schemaVersion: 1,
        vehicleId: "vehicle-1",
        sequence: 1,
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {
          routeId: "route-1",
          version: 1,
          destinationId: "destination-1",
          assignmentState: "ACCEPTED",
          [property]: property === "providerUrl" ? "https://example.test?access_token=secret" : {},
        },
      };
      expect(() => parseFleetEvent(route)).toThrow(TypeError);
    },
  );

  it("rejects a token-bearing URL even in an otherwise allowed route field", () => {
    expect(() => parseFleetEvent({
      eventId: "event-route",
      eventType: "route.cancelled",
      schemaVersion: 1,
      vehicleId: "vehicle-1",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: {
        routeId: "route-1",
        version: 1,
        reason: "https://api.mapbox.com/directions/v5/mapbox/driving?access_token=pk.redacted.value",
      },
    })).toThrow(/token-bearing URL/);
  });

  it("requires commandId on dispatch assignment requests", () => {
    const request = {
      eventId: "event-dispatch",
      eventType: "dispatch.assignment-requested",
      schemaVersion: 1,
      vehicleId: "vehicle-1",
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "job-1",
      payload: {
        dispatchJobId: "job-1",
        commandId: "assign-1",
        routeId: "route-1",
        routeVersion: 1,
        destinationId: "destination-1",
        strategy: "random",
      },
    };
    expect(parseFleetEvent(request).payload).toMatchObject({ commandId: "assign-1" });
    const { commandId: _commandId, ...payload } = request.payload;
    expect(() => parseFleetEvent({ ...request, payload })).toThrow(/missing required properties: commandId/);
  });
});
