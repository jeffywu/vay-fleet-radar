import type { Coordinate, Destination } from "@fleet-radar/world";
import type { RoutingConfig } from "../config.ts";
import { ConcurrencyLimiter } from "./ConcurrencyLimiter.ts";
import { RoutingError, type RoutingErrorCode, isRetryableRoutingError } from "./errors.ts";
import { RateLimiter, defaultDelay, type Delay } from "./RateLimiter.ts";
import { RequestBudget } from "./RequestBudget.ts";
import type { PlannedRoute, RoutingMetrics, RoutingPort } from "./types.ts";
import { validatePlannedRoute } from "./validateRoute.ts";

export type MapboxRouterDependencies = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly delay?: Delay;
};

export class MapboxDirectionsRouter implements RoutingPort {
  private readonly budget: RequestBudget;
  private readonly limiter: RateLimiter;
  private readonly concurrency: ConcurrencyLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly delay: Delay;
  private attempts = 0;
  private successes = 0;
  private retries = 0;
  private latencyMs = 0;
  private readonly failures: Partial<Record<RoutingErrorCode, number>> = {};

  constructor(
    private readonly token: string,
    private readonly config: RoutingConfig,
    dependencies: MapboxRouterDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => Date.now());
    this.delay = dependencies.delay ?? defaultDelay;
    this.budget = new RequestBudget(config.maximumRequestsPerRun);
    this.limiter = new RateLimiter(config.requestsPerMinute, this.now, this.delay);
    this.concurrency = new ConcurrencyLimiter(config.maximumConcurrency);
  }

  async planRoute(origin: Coordinate, destination: Destination, signal?: AbortSignal): Promise<PlannedRoute> {
    this.validateInput(origin, destination);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maximumRetries; attempt += 1) {
      if (signal?.aborted) throw this.trackFailure(new RoutingError("CANCELLED"));
      if (attempt > 0) {
        this.retries += 1;
        const providerDelay = lastError instanceof RoutingError ? lastError.retryAfterMs : undefined;
        const backoff = Math.min(5_000, providerDelay ?? 100 * 2 ** (attempt - 1));
        await this.delay(backoff, signal).catch(() => { throw this.trackFailure(new RoutingError("CANCELLED")); });
      }
      try {
        return await this.executeAttempt(origin, destination, signal);
      } catch (error) {
        lastError = error;
        if (!isRetryableRoutingError(error) || attempt === this.config.maximumRetries) throw error;
      }
    }
    throw lastError;
  }

  metrics(): RoutingMetrics {
    return Object.freeze({ attempts: this.attempts, successes: this.successes, failures: { ...this.failures }, retries: this.retries,
      inFlight: this.concurrency.inFlight(), totalLatencyMs: this.latencyMs, remainingBudget: this.budget.remaining() });
  }

  private async executeAttempt(origin: Coordinate, destination: Destination, callerSignal?: AbortSignal): Promise<PlannedRoute> {
    try { this.budget.reserve(); }
    catch (error) { throw this.trackFailure(error as RoutingError); }
    await this.limiter.acquire(callerSignal).catch(() => { throw this.trackFailure(new RoutingError("CANCELLED")); });
    this.attempts += 1;
    const started = this.now();
    return this.concurrency.use(async () => {
      if (callerSignal?.aborted) throw this.trackFailure(new RoutingError("CANCELLED"));
      const timeout = new AbortController();
      const combined = new AbortController();
      const cancel = () => combined.abort(callerSignal?.reason);
      const timeOut = () => combined.abort(new Error("timeout"));
      callerSignal?.addEventListener("abort", cancel, { once: true });
      timeout.signal.addEventListener("abort", timeOut, { once: true });
      const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(this.buildUrl(origin, destination.coordinate), { signal: combined.signal });
        if (!response.ok) throw await this.httpError(response);
        const body = await response.json() as { code?: unknown; routes?: unknown };
        if (body.code === "NoRoute") throw new RoutingError("NO_ROUTE");
        if (body.code === "NoSegment") throw new RoutingError("NO_SEGMENT");
        if (body.code !== "Ok" || !Array.isArray(body.routes) || body.routes.length === 0) throw new RoutingError("INVALID_RESPONSE");
        const provider = body.routes[0] as Record<string, unknown>;
        const route = validatePlannedRoute({ geometry: provider.geometry, distanceMeters: provider.distance, durationSeconds: provider.duration }, origin, destination, this.config.endpointSnapToleranceMeters);
        this.successes += 1;
        return route;
      } catch (error) {
        let translated: RoutingError;
        if (error instanceof RoutingError) translated = error;
        else if (callerSignal?.aborted) translated = new RoutingError("CANCELLED");
        else if (timeout.signal.aborted) translated = new RoutingError("TIMEOUT");
        // Do not retain the native fetch error: runtimes may include the token-bearing URL in it.
        else translated = new RoutingError("PROVIDER_UNAVAILABLE");
        throw this.trackFailure(translated);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", cancel);
        this.latencyMs += Math.max(0, this.now() - started);
      }
    });
  }

  private validateInput(origin: Coordinate, destination: Destination): void {
    const valid = (value: Coordinate) => value.length === 2 && Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 && Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
    if (!this.token.trim() || !valid(origin) || !destination.id || !valid(destination.coordinate)) throw this.trackFailure(new RoutingError("INVALID_INPUT"));
  }

  private buildUrl(origin: Coordinate, destination: Coordinate): URL {
    const coordinates = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;
    const url = new URL(`/directions/v5/mapbox/driving/${coordinates}`, "https://api.mapbox.com");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("overview", "full");
    url.searchParams.set("steps", "false");
    url.searchParams.set("alternatives", "false");
    url.searchParams.set("access_token", this.token);
    return url;
  }

  private async httpError(response: Response): Promise<RoutingError> {
    const body = await response.json().catch(() => undefined) as { code?: unknown } | undefined;
    if (body?.code === "NoRoute") return new RoutingError("NO_ROUTE");
    if (body?.code === "NoSegment") return new RoutingError("NO_SEGMENT");
    if (body?.code === "InvalidInput") return new RoutingError("INVALID_INPUT");
    if (response.status === 401 || response.status === 403) return new RoutingError("AUTHENTICATION");
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
      return new RoutingError("RATE_LIMITED", undefined, undefined, retryAfterMs);
    }
    if (response.status >= 500) return new RoutingError("PROVIDER_UNAVAILABLE");
    return new RoutingError("INVALID_RESPONSE");
  }

  private trackFailure(error: RoutingError): RoutingError {
    this.failures[error.code] = (this.failures[error.code] ?? 0) + 1;
    return error;
  }
}

export class UnavailableRouter implements RoutingPort {
  constructor(private readonly code: "AUTHENTICATION" | "BUDGET_EXHAUSTED" = "AUTHENTICATION") {}
  async planRoute(): Promise<never> { throw new RoutingError(this.code); }
}
