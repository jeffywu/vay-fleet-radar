import { describe, expect, it } from "vitest";
import { destinationsToGeoJson } from "../lib/world.ts";

describe("world map conversion", () => {
  it("converts destinations to GeoJSON points without changing coordinate order", () => {
    const result = destinationsToGeoJson([
      { id: "dst-lv-0001", name: "LV Destination 001", coordinate: [-115.15, 36.17], serviceZoneId: "zone-c" },
    ]);
    expect(result).toEqual({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        id: "dst-lv-0001",
        properties: { id: "dst-lv-0001", name: "LV Destination 001", serviceZoneId: "zone-c" },
        geometry: { type: "Point", coordinates: [-115.15, 36.17] },
      }],
    });
  });
});

