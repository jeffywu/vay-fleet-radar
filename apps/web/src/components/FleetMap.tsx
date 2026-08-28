import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { type GeoJSONSource, type Map as MapboxMap } from "mapbox-gl";
import type { WorldData } from "@fleet-radar/world";
import type { VehicleMapRecord } from "../api/contracts.ts";
import { fleetDestinationsToGeoJson, fleetRoutesToGeoJson, type FleetDestinationFeatureCollection,
  type FleetRouteFeatureCollection } from "../lib/fleetRoutesToGeoJson.ts";
import { vehiclesToGeoJson, type VehicleFeatureCollection } from "../lib/vehiclesToGeoJson.ts";
import { fetchWorld, mapboxPolygon, mapboxPolygonCollection } from "../lib/world.ts";

type FleetMapProps = {
  readonly vehicles: readonly VehicleMapRecord[];
  readonly staleAfterSeconds: number;
  readonly accessToken?: string;
};

function browserToken(): string {
  const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  return token && token !== "pk.replace-with-a-public-development-token" ? token : "";
}

function addMapLayers(map: MapboxMap, world: WorldData, vehicles: VehicleFeatureCollection,
  routes: FleetRouteFeatureCollection, destinations: FleetDestinationFeatureCollection): void {
  map.addSource("service-area", { type: "geojson", data: mapboxPolygon(world.serviceArea) });
  map.addSource("service-zones", { type: "geojson", data: mapboxPolygonCollection(world.serviceZones) });
  map.addSource("vehicles", { type: "geojson", data: vehicles });
  map.addSource("active-routes", { type: "geojson", data: routes });
  map.addSource("route-destinations", { type: "geojson", data: destinations });

  map.addLayer({ id: "service-area-fill", type: "fill", source: "service-area",
    paint: { "fill-color": "#0e7490", "fill-opacity": 0.08 } });
  map.addLayer({
    id: "service-zones-fill", type: "fill", source: "service-zones",
    paint: { "fill-color": ["match", ["get", "id"], "zone-c", "#22d3ee", "zone-n", "#67e8f9", "zone-s", "#67e8f9", "#a5f3fc"],
      "fill-opacity": 0.12 },
  });
  map.addLayer({ id: "service-zones-outline", type: "line", source: "service-zones",
    paint: { "line-color": "#0891b2", "line-opacity": 0.65, "line-width": 1 } });
  map.addLayer({ id: "service-area-outline", type: "line", source: "service-area",
    paint: { "line-color": "#155e75", "line-opacity": 0.9, "line-width": 2 } });
  map.addLayer({ id: "active-routes-casing", type: "line", source: "active-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#fff7ed", "line-opacity": 0.9, "line-width": 6 } });
  map.addLayer({ id: "active-routes-line", type: "line", source: "active-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#f97316", "line-opacity": 0.9, "line-width": 3 } });
  map.addLayer({ id: "route-destinations-marker", type: "circle", source: "route-destinations",
    paint: { "circle-color": "#fff7ed", "circle-radius": 7, "circle-stroke-color": "#c2410c", "circle-stroke-width": 3 } });
  map.addLayer({ id: "route-destinations-label", type: "symbol", source: "route-destinations",
    layout: { "text-field": ["get", "destinationName"], "text-size": 11, "text-offset": [0, 1.35], "text-anchor": "top" },
    paint: { "text-color": "#7c2d12", "text-halo-color": "#fff7ed", "text-halo-width": 1.5 } });
  map.addLayer({
    id: "vehicles-status", type: "circle", source: "vehicles",
    paint: {
      "circle-color": ["match", ["get", "status"], "FREE", "#14b8a6", "WITH_CUSTOMER", "#2563eb", "EN_ROUTE", "#f97316", "#64748b"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 13, 7],
      "circle-opacity": ["case", ["boolean", ["get", "isStale"], false], 0.4, 0.95],
      "circle-stroke-color": ["case", ["boolean", ["get", "isStale"], false], "#dc2626", "#f8fafc"],
      "circle-stroke-width": ["case", ["boolean", ["get", "isStale"], false], 2.5, 1.5],
    },
  });
  map.addLayer({
    id: "vehicles-heading", type: "symbol", source: "vehicles",
    layout: { "text-field": "▲", "text-size": ["interpolate", ["linear"], ["zoom"], 8, 8, 13, 12],
      "text-rotate": ["get", "heading"], "text-rotation-alignment": "map", "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#f8fafc", "text-opacity": ["case", ["boolean", ["get", "isStale"], false], 0.45, 1] },
  });
}

export function FleetMap({ vehicles, staleAfterSeconds, accessToken }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const mapReadyRef = useRef(false);
  const vehicleData = useMemo(() => vehiclesToGeoJson(vehicles, staleAfterSeconds), [vehicles, staleAfterSeconds]);
  const routeData = useMemo(() => fleetRoutesToGeoJson(vehicles), [vehicles]);
  const vehicleDataRef = useRef(vehicleData);
  const routeDataRef = useRef(routeData);
  const vehiclesRef = useRef(vehicles);
  const worldRef = useRef<WorldData | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "ready" | "missing-token" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  vehicleDataRef.current = vehicleData;
  routeDataRef.current = routeData;
  vehiclesRef.current = vehicles;

  useEffect(() => {
    if (!mapReadyRef.current) return;
    (mapRef.current?.getSource("vehicles") as GeoJSONSource | undefined)?.setData(vehicleData);
    (mapRef.current?.getSource("active-routes") as GeoJSONSource | undefined)?.setData(routeData);
    if (worldRef.current) (mapRef.current?.getSource("route-destinations") as GeoJSONSource | undefined)
      ?.setData(fleetDestinationsToGeoJson(vehicles, worldRef.current.destinations));
  }, [routeData, vehicleData, vehicles]);

  useEffect(() => {
    const token = accessToken === undefined ? browserToken() : accessToken.trim();
    if (!token) { setStatus("missing-token"); return; }
    if (!containerRef.current || mapRef.current) return;

    const abortController = new AbortController();
    let disposed = false;
    let map: MapboxMap | undefined;
    void fetchWorld(abortController.signal).then((world) => {
      if (disposed || !containerRef.current) return;
      worldRef.current = world;
      mapboxgl.accessToken = token;
      const ring = world.serviceArea.geometry.coordinates[0];
      const longitudes = ring.map((coordinate) => coordinate[0]);
      const latitudes = ring.map((coordinate) => coordinate[1]);
      const bounds: mapboxgl.LngLatBoundsLike = [[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]];
      const maxBounds: mapboxgl.LngLatBoundsLike = [[Math.min(...longitudes) - 0.03, Math.min(...latitudes) - 0.03],
        [Math.max(...longitudes) + 0.03, Math.max(...latitudes) + 0.03]];
      map = new mapboxgl.Map({ container: containerRef.current, style: "mapbox://styles/mapbox/streets-v12",
        bounds, fitBoundsOptions: { padding: 44 }, maxBounds });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-right");
      map.once("load", () => {
        if (disposed || !map) return;
        addMapLayers(map, world, vehicleDataRef.current, routeDataRef.current,
          fleetDestinationsToGeoJson(vehiclesRef.current, world.destinations));
        mapReadyRef.current = true;
        containerRef.current?.setAttribute("data-map-ready", "true");
        setStatus("ready");
      });
      map.on("error", (event) => {
        if (disposed) return;
        setErrorMessage(event.error?.message ?? "Mapbox could not load the map style");
        setStatus("error");
      });
    }).catch((error: unknown) => {
      if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
      setErrorMessage(error instanceof Error ? error.message : "World assets could not be loaded");
      setStatus("error");
    });

    return () => {
      disposed = true;
      abortController.abort();
      mapReadyRef.current = false;
      map?.remove();
      mapRef.current = null;
      worldRef.current = undefined;
    };
  }, [accessToken]);

  return (
    <div className="map-frame" aria-label="Las Vegas fleet map">
      <div className="map-canvas" ref={containerRef} data-testid="map-canvas" data-vehicle-count={vehicles.length} />
      {status === "loading" && <div className="map-state"><span className="spinner" />Loading map…</div>}
      {status === "missing-token" && <div className="map-state map-state--setup"><strong>Mapbox token required</strong>
        <span>Set a public VITE_MAPBOX_ACCESS_TOKEN (or local MAPBOX_TOKEN) in the repository .env, then restart the dev server.</span></div>}
      {status === "error" && <div className="map-state map-state--error"><strong>Map unavailable</strong><span>{errorMessage}</span></div>}
    </div>
  );
}
