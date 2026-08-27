import type { FastifyInstance } from "fastify";

export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof Error ? error : new Error("Unknown request failure");
    const validation = typeof error === "object" && error !== null && "validation" in error && Boolean(error.validation);
    const status = known instanceof ApiError ? known.statusCode : validation ? 400 : 500;
    const code = known instanceof ApiError ? known.code : validation ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    if (status >= 500) request.log.error({ err: { name: known.name, message: "Request failed" } }, "request failed");
    void reply.status(status).send({ code, message: status >= 500 ? "Unexpected server error" : known.message, requestId: request.id });
  });
}
