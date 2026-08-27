import type pg from "pg";
import { defaultWorldPaths, loadWorldCatalog } from "@fleet-radar/world/load";
import { loadServerConfig } from "../config/loadServerConfig.ts";
import { ProjectionReducer } from "../eventing/ProjectionReducer.ts";
import { EventStore } from "./EventStore.ts";
import { createDatabasePool, verifyDatabase } from "./pool.ts";
import { inTransaction } from "./transaction.ts";

export type RebuildResult = { applied: number; stale: number; noOp: number; events: number };

export async function rebuildProjections(pool: pg.Pool, reducer: ProjectionReducer): Promise<RebuildResult> {
  return inTransaction(pool, async (client) => {
    const locked = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(1936028274) AS acquired");
    if (!locked.rows[0]?.acquired) throw new Error("Another projection rebuild is already running");
    const events = await new EventStore().replay(client);
    await client.query("TRUNCATE vehicle_current,route_current,dispatch_job,vehicle_projection_cursor,projection_update RESTART IDENTITY");
    const result: RebuildResult = { applied: 0, stale: 0, noOp: 0, events: events.length };
    for (const stored of events) {
      const projected = await reducer.apply(client, stored.event, stored.receivedAt);
      if (projected.disposition === "APPLIED") result.applied += 1;
      else if (projected.disposition === "STALE") result.stale += 1;
      else result.noOp += 1;
    }
    return result;
  }, { isolation: "SERIALIZABLE" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadServerConfig();
  const pool = createDatabasePool(config);
  try {
    await verifyDatabase(pool);
    const world = await loadWorldCatalog(defaultWorldPaths(process.cwd()));
    const result = await rebuildProjections(pool, new ProjectionReducer(world));
    process.stdout.write(`Rebuilt ${result.events} events: ${result.applied} applied, ${result.stale} stale, ${result.noOp} no-op.\n`);
  } finally { await pool.end(); }
}
