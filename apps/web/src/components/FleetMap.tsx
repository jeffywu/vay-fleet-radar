import { useEffect, useRef, useState } from "react";
import mapboxgl, { type Map as MapboxMap, type MapLayerMouseEvent } from "mapbox-gl";
import type { Destination, WorldData } from "@fleet-radar/world";
import { destinationsToGeoJson, fetchWorld, mapboxPolygon, mapboxPolygonCollection } from "../lib/world.ts";

type FleetMapProps = {
  readonly onDestinationSelect: (destination: Destination) => void;
  readonly onWorldLoad: (summary: { destinations: number; zones: number }) => void;
};

function browserToken(): string {
  const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  return token && token !== "pk.replace-with-a-public-development-token" ? token : "";
}

function addWorldLayers(map: MapboxMap, world: WorldData): void {
  map.addSource("service-area", { type: "geojson", data: mapboxPolygon(world.serviceArea) });
  map.addSource("service-zones", { type: "geojson", data: mapboxPolygonCollection(world.serviceZones) });
  map.addSource("destinations", { type: "geojson", data: destinationsToGeoJson(world.destinations) });

  map.addLayer({
    id: "service-area-fill",
    type: "fill",
    source: "service-area",
    paint: { "fill-color": "#0e7490", "fill-opacity": 0.08 },
  });
  map.addLayer({
    id: "service-zones-fill",
    type: "fill",
    source: "service-zones",
    paint: {
      "fill-color": ["match", ["get", "id"], "zone-c", "#22d3ee", "zone-n", "#67e8f9", "zone-s", "#67e8f9", "#a5f3fc"],
      "fill-opacity": 0.12,
    },
  });
  map.addLayer({
    id: "service-zones-outline",
    type: "line",
    source: "service-zones",
    paint: { "line-color": "#0891b2", "line-opacity": 0.65, "line-width": 1 },
  });
  map.addLayer({
    id: "service-area-outline",
    type: "line",
    source: "service-area",
    paint: { "line-color": "#155e75", "line-opacity": 0.9, "line-width": 2 },
  });
  map.addLayer({
    id: "destinations",
    type: "circle",
    source: "destinations",
    paint: {
      "circle-color": "#f97316",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 11, 5],
      "circle-stroke-color": "#fff7ed",
      "circle-stroke-width": 1,
      "circle-opacity": 0.9,
    },
  });
}

export function FleetMap({ onDestinationSelect, onWorldLoad }: FleetMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const callbacksRef = useRef({ onDestinationSelect, onWorldLoad });
  const [status, setStatus] = useState<"loading" | "ready" | "missing-token" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  callbacksRef.current = { onDestinationSelect, onWorldLoad };

  useEffect(() => {
    const token = browserToken();
    if (!token) {
      setStatus("missing-token");
      return;
    }
    if (!containerRef.current || mapRef.current) return;

    const abortController = new AbortController();
    let disposed = false;
    let map: MapboxMap | undefined;

    void fetchWorld(abortController.signal)
      .then((world) => {
        if (disposed || !containerRef.current) return;
        mapboxgl.accessToken = token;
        const ring = world.serviceArea.geometry.coordinates[0];
        const longitudes = ring.map((coordinate) => coordinate[0]);
        const latitudes = ring.map((coordinate) => coordinate[1]);
        const bounds: mapboxgl.LngLatBoundsLike = [
          [Math.min(...longitudes), Math.min(...latitudes)],
          [Math.max(...longitudes), Math.max(...latitudes)],
        ];
        const maxBounds: mapboxgl.LngLatBoundsLike = [
          [Math.min(...longitudes) - 0.03, Math.min(...latitudes) - 0.03],
          [Math.max(...longitudes) + 0.03, Math.max(...latitudes) + 0.03],
        ];
        map = new mapboxgl.Map({
          container: containerRef.current,
          style: "mapbox://styles/mapbox/streets-v12",
          bounds,
          fitBoundsOptions: { padding: 44 },
          maxBounds,
        });
        mapRef.current = map;
        map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-right");
        map.once("load", () => {
          if (disposed || !map) return;
          addWorldLayers(map, world);
          containerRef.current?.setAttribute("data-map-ready", "true");
          callbacksRef.current.onWorldLoad({ destinations: world.destinations.length, zones: world.serviceZones.features.length });
          setStatus("ready");
        });
        map.on("error", (event) => {
          if (disposed) return;
          setErrorMessage(event.error?.message ?? "Mapbox could not load the map style");
          setStatus("error");
        });
        map.on("mouseenter", "destinations", () => {
          if (map) map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "destinations", () => {
          if (map) map.getCanvas().style.cursor = "";
        });
        map.on("click", "destinations", (event: MapLayerMouseEvent) => {
          const feature = event.features?.[0] as unknown as GeoJSON.Feature<GeoJSON.Point, Partial<Destination>> | undefined;
          const properties = feature?.properties;
          const coordinate = feature?.geometry.type === "Point" ? feature.geometry.coordinates : undefined;
          if (!properties?.id || !properties.name || !properties.serviceZoneId || !coordinate) return;
          callbacksRef.current.onDestinationSelect({
            id: properties.id,
            name: properties.name,
            serviceZoneId: properties.serviceZoneId,
            coordinate: [coordinate[0], coordinate[1]],
          });
        });
      })
      .catch((error: unknown) => {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        setErrorMessage(error instanceof Error ? error.message : "World assets could not be loaded");
        setStatus("error");
      });

    return () => {
      disposed = true;
      abortController.abort();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="map-frame" aria-label="Las Vegas fleet map">
      <div className="map-canvas" ref={containerRef} data-testid="map-canvas" />
      {status === "loading" && <div className="map-state"><span className="spinner" />Loading simulation world…</div>}
      {status === "missing-token" && (
        <div className="map-state map-state--setup">
          <strong>Mapbox token required</strong>
          <span>Set a public VITE_MAPBOX_ACCESS_TOKEN (or local MAPBOX_TOKEN) in the repository .env, then restart the dev server.</span>
        </div>
      )}
      {status === "error" && <div className="map-state map-state--error"><strong>Map unavailable</strong><span>{errorMessage}</span></div>}
      <div className="map-legend" aria-label="Map legend">
        <span><i className="legend-swatch legend-swatch--area" />Service area</span>
        <span><i className="legend-swatch legend-swatch--zone" />Service zones</span>
        <span><i className="legend-dot" />Destinations</span>
      </div>
    </div>
  );
}
