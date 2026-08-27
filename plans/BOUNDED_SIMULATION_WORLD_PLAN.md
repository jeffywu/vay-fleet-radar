# Bounded Simulation World Execution Plan

## Objective

Generate a small, deterministic Las Vegas metro simulation world for Fleet Radar. The world must contain one operating boundary, simple service zones, and 200 source-controlled destinations suitable for randomly selecting customer-trip and dispatch endpoints.

This task does not generate or persist routes. Mapbox Directions will create an ephemeral route at runtime after the simulator or dispatch engine selects a destination.

## Deliverables

- `assets/world/service-area.geojson`
- `assets/world/service-zones.geojson`
- `assets/world/destinations.json`
- `tools/generate-world.ts`
- Unit tests for generation and validation.
- A short `assets/world/README.md` recording the seed, coordinate conventions, generation command, and data provenance.
- An initial React/Vite operator-dashboard shell that loads Mapbox GL JS and renders all generated world assets for visual inspection.

## Fixed Decisions

- World: a simplified Las Vegas metro operating area, not an official administrative boundary.
- Coordinate system: WGS84 in `[longitude, latitude]` order.
- Destination count: exactly 200.
- Seed: `vay-las-vegas-v1` by default, overridable by command-line argument.
- Generation method: seeded pseudorandom sampling from a few hand-configured urban rectangles.
- Service zones: a 3×3 rectangular grid covering the operating area.
- Destination names: stable synthetic names such as `LV Destination 001`; no geocoding required.
- Routes: requested from Mapbox Directions only when movement starts and never written by this generator.

## Geographic Scope

Use this rectangular demo boundary:

```ts
const LAS_VEGAS_BOUNDS = {
  west: -115.38,
  south: 35.94,
  east: -114.98,
  north: 36.34,
};
```

The rectangle covers the Las Vegas urban core and representative portions of Enterprise, Spring Valley, Summerlin, North Las Vegas, Sunrise Manor, and Henderson. It intentionally includes some non-urban land; destination sampling regions keep generated points concentrated in developed areas.

The service-area GeoJSON is the rectangle represented as one closed `Polygon`. The dashboard uses its bounding box for initial `fitBounds` and `maxBounds`.

## Sampling Regions

Generate points from the following regions and counts. The counts sum to 200 and provide more density in the urban core while retaining metro-wide coverage.

| Region | Count | Longitude range | Latitude range |
| --- | ---: | --- | --- |
| Strip and Paradise | 40 | `-115.20` to `-115.13` | `36.06` to `36.14` |
| Downtown | 25 | `-115.19` to `-115.12` | `36.15` to `36.20` |
| Spring Valley and Enterprise | 35 | `-115.29` to `-115.17` | `35.99` to `36.12` |
| Summerlin | 20 | `-115.35` to `-115.25` | `36.12` to `36.22` |
| North Las Vegas | 25 | `-115.20` to `-115.06` | `36.19` to `36.29` |
| East Las Vegas and Sunrise Manor | 20 | `-115.12` to `-115.02` | `36.13` to `36.22` |
| Henderson and Green Valley | 35 | `-115.10` to `-114.99` | `35.99` to `36.10` |

These rectangles are generation inputs rather than product-domain objects. Do not persist them or turn them into a generic spatial configuration system.

## Output Schemas

### Service area

`service-area.geojson` is a GeoJSON `Feature<Polygon>`:

```json
{
  "type": "Feature",
  "properties": {
    "id": "las-vegas-metro",
    "name": "Las Vegas Metro Demo Area"
  },
  "geometry": {
    "type": "Polygon",
    "coordinates": []
  }
}
```

### Service zones

`service-zones.geojson` is a `FeatureCollection<Polygon>` containing nine equal rectangular cells. Generate stable IDs in north-to-south, west-to-east order:

```text
zone-nw  zone-n   zone-ne
zone-w   zone-c   zone-e
zone-sw  zone-s   zone-se
```

The cells must tile the service-area rectangle without gaps or overlaps other than shared boundaries.

### Destinations

`destinations.json` is an array sorted by ID:

```ts
type Destination = {
  id: string;
  name: string;
  coordinate: [longitude: number, latitude: number];
  serviceZoneId: string;
};
```

Use IDs `dst-lv-0001` through `dst-lv-0200`. Assign `serviceZoneId` from the generated point's grid cell. Round coordinates to six decimal places only when serializing the final output.

## Generator Implementation

Implement `tools/generate-world.ts` as a small standalone TypeScript program.

1. Parse optional `--seed` and `--force` arguments.
2. Initialize a small deterministic pseudorandom generator from the seed. A compact local implementation such as `mulberry32` plus a string-to-integer seed function is sufficient; do not add a dependency solely for random numbers.
3. Construct the service-area polygon from `LAS_VEGAS_BOUNDS`.
4. Divide each axis into thirds and construct the nine service-zone polygons.
5. Iterate through the sampling-region table in its declared order.
6. Generate uniformly distributed longitude and latitude values within the current region.
7. Reject a candidate when it is outside the service area or within 75 meters of an already accepted destination.
8. Stop with an actionable error if a region cannot produce its configured count within 10,000 attempts.
9. Assign stable IDs after all points have been accepted, derive the service-zone ID, and sort by ID.
10. Validate the complete world in memory before writing any file.
11. Refuse to overwrite existing assets unless `--force` is supplied.
12. Serialize JSON with two-space indentation and a trailing newline.

The 75-meter separation is only intended to prevent near-duplicate points. A short local haversine helper is adequate.

Example command:

```sh
npx tsx tools/generate-world.ts --seed vay-las-vegas-v1
```

## Validation

The generator and a reusable world loader must verify:

- The service area is valid closed GeoJSON with WGS84 coordinate ranges.
- Exactly nine zones exist and every zone is inside the service area.
- Exactly 200 destinations exist.
- Destination IDs and names are unique.
- Every coordinate uses `[longitude, latitude]` ordering and falls inside the service area.
- Every destination belongs to exactly one service zone. For points exactly on a shared boundary, use a documented north/east tie-break rule.
- No two destinations are closer than 75 meters.
- Each sampling region contributes its configured count.
- Running twice with the same seed produces byte-identical output.
- A different seed changes coordinates while preserving schemas, counts, and constraints.

Do not call Mapbox Directions or Geocoding as part of generation or default tests. Occasional runtime `NoRoute` or `NoSegment` results are handled by destination retry logic in the routing flow.

## Visual QA

Build the first slice of the final React web application rather than a disposable inspection page. This is a technical spike for the Mapbox token, style, asset-loading, and layer APIs, and its component structure should remain useful when live fleet data is added.

### React spike files

Create a TypeScript Vite application under `apps/web` with at least:

```text
apps/web/
  .env.example
  index.html
  package.json
  vite.config.ts
  src/
    main.tsx
    App.tsx
    components/
      FleetMap.tsx
    lib/
      world.ts
    styles.css
```

Use React, `mapbox-gl`, and the Mapbox GL CSS. Do not add a component framework for the spike.

`apps/web/.env.example` contains only:

```text
VITE_MAPBOX_ACCESS_TOKEN=pk.replace-with-a-public-development-token
```

The developer copies it to `.env.local`, which is ignored by Git. Run the spike from `apps/web` with the package's normal `npm run dev` command.

Configure Vite's `publicDir` to expose the repository's canonical `assets/` directory so the browser can fetch:

```text
/world/service-area.geojson
/world/service-zones.geojson
/world/destinations.json
```

The generated files remain the single source of truth; do not copy them into a second frontend-owned directory.

### Initial UX shell

Stub a minimal version of the final operator layout:

- A top bar labeled `Fleet Radar` with a clear `World preview` indicator.
- A narrow left panel showing the destination count, zone count, selected destination, and a short visual-QA checklist.
- A main map occupying the remaining viewport.
- A small map legend for service area, zones, and destinations.
- An explicit loading state, missing-token setup state, and map/style error state.

Visual polish is not required, but the layout must be usable at a typical laptop viewport and should not be thrown away when fleet markers and filters are added.

### `FleetMap` behavior

`FleetMap.tsx` should:

1. Read `VITE_MAPBOX_ACCESS_TOKEN` and render setup guidance without initializing Mapbox when it is missing.
2. Create exactly one `mapboxgl.Map` using a DOM ref and retain it in a React ref.
3. Load a standard Mapbox streets style.
4. Fetch all three world assets in parallel and validate their basic response shapes.
5. Convert `destinations.json` to a GeoJSON `FeatureCollection<Point>` in `lib/world.ts`.
6. On map style load, add sources for `service-area`, `service-zones`, and `destinations`.
7. Add a translucent operating-area fill and outline, lightly colored zone fills and outlines, and a destination circle layer.
8. Use the service-area bounds for initial `fitBounds` and `maxBounds` with a small margin.
9. On destination click, update the selected-destination panel and optionally show a small Mapbox popup.
10. Add standard navigation controls.
11. Surface fetch, token, and Mapbox errors in the UX.
12. Remove the Mapbox instance during React cleanup.

Do not wrap the spike root in `React.StrictMode`. Development Strict Mode intentionally remounts effects and would create a second Mapbox map load, obscuring whether the component itself has an initialization bug. Keep cleanup correct and cover repeated parent renders with a component test instead.

Do not call Mapbox Directions from the browser spike. Runtime routing remains a server-side adapter and is tested separately.

### Visual inspection

After generation, run the React app and:

1. Load the service area, zones, and destinations into the dashboard as GeoJSON sources.
2. Confirm the camera opens over the Las Vegas metro area.
3. Confirm that points are visibly concentrated in the seven sampling regions rather than the surrounding desert.
4. Confirm that all nine zones have sensible coverage and no point renders outside the operating boundary.
5. Click destinations in each region and confirm the correct ID, name, and zone appear in the panel.
6. Resize the browser and confirm the shell and map remain usable.
7. Confirm that React state changes and destination selection do not create new `Map` instances.
8. Select a small sample of destination pairs across different regions and request ephemeral Mapbox routes through an opt-in server-side script or routing-adapter test.
9. If an individual destination repeatedly produces `NoSegment`, adjust that source-controlled coordinate manually rather than expanding the generator into a road-network system.

Visual inspection and a few route smoke checks are sufficient for this MVP; validating all 39,800 directed destination pairs is explicitly out of scope.

## Runtime World Loading

The generated files are the runtime source of truth and are not loaded into Postgres.

Add a small `WorldCatalog` loader in the server composition root that reads the three files once during startup, runs the same validation used by the generator, and retains immutable in-memory structures:

- Service-area polygon.
- Service zones keyed by zone ID.
- Destinations as a stable array for seeded selection.
- Destinations keyed by destination ID for lookup.

Inject the same catalog interface into the simulator and dispatch engine. Neither package should read files directly or know repository paths. Startup fails with an actionable error when a file is missing or invalid.

The React spike loads the same canonical files over Vite's public asset handling. It does not need an API endpoint for this static world data.

## Tests

- Unit-test seeded PRNG repeatability.
- Unit-test each validation failure with a minimal invalid fixture.
- Unit-test service-zone assignment, including boundary tie-breaking.
- Unit-test 75-meter rejection.
- Snapshot or hash the default generated outputs to detect unintended changes.
- Unit-test loading all 200 destinations into the immutable in-memory `WorldCatalog`.
- Unit-test missing and invalid world-file startup failures.
- Use a fake `RoutingPort` when testing simulation movement from generated destinations.
- Add a React component test for the missing-token state and world-data conversion.
- Add one opt-in browser smoke test that loads Mapbox, displays 200 destination points, and selects a point.

Live Mapbox requests are optional smoke tests and are not part of the default suite.

## Execution Order

1. Add world schemas and validation helpers.
2. Implement the seeded generator and produce all three assets.
3. Add generator and loader tests.
4. Implement the in-memory `WorldCatalog` loader.
5. Scaffold the React/Vite operator shell and `FleetMap` component.
6. Load and render the three assets in Mapbox.
7. Perform visual QA and manually correct obvious poor coordinates.
8. Connect simulator initialization and dispatch destination selection to `WorldCatalog`.
9. Verify a small sample of runtime Directions requests with the server-side adapter.
10. Record the final seed and any manually adjusted destinations in `assets/world/README.md`.

## Acceptance Criteria

- The default command reproducibly generates the three world assets.
- The world contains exactly 200 unique source-controlled destinations inside the Las Vegas demo boundary.
- The seven sampling-region counts match the plan.
- Every destination maps to exactly one of nine service zones.
- No generated route data is stored.
- `WorldCatalog` loads and validates the files once and provides the simulator and dispatch engine with in-memory destination data.
- Simulator and dispatch destination selection use only these destination IDs.
- The React app loads Mapbox in a browser and displays the boundary, nine zones, and 200 clickable destinations.
- Missing-token, loading, and map-error states are explicit.
- A reviewer can perform the visual checklist and obtain server-side runtime routes for a representative sample.
- All generator, validation, catalog-loader, and frontend spike tests pass.
