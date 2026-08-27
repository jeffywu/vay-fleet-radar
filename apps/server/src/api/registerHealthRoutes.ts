import type { FastifyInstance } from "fastify";

export type HealthDependencies = {
  database: () => Promise<boolean>;
  consumer: () => "ready" | "stopped" | "failed";
  routing: () => "ready" | "degraded";
};
export function registerHealthRoutes(app: FastifyInstance, dependencies: HealthDependencies): void {
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health", async (_request, reply) => {
    const database = await dependencies.database().catch(() => false);
    const consumer = dependencies.consumer();
    const routing = dependencies.routing();
    const available = database && consumer === "ready";
    void reply.status(available ? 200 : 503);
    return { status: available ? (routing === "degraded" ? "degraded" : "ok") : "unavailable",
      database: database ? "ready" : "unavailable", eventConsumer: consumer, routing };
  });
}
