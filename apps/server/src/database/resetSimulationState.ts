import type pg from "pg";

/** Starts a new local simulation run while preserving schema and migration history. */
export async function resetSimulationState(pool: pg.Pool): Promise<void> {
  await pool.query(
    "TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log CASCADE",
  );
}
