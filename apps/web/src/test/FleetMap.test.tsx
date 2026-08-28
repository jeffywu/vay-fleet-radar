// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VehicleMapRecord } from "../api/contracts.ts";

const mocks = vi.hoisted(() => {
  const sources = { vehicles: { setData: vi.fn() }, "active-routes": { setData: vi.fn() }, "route-destinations": { setData: vi.fn() } };
  const map = { addSource: vi.fn(), addLayer: vi.fn(), addControl: vi.fn(),
    getSource: vi.fn((name: keyof typeof sources) => sources[name]), remove: vi.fn(),
    once: vi.fn(), on: vi.fn() };
  return { sources, map, mapConstructor: vi.fn(() => map), fetchWorld: vi.fn() };
});
vi.mock("mapbox-gl", () => ({ default: { Map: mocks.mapConstructor, NavigationControl: vi.fn(), accessToken: "" } }));
vi.mock("../lib/world.ts", () => ({ fetchWorld: mocks.fetchWorld, mapboxPolygon: vi.fn(() => ({ type: "Feature" })),
  mapboxPolygonCollection: vi.fn(() => ({ type: "FeatureCollection", features: [] })) }));

import { FleetMap } from "../components/FleetMap.tsx";

const world = { serviceArea: { geometry: { coordinates: [[[-115.4, 35.9], [-114.9, 35.9], [-114.9, 36.4], [-115.4, 35.9]]] } },
  serviceZones: { features: [] }, destinations: [
    { id: "dst-1", name: "Downtown Las Vegas", coordinate: [-115.14, 36.17], serviceZoneId: "zone-c" },
  ] };
const vehicle: VehicleMapRecord = { vehicleId: "vehicle-1", coordinate: [-115.17, 36.12], heading: 90, batteryPercentage: 70,
  status: "FREE", serviceZoneId: "zone-c", lastOccurredAt: "2026-01-01T00:00:00.000Z", lastReceivedAt: new Date().toISOString() };

describe("FleetMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWorld.mockResolvedValue(world);
    mocks.map.getSource.mockImplementation((name: keyof typeof mocks.sources) => mocks.sources[name]);
  });
  afterEach(cleanup);

  it("shows setup guidance and does not initialize Mapbox without a token", () => {
    const { rerender } = render(<FleetMap vehicles={[]} staleAfterSeconds={30} accessToken="" />);
    return waitFor(() => expect(screen.getByText("Mapbox token required")).toBeInTheDocument()).then(() => {
    expect(mocks.mapConstructor).not.toHaveBeenCalled();
    rerender(<FleetMap vehicles={[vehicle]} staleAfterSeconds={30} accessToken="" />);
    expect(mocks.mapConstructor).not.toHaveBeenCalled();
    });
  });

  it("adds one empty vehicle source and the status and heading layers once", async () => {
    const { unmount } = render(<FleetMap vehicles={[]} staleAfterSeconds={30} accessToken="pk.test" />);
    await waitFor(() => expect(mocks.mapConstructor).toHaveBeenCalledOnce());
    const load = mocks.map.once.mock.calls.find(([name]) => name === "load")?.[1] as (() => void);
    act(() => load());
    const vehicleSources = mocks.map.addSource.mock.calls.filter(([name]) => name === "vehicles");
    expect(vehicleSources).toHaveLength(1);
    expect(vehicleSources[0]?.[1].data.features).toEqual([]);
    const layers = mocks.map.addLayer.mock.calls.map(([layer]) => layer);
    expect(layers.find((layer) => layer.id === "vehicles-status")?.paint["circle-color"]).toContain("match");
    expect(layers.find((layer) => layer.id === "vehicles-heading")?.layout["text-rotate"]).toEqual(["get", "heading"]);
    expect(layers.map(({ id }) => id)).toEqual(expect.arrayContaining(
      ["active-routes-line", "route-destinations-marker", "route-destinations-label"]));
    expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map-ready", "true");
    unmount();
    expect(mocks.map.remove).toHaveBeenCalledOnce();
  });

  it("uses preloaded vehicles at map load and later calls setData without recreating the map", async () => {
    const { rerender, unmount } = render(<FleetMap vehicles={[vehicle]} staleAfterSeconds={30} accessToken="pk.test" />);
    await waitFor(() => expect(mocks.mapConstructor).toHaveBeenCalledOnce());
    const load = mocks.map.once.mock.calls.find(([name]) => name === "load")?.[1] as (() => void);
    act(() => load());
    const sourceData = mocks.map.addSource.mock.calls.find(([name]) => name === "vehicles")?.[1].data;
    expect(sourceData.features[0].id).toBe("vehicle-1");
    rerender(<FleetMap vehicles={[{ ...vehicle, heading: 180 }]} staleAfterSeconds={30} accessToken="pk.test" />);
    expect(mocks.sources.vehicles.setData).toHaveBeenCalledOnce();
    expect(mocks.sources.vehicles.setData.mock.calls[0]?.[0].features[0].properties.heading).toBe(180);
    expect(mocks.mapConstructor).toHaveBeenCalledOnce();
    unmount();
  });

  it("loads route geometry and the named final destination for en-route vehicles", async () => {
    const routed = { ...vehicle, status: "EN_ROUTE" as const, activeRoute: { routeId: "route-1", version: 1,
      destinationId: "dst-1", state: "ACCEPTED" as const, geometryAvailable: true,
      geometry: { type: "LineString" as const, coordinates: [[-115.17, 36.12], [-115.14, 36.17]] } } };
    const { unmount } = render(<FleetMap vehicles={[routed]} staleAfterSeconds={30} accessToken="pk.test" />);
    await waitFor(() => expect(mocks.mapConstructor).toHaveBeenCalledOnce());
    const load = mocks.map.once.mock.calls.find(([name]) => name === "load")?.[1] as (() => void);
    act(() => load());
    const routeSource = mocks.map.addSource.mock.calls.find(([name]) => name === "active-routes")?.[1].data;
    const destinationSource = mocks.map.addSource.mock.calls.find(([name]) => name === "route-destinations")?.[1].data;
    expect(routeSource.features[0]).toMatchObject({ id: "route-1", properties: { vehicleId: "vehicle-1" } });
    expect(destinationSource.features[0]).toMatchObject({ geometry: { coordinates: [-115.14, 36.17] },
      properties: { destinationName: "Downtown Las Vegas" } });
    unmount();
  });
});
