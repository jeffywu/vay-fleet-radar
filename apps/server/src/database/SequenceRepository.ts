import type pg from "pg";

export class SequenceRepository {
  async maximumByVehicle(pool: pg.Pool): Promise<ReadonlyMap<string, number>> {
    const result = await pool.query<{ vehicle_id: string; sequence: string }>(
      "SELECT vehicle_id,MAX(sequence)::text AS sequence FROM event_log GROUP BY vehicle_id",
    );
    return new Map(result.rows.map((row) => [row.vehicle_id, Number(row.sequence)]));
  }
}
