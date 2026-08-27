import pg from "pg";
import type { ServerConfig } from "../config/loadServerConfig.ts";

export function createDatabasePool(config: ServerConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.statementTimeoutMs,
    application_name: "fleet-radar",
  });
}

export async function verifyDatabase(pool: pg.Pool, attempts = 10): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await pool.query("SELECT 1"); return; }
    catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, 200 * 2 ** attempt)));
    }
  }
  throw new Error("Database is unavailable", { cause: lastError });
}
