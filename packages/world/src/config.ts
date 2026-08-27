import type { Coordinate } from "./types.ts";

export const DEFAULT_WORLD_SEED = "vay-las-vegas-v1";
export const MIN_DESTINATION_SEPARATION_METERS = 75;

export type Bounds = { readonly west: number; readonly south: number; readonly east: number; readonly north: number };

export const LAS_VEGAS_BOUNDS: Bounds = Object.freeze({
  west: -115.38,
  south: 35.94,
  east: -114.98,
  north: 36.34,
});

export const ZONE_IDS = Object.freeze([
  "zone-nw",
  "zone-n",
  "zone-ne",
  "zone-w",
  "zone-c",
  "zone-e",
  "zone-sw",
  "zone-s",
  "zone-se",
] as const);

export type SamplingRegion = {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
};

export const SAMPLING_REGIONS: readonly SamplingRegion[] = Object.freeze([
  { id: "strip-paradise", name: "Strip and Paradise", count: 40, west: -115.2, south: 36.06, east: -115.13, north: 36.14 },
  { id: "downtown", name: "Downtown", count: 25, west: -115.19, south: 36.15, east: -115.12, north: 36.2 },
  { id: "spring-valley-enterprise", name: "Spring Valley and Enterprise", count: 35, west: -115.29, south: 35.99, east: -115.17, north: 36.12 },
  { id: "summerlin", name: "Summerlin", count: 20, west: -115.35, south: 36.12, east: -115.25, north: 36.22 },
  { id: "north-las-vegas", name: "North Las Vegas", count: 25, west: -115.2, south: 36.19, east: -115.06, north: 36.29 },
  { id: "east-las-vegas", name: "East Las Vegas and Sunrise Manor", count: 20, west: -115.12, south: 36.13, east: -115.02, north: 36.22 },
  { id: "henderson-green-valley", name: "Henderson and Green Valley", count: 35, west: -115.1, south: 35.99, east: -114.99, north: 36.1 },
]);

export function rectangleRing(bounds: Bounds): readonly Coordinate[] {
  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
    [bounds.west, bounds.south],
  ];
}
