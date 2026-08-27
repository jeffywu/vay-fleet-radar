import type { FastifyInstance } from "fastify";
import type { DispatchJobRepository } from "../database/DispatchJobRepository.ts";
import { ApiError } from "./errors.ts";

const states = new Set(["REQUESTED", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "REJECTED", "CANCELLED", "FAILED"]);
export function registerDispatchRoutes(app: FastifyInstance, jobs: DispatchJobRepository): void {
  app.get("/api/dispatch-jobs", { schema: { querystring: { type: "object", additionalProperties: false, properties: {
    state: { type: "string", enum: [...states] }, limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
    cursor: { type: "string", minLength: 1, maxLength: 1024 },
  } } } }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const state = query.state === undefined ? undefined : String(query.state);
    if (state && !states.has(state)) throw new ApiError(400, "INVALID_STATE", "state is not supported");
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, "INVALID_LIMIT", "limit must be from 1 to 200");
    const cursor = query.cursor === undefined ? undefined : decodeCursor(String(query.cursor));
    const page = await jobs.listJobs({ ...(state ? { state } : {}), limit, ...(cursor ? { cursor } : {}) });
    return { data: page.data, meta: { count: page.data.length, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
  });
}
function decodeCursor(value: string): { updatedAt: string; dispatchJobId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== "string") throw new Error();
    return { updatedAt: parsed[0], dispatchJobId: parsed[1] };
  } catch { throw new ApiError(400, "INVALID_CURSOR", "cursor is invalid"); }
}
