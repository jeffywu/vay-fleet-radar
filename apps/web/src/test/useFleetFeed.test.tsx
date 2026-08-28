// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSnapshot, VehicleMapRecord } from "../api/contracts.ts";
import type { FleetEventSource } from "../api/fleetApi.ts";
import { useFleetFeed } from "../hooks/useFleetFeed.ts";

const vehicle = (id: string, heading = 10): VehicleMapRecord => ({ vehicleId: id, coordinate: [-115.17, 36.12], heading,
  batteryPercentage: 70, status: "FREE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z",
  lastReceivedAt: "2026-01-01T00:00:01.000Z" });
const snapshot = (cursor: string, data = [vehicle("vehicle-1")]): FleetSnapshot => ({ data, meta: { count: data.length,
  generatedAt: "2026-01-01T00:00:02.000Z", streamCursor: cursor, staleAfterSeconds: 30 } });

class MockSource implements FleetEventSource {
  readonly listeners = new Map<string, EventListener[]>();
  close = vi.fn();
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as EventListener]);
  }
  emit(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

describe("useFleetFeed", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("installs a snapshot before opening named SSE listeners at its opaque cursor", async () => {
    const source = new MockSource();
    const fetchSnapshot = vi.fn().mockResolvedValue(snapshot("9007199254740993"));
    const createEventSource = vi.fn(() => source);
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot, createEventSource }));
    await waitFor(() => expect(createEventSource).toHaveBeenCalledWith("9007199254740993"));
    expect(result.current.vehicles).toEqual([vehicle("vehicle-1")]);
    expect([...source.listeners.keys()]).toEqual(expect.arrayContaining(
      ["open", "error", "vehicle.updated", "route.updated", "route.removed", "stream.reset-required"]));
    act(() => source.emit("open"));
    expect(result.current.connectionState).toBe("LIVE");
    unmount();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("fills an empty fleet and batches a burst into one immutable update", async () => {
    const source = new MockSource();
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot: vi.fn().mockResolvedValue(snapshot("0", [])),
      createEventSource: () => source }));
    await waitFor(() => expect(source.listeners.has("vehicle.updated")).toBe(true));
    act(() => { for (let index = 0; index < 100; index += 1) source.emit("vehicle.updated", vehicle(`vehicle-${index}`)); });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    act(() => frames.shift()?.(0));
    expect(result.current.vehicles).toHaveLength(100);
    act(() => source.emit("vehicle.updated", vehicle("vehicle-50", 180)));
    act(() => frames.shift()?.(1));
    expect(result.current.vehicles).toHaveLength(100);
    expect(result.current.vehicles.find((item) => item.vehicleId === "vehicle-50")?.heading).toBe(180);
    unmount();
  });

  it("lets native EventSource reconnect without opening a parallel stream", async () => {
    const source = new MockSource();
    const createEventSource = vi.fn(() => source);
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot: vi.fn().mockResolvedValue(snapshot("5")), createEventSource }));
    await waitFor(() => expect(createEventSource).toHaveBeenCalledOnce());
    act(() => source.emit("error"));
    expect(result.current.connectionState).toBe("RETRYING");
    expect(createEventSource).toHaveBeenCalledOnce();
    act(() => source.emit("open"));
    expect(result.current.connectionState).toBe("LIVE");
    unmount();
  });

  it("closes a pruned stream, replaces from a new snapshot, and reconnects from its cursor", async () => {
    const sources = [new MockSource(), new MockSource()];
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(snapshot("5")).mockResolvedValueOnce(snapshot("90", [vehicle("vehicle-2")]));
    const createEventSource = vi.fn(() => sources[createEventSource.mock.calls.length - 1]!);
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot, createEventSource }));
    await waitFor(() => expect(createEventSource).toHaveBeenCalledWith("5"));
    act(() => sources[0].emit("stream.reset-required"));
    await waitFor(() => expect(createEventSource).toHaveBeenCalledWith("90"));
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(result.current.vehicles.map((item) => item.vehicleId)).toEqual(["vehicle-2"]);
    unmount();
  });

  it("ignores malformed individual updates and keeps the stream usable", async () => {
    const source = new MockSource();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot: vi.fn().mockResolvedValue(snapshot("1")), createEventSource: () => source }));
    await waitFor(() => expect(source.listeners.has("vehicle.updated")).toBe(true));
    act(() => source.emit("vehicle.updated", { vehicleId: "bad", coordinate: [500, 500] }));
    expect(result.current.vehicles).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith("Ignored malformed vehicle update from fleet stream");
    warning.mockRestore();
    unmount();
  });

  it("hydrates active route geometry and removes it when the route completes", async () => {
    const source = new MockSource();
    const activeRoute = { routeId: "route-1", version: 1, destinationId: "dst-1", state: "ACCEPTED" as const,
      geometryAvailable: false };
    const routedVehicle = { ...vehicle("vehicle-1"), status: "EN_ROUTE" as const, activeRoute };
    const geometry = { type: "LineString" as const, coordinates: [[-115.17, 36.12], [-115.1, 36.2]] };
    const fetchDetail = vi.fn().mockResolvedValue({ ...routedVehicle,
      activeRoute: { ...activeRoute, geometryAvailable: true, geometry } });
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot: vi.fn().mockResolvedValue(snapshot("8", [routedVehicle])),
      fetchDetail, createEventSource: () => source }));
    await waitFor(() => expect(fetchDetail).toHaveBeenCalledWith("vehicle-1", expect.any(AbortSignal)));
    await waitFor(() => expect(frames.length).toBeGreaterThan(0));
    act(() => frames.splice(0).forEach((frame, index) => frame(index)));
    expect(result.current.vehicles[0]?.activeRoute?.geometry).toEqual(geometry);

    act(() => source.emit("route.removed", { vehicleId: "vehicle-1", routeId: "route-1" }));
    act(() => frames.splice(0).forEach((frame, index) => frame(index)));
    expect(result.current.vehicles[0]?.activeRoute).toBeUndefined();
    unmount();
  });

  it("aborts an in-flight snapshot and cancels scheduled work on cleanup", async () => {
    let signal: AbortSignal | undefined;
    const fetchSnapshot = vi.fn((input: AbortSignal) => {
      signal = input;
      return new Promise<FleetSnapshot>(() => undefined);
    });
    const { unmount } = renderHook(() => useFleetFeed({ fetchSnapshot, createEventSource: () => new MockSource() }));
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledOnce());
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("bounds automatic snapshot retries and supports a manual retry", async () => {
    const source = new MockSource();
    const fetchSnapshot = vi.fn().mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(snapshot("12"));
    const createEventSource = vi.fn(() => source);
    const { result, unmount } = renderHook(() => useFleetFeed({ fetchSnapshot, createEventSource, maxSnapshotAttempts: 2, retryDelayMs: 1 }));
    await waitFor(() => expect(result.current.connectionState).toBe("ERROR"));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(createEventSource).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(createEventSource).toHaveBeenCalledWith("12"));
    act(() => source.emit("open"));
    expect(result.current.connectionState).toBe("LIVE");
    unmount();
  });
});
