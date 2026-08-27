# Las Vegas simulation world

These files are the runtime source of truth for the Fleet Radar simulation world:

- `service-area.geojson`: simplified Las Vegas metro operating boundary.
- `service-zones.geojson`: nine equal operational cells.
- `destinations.json`: 200 deterministic synthetic destinations.

Generate them from the repository root with:

```sh
npm run generate:world -- --seed vay-las-vegas-v1 --force
```

The committed files use seed `vay-las-vegas-v1`. Coordinates use WGS84 `[longitude, latitude]` order and are rounded to six decimal places. Destinations are pseudorandom samples of the seven hand-configured urban rectangles documented in `plans/BOUNDED_SIMULATION_WORLD_PLAN.md`; they are synthetic and are not geocoded points of interest.

Routes are not part of these assets. The application requests route geometry ephemerally when movement starts. No generated coordinate has been manually adjusted in this version.

## Preview and checks

The Vite app reads the same files directly from this directory:

```sh
npm run dev
```

For local development, either set `MAPBOX_TOKEN` in the repository `.env` or copy `apps/web/.env.example` to `apps/web/.env.local` and set a public, URL-restricted `VITE_MAPBOX_ACCESS_TOKEN`. The committed examples contain no credential.

Run the default checks with `npm test` and `npm run build`. `npm run smoke:directions` makes three ephemeral route requests using `MAPBOX_DIRECTIONS_ACCESS_TOKEN`, falling back to `MAPBOX_TOKEN` for this MVP. `npm run smoke:web` is an opt-in Playwright check and requires a locally installed Playwright Chromium binary (`npx playwright install chromium`). Live smoke checks are intentionally outside the default test suite.
