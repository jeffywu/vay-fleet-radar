import { access } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type pg from "pg";
import type { ActiveRouteReader } from "@fleet-radar/simulation";
import type { ServerConfig } from "../config/loadServerConfig.ts";
import { DispatchJobRepository } from "../database/DispatchJobRepository.ts";
import { FleetReadRepository } from "../database/FleetReadRepository.ts";
import { ProjectionUpdateRepository } from "../database/ProjectionUpdateRepository.ts";
import { ProjectionStreamHub } from "./ProjectionStreamHub.ts";
import { registerDispatchRoutes } from "./registerDispatchRoutes.ts";
import { registerErrorHandling } from "./errors.ts";
import { registerEventStream } from "./registerEventStream.ts";
import { registerHealthRoutes, type HealthDependencies } from "./registerHealthRoutes.ts";
import { registerVehicleRoutes } from "./registerVehicleRoutes.ts";

export type ApiServerDependencies = {
  pool: pg.Pool;
  config: ServerConfig;
  routes: ActiveRouteReader;
  health: HealthDependencies;
  repositoryRoot?: string;
  now?: () => Date;
};

export async function createApiServer(dependencies: ApiServerDependencies): Promise<{ app: FastifyInstance; hub: ProjectionStreamHub }> {
  const app = Fastify({ logger: { level: dependencies.config.logLevel }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16 * 1024,
    genReqId: (request) => boundedRequestId(request.headers["x-request-id"]) });
  app.decorate("pgPool", dependencies.pool);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-ID", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob: https://*.mapbox.com; connect-src 'self' https://*.mapbox.com https://events.mapbox.com; script-src 'self'; style-src 'self' 'unsafe-inline' https://api.mapbox.com; worker-src 'self' blob:; font-src 'self' https://api.mapbox.com");
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ requestId: request.id, method: request.method, route: request.routeOptions.url,
      statusCode: reply.statusCode, durationMs: reply.elapsedTime }, "request complete");
  });
  registerErrorHandling(app);
  const updates = new ProjectionUpdateRepository();
  const hub = new ProjectionStreamHub(dependencies.pool, updates, dependencies.config.streamPollMs, dependencies.config.streamPageSize,
    dependencies.config.streamRetentionRows, dependencies.config.streamRetentionHours);
  registerVehicleRoutes(app, new FleetReadRepository(dependencies.pool, dependencies.config.staleAfterSeconds, dependencies.now),
    dependencies.routes, dependencies.config.staleAfterSeconds, dependencies.now);
  registerDispatchRoutes(app, new DispatchJobRepository(dependencies.pool));
  registerHealthRoutes(app, dependencies.health);
  registerEventStream(app, hub, updates, dependencies.config.heartbeatMs);

  const webRoot = resolve(dependencies.repositoryRoot ?? process.cwd(), "apps/web/dist");
  if (await access(webRoot).then(() => true, () => false)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/health")) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Route not found", requestId: request.id });
      }
      return reply.sendFile("index.html");
    });
  }
  return { app, hub };
}

function boundedRequestId(value: string | string[] | undefined): string {
  const input = Array.isArray(value) ? value[0] : value;
  return input && /^[A-Za-z0-9._-]{1,64}$/.test(input) ? input : crypto.randomUUID();
}
