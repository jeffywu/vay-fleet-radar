# Fleet Radar

Fleet Radar is a local operational fleet simulation for the Las Vegas service area. The composed application runs Postgres, applies migrations, starts the REST/SSE backend and simulation runtime, and serves the built React dashboard from one application container.

## Run locally with Docker

Requirements: Docker with Compose v2 and an available local port 3000.

```sh
cp .env.example .env
docker compose up --build --wait
```

Open <http://localhost:3000>. `docker compose logs -f app` follows application logs, and `docker compose down` stops the stack without deleting fleet data.

Mapbox is optional for startup. Set `VITE_MAPBOX_ACCESS_TOKEN` to a public `pk.*` token for the browser map and `MAPBOX_DIRECTIONS_ACCESS_TOKEN` to a server-only token for live routing. The backend remains available in degraded-routing mode when the server token is absent. Never put a secret token in `VITE_MAPBOX_ACCESS_TOKEN`, a Docker build argument, source control, logs, or browser code.

For compatibility with the initial local spike, a root `MAPBOX_TOKEN` is also accepted by host-run development. The browser build still rejects it unless it is a public `pk.*` token. Prefer the two explicit variables above when configuring Docker or shared environments.

Postgres data is stored in the `postgres-data` named volume and survives application rebuilds and normal shutdowns. To intentionally delete all local database state, run `docker compose down --volumes`; this cannot be undone.

For this local MVP, the Compose-created database role also applies migrations. Production should separate a narrowly privileged application role from the migration owner.

## Common workflows

```sh
# Validate the expanded Compose configuration without starting containers
npm run docker:config

# Apply pending migrations to the configured DATABASE_URL
npm run db:migrate

# Roll back the most recently applied migration
npm run db:migrate:down

# Rebuild durable projections from the append-only event log
npm run db:rebuild-projections

# Rebuild containers after source or dependency changes
docker compose up --build --wait

# Run the Docker health/API smoke check; containers are stopped without deleting data
npm run docker:smoke
```

For host-run development, install dependencies with `npm ci`, set `DATABASE_URL` to `postgresql://fleet_radar:replace-local-password@localhost:5432/fleet_radar`, and start only Postgres with `docker compose up -d --wait postgres`. Then run `npm run db:migrate`, `npm run dev:server`, and `npm run dev:web` in separate terminals. Vite serves <http://127.0.0.1:5173> and proxies `/api` and `/health` to the backend.

## Troubleshooting

- If `migrate` exits, inspect `docker compose logs migrate postgres`; the application intentionally waits for a successful migration.
- If `/health` reports unavailable, check that Postgres is healthy and the `.env` database values agree. Container connections use the host name `postgres`; host-run tools use `localhost`.
- If the map shows its token setup state, add a public `pk.*` browser token and rebuild the application image. A Directions token is runtime-only and does not require an image rebuild.
- If port 3000 is occupied, change `APP_PORT` in `.env`. For host-run Vite against a different backend port, set `VITE_API_PROXY_TARGET` before starting it.
- `docker compose build --no-cache app` performs a clean image rebuild. It does not delete the Postgres volume.
