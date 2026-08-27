export type ServerConfig = {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly staleAfterSeconds: number;
  readonly poolSize: number;
  readonly statementTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly streamPollMs: number;
  readonly streamPageSize: number;
  readonly dispatchTargetActive: number;
  readonly dispatchIntervalMs: number;
  readonly dispatchMaxPerCycle: number;
  readonly streamRetentionRows: number;
  readonly streamRetentionHours: number;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
};

function integer(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const logLevel = environment.LOG_LEVEL?.trim() || "info";
  if (!["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(logLevel)) throw new Error("LOG_LEVEL is invalid");
  return {
    databaseUrl,
    host: environment.APP_HOST?.trim() || "0.0.0.0",
    port: integer(environment.APP_PORT, 3000, "APP_PORT", 1, 65_535),
    staleAfterSeconds: integer(environment.STALE_AFTER_SECONDS, 10, "STALE_AFTER_SECONDS", 1, 3_600),
    poolSize: integer(environment.DATABASE_POOL_SIZE, 10, "DATABASE_POOL_SIZE", 1, 50),
    statementTimeoutMs: integer(environment.DATABASE_STATEMENT_TIMEOUT_MS, 5_000, "DATABASE_STATEMENT_TIMEOUT_MS", 100, 60_000),
    heartbeatMs: integer(environment.SSE_HEARTBEAT_MS, 15_000, "SSE_HEARTBEAT_MS", 1_000, 60_000),
    streamPollMs: integer(environment.SSE_POLL_MS, 1_000, "SSE_POLL_MS", 100, 30_000),
    streamPageSize: integer(environment.SSE_PAGE_SIZE, 250, "SSE_PAGE_SIZE", 1, 1_000),
    dispatchTargetActive: integer(environment.DISPATCH_TARGET_ACTIVE, 10, "DISPATCH_TARGET_ACTIVE", 0, 100),
    dispatchIntervalMs: integer(environment.DISPATCH_INTERVAL_MS, 5_000, "DISPATCH_INTERVAL_MS", 500, 60_000),
    dispatchMaxPerCycle: integer(environment.DISPATCH_MAX_PER_CYCLE, 2, "DISPATCH_MAX_PER_CYCLE", 1, 20),
    streamRetentionRows: integer(environment.SSE_RETENTION_ROWS, 10_000, "SSE_RETENTION_ROWS", 100, 1_000_000),
    streamRetentionHours: integer(environment.SSE_RETENTION_HOURS, 24, "SSE_RETENTION_HOURS", 1, 720),
    logLevel: logLevel as ServerConfig["logLevel"],
  };
}
