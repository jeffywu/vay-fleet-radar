import { once } from "node:events";
import type { FastifyInstance } from "fastify";
import type { ProjectionUpdateRepository } from "../database/ProjectionUpdateRepository.ts";
import type { ProjectionStreamHub } from "./ProjectionStreamHub.ts";
import { ApiError } from "./errors.ts";

const cursorPattern = /^(0|[1-9][0-9]{0,19})$/;
export function registerEventStream(app: FastifyInstance, hub: ProjectionStreamHub, updates: ProjectionUpdateRepository,
  heartbeatMs: number): void {
  app.get("/api/events", { schema: { querystring: { type: "object", additionalProperties: false,
    properties: { after: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" } } } } }, async (request, reply) => {
    const query = request.query as { after?: unknown };
    const header = request.headers["last-event-id"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const requested = headerValue ? headerValue : query.after === undefined ? undefined : String(query.after);
    if (requested !== undefined && (!cursorPattern.test(requested) || BigInt(requested) > 9_223_372_036_854_775_807n)) {
      throw new ApiError(400, "INVALID_CURSOR", "Event cursor is invalid");
    }
    const cursor = requested ?? await updates.currentCursor(app.pgPool);
    const oldest = await updates.oldestCursor(app.pgPool);
    const reset = oldest !== undefined && BigInt(cursor) < BigInt(oldest) - 1n;

    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no" });
    if (reset) {
      reply.raw.end(`event: stream.reset-required\ndata: {"reason":"cursor-pruned"}\n\n`);
      return;
    }
    let closed = false;
    let detach: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const close = () => { if (closed) return; closed = true; if (heartbeat) clearInterval(heartbeat); detach(); if (!reply.raw.destroyed) reply.raw.end(); };
    request.raw.once("close", close);
    const write = async (value: string) => {
      if (closed || reply.raw.destroyed) throw new Error("SSE client disconnected");
      if (reply.raw.writableLength > 256 * 1024) throw new Error("SSE client buffer limit exceeded");
      if (!reply.raw.write(value)) await once(reply.raw, "drain");
    };
    detach = hub.attach(cursor, async (update) => write(`id: ${update.streamId}\nevent: ${update.updateType}\ndata: ${JSON.stringify(update.payload)}\n\n`), close);
    heartbeat = setInterval(() => void write(`: heartbeat\n\n`).catch(close), heartbeatMs);
    heartbeat.unref();
  });
}

declare module "fastify" { interface FastifyInstance { pgPool: import("pg").default.Pool } }
