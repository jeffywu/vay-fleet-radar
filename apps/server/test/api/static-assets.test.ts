import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveRouteReader } from "@fleet-radar/simulation";
import { createApiServer } from "../../src/api/createApiServer.ts";
import type { ServerConfig } from "../../src/config/loadServerConfig.ts";

const config: ServerConfig = { databaseUrl: "postgresql://unused", host: "127.0.0.1", port: 3000, staleAfterSeconds: 10,
  poolSize: 1, statementTimeoutMs: 5_000, heartbeatMs: 1_000, streamPollMs: 100, streamPageSize: 10,
  dispatchTargetActive: 0, dispatchIntervalMs: 5_000, dispatchMaxPerCycle: 1, streamRetentionRows: 10_000,
  streamRetentionHours: 24, logLevel: "silent" };
const routes: ActiveRouteReader = { get: () => undefined, listDispatchRoutes: () => [] };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("same-origin web serving", () => {
  it("serves the built SPA and backend routes from one Fastify application", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-radar-static-"));
    roots.push(root);
    const webRoot = join(root, "apps/web/dist");
    await mkdir(webRoot, { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<!doctype html><main>Fleet map</main>");
    await writeFile(join(webRoot, "app.js"), "globalThis.fleetMap = true;");
    const pool = { query: vi.fn(), connect: vi.fn() } as unknown as pg.Pool;
    const { app } = await createApiServer({ pool, config, routes, repositoryRoot: root,
      health: { database: async () => true, consumer: () => "ready", routing: () => "ready" } });

    try {
      const document = await app.inject({ method: "GET", url: "/dashboard" });
      expect(document.statusCode).toBe(200);
      expect(document.body).toContain("Fleet map");
      expect(document.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect((await app.inject({ method: "GET", url: "/app.js" })).body).toContain("fleetMap");
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ status: "ok" });
      const missingApi = await app.inject({ method: "GET", url: "/api/not-a-route" });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json()).toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await app.close();
    }
  });
});
