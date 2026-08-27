import { describe, expect, it } from "vitest";
import { parseFleetSnapshot, parseVehicleMapRecord } from "../api/contracts.ts";

const vehicle = { vehicleId: "vehicle-0001", coordinate: [-115.17, 36.12], heading: 90, batteryPercentage: 72,
  status: "FREE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z", lastReceivedAt: "2026-01-01T00:00:01.000Z" };

describe("fleet API contracts", () => {
  it("returns canonical browser-owned snapshot records", () => {
    const parsed = parseFleetSnapshot({ data: [{ ...vehicle, isStale: false, activeRoute: { routeId: "ignored" } }],
      meta: { count: 1, generatedAt: "2026-01-01T00:00:02.000Z", streamCursor: "9007199254740993", staleAfterSeconds: 12 }, ignored: true });
    expect(parsed.data).toEqual([vehicle]);
    expect(parsed.meta.streamCursor).toBe("9007199254740993");
    expect(parsed.data[0]).not.toHaveProperty("activeRoute");
  });

  it.each([
    ["cursor", { streamCursor: "01" }], ["large cursor", { streamCursor: "9223372036854775808" }],
    ["staleness", { staleAfterSeconds: 0 }], ["timestamp", { generatedAt: "today" }], ["count", { count: 2 }],
  ])("rejects invalid snapshot %s", (_name, changed) => {
    expect(() => parseFleetSnapshot({ data: [vehicle], meta: { count: 1, generatedAt: "2026-01-01T00:00:02.000Z",
      streamCursor: "12", staleAfterSeconds: 10, ...changed } })).toThrow("Invalid fleet data");
  });

  it.each([
    ["longitude", { coordinate: [-181, 36] }], ["latitude/order", { coordinate: [36, -115] }], ["coordinate arity", { coordinate: [-115] }],
    ["heading", { heading: 360 }], ["battery", { batteryPercentage: 101 }], ["status", { status: "PARKED" }],
    ["occurred timestamp", { lastOccurredAt: "invalid" }], ["received timestamp", { lastReceivedAt: "invalid" }],
    ["non-UTC timestamp", { lastReceivedAt: "2026-01-01T00:00:01+00:00" }],
  ])("rejects invalid vehicle %s", (_name, changed) => {
    expect(() => parseVehicleMapRecord({ ...vehicle, ...changed })).toThrow("Invalid fleet data");
  });
});
