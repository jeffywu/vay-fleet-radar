// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetEventSource, fetchFleetSnapshot, fetchVehicleDetail } from "../api/fleetApi.ts";

const validSnapshot = { data: [], meta: { count: 0, generatedAt: "2026-01-01T00:00:00.000Z", streamCursor: "7", staleAfterSeconds: 30 } };

describe("fleetApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the same-origin snapshot with cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validSnapshot), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFleetSnapshot(controller.signal)).resolves.toEqual(validSnapshot);
    expect(fetchMock).toHaveBeenCalledWith("/api/vehicles", { signal: controller.signal, headers: { Accept: "application/json" } });
  });

  it("returns safe errors for non-success and malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 })));
    await expect(fetchFleetSnapshot(new AbortController().signal)).rejects.toThrow("snapshot could not be loaded");
    await expect(fetchFleetSnapshot(new AbortController().signal)).rejects.toThrow("invalid response");
  });

  it("opens a named-event stream after the supplied opaque cursor", () => {
    const eventSource = { addEventListener: vi.fn(), close: vi.fn() };
    const constructor = vi.fn(() => eventSource);
    vi.stubGlobal("EventSource", constructor);
    expect(createFleetEventSource("9007199254740993")).toBe(eventSource);
    expect(constructor).toHaveBeenCalledWith("/api/events?after=9007199254740993");
  });

  it("loads active route detail from the same-origin vehicle endpoint", async () => {
    const controller = new AbortController();
    const detail = { ...validSnapshot, data: { vehicleId: "vehicle-1", coordinate: [-115.17, 36.12], heading: 90,
      batteryPercentage: 50, status: "EN_ROUTE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z",
      lastReceivedAt: "2026-01-01T00:00:01.000Z", activeRoute: { routeId: "route-1", version: 1,
        destinationId: "dst-1", state: "ACCEPTED", geometryAvailable: true,
        geometry: { type: "LineString", coordinates: [[-115.17, 36.12], [-115.1, 36.2]] } } } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchVehicleDetail("vehicle/1", controller.signal)).resolves.toMatchObject({ vehicleId: "vehicle-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/vehicles/vehicle%2F1",
      { signal: controller.signal, headers: { Accept: "application/json" } });
  });
});
