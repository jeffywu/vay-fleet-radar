export type RoutingErrorCode =
  | "INVALID_INPUT"
  | "AUTHENTICATION"
  | "NO_ROUTE"
  | "NO_SEGMENT"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "INVALID_RESPONSE"
  | "CANCELLED";

export class RoutingError extends Error {
  constructor(readonly code: RoutingErrorCode, message = `Routing failed: ${code}`, options?: ErrorOptions, readonly retryAfterMs?: number) {
    super(message, options);
    this.name = "RoutingError";
  }
}

export function isRetryableRoutingError(error: unknown): boolean {
  return error instanceof RoutingError && ["RATE_LIMITED", "TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(error.code);
}
