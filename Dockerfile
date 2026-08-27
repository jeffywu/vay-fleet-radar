# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.19.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Keep dependency installation cacheable across source changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/dispatch/package.json packages/dispatch/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/simulation/package.json packages/simulation/package.json
COPY packages/world/package.json packages/world/package.json
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY apps apps
COPY packages packages
COPY assets assets
COPY config config
COPY db db
COPY tools tools

# A public Mapbox token is intentionally compiled into the browser bundle. The
# server-only Directions token must only be supplied to the runtime container.
ARG VITE_MAPBOX_ACCESS_TOKEN=""
ENV VITE_MAPBOX_ACCESS_TOKEN=${VITE_MAPBOX_ACCESS_TOKEN}
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/dispatch/package.json packages/dispatch/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/simulation/package.json packages/simulation/package.json
COPY packages/world/package.json packages/world/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @fleet-radar/server && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    APP_PORT=3000

COPY --from=production-dependencies /app/node_modules node_modules
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/assets assets
COPY --from=build /app/config config
COPY --from=build /app/db db

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "apps/server/dist/main.js"]
