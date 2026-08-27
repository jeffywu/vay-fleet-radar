import type pg from "pg";
import type { ProjectionUpdate } from "./types.ts";

type UpdateType = ProjectionUpdate["updateType"];

export class ProjectionUpdateRepository {
  async insert(client: pg.PoolClient, eventId: string, updateType: UpdateType, aggregateId: string, payload: unknown): Promise<string> {
    const result = await client.query<{ stream_id: string }>(
      `INSERT INTO projection_update (event_id,update_type,aggregate_id,payload) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (event_id,update_type,aggregate_id) DO UPDATE SET payload=EXCLUDED.payload RETURNING stream_id`,
      [eventId, updateType, aggregateId, JSON.stringify(payload)],
    );
    return result.rows[0]!.stream_id;
  }

  async currentCursor(queryable: Pick<pg.Pool, "query"> | pg.PoolClient): Promise<string> {
    const result = await queryable.query<{ cursor: string }>("SELECT COALESCE(MAX(stream_id),0)::text AS cursor FROM projection_update");
    return result.rows[0]!.cursor;
  }

  async oldestCursor(queryable: Pick<pg.Pool, "query"> | pg.PoolClient): Promise<string | undefined> {
    const result = await queryable.query<{ cursor: string | null }>("SELECT MIN(stream_id)::text AS cursor FROM projection_update");
    return result.rows[0]?.cursor ?? undefined;
  }

  async readAfter(queryable: Pick<pg.Pool, "query"> | pg.PoolClient, cursor: string, limit: number): Promise<readonly ProjectionUpdate[]> {
    const result = await queryable.query<{ stream_id: string; event_id: string; update_type: UpdateType; aggregate_id: string; payload: unknown; created_at: Date }>(
      "SELECT stream_id,event_id,update_type,aggregate_id,payload,created_at FROM projection_update WHERE stream_id > $1::bigint ORDER BY stream_id LIMIT $2",
      [cursor, limit],
    );
    return result.rows.map((row) => ({ streamId: row.stream_id, eventId: row.event_id, updateType: row.update_type,
      aggregateId: row.aggregate_id, payload: row.payload, createdAt: row.created_at.toISOString() }));
  }

  async prune(pool: pg.Pool, keepRows: number, keepHours: number): Promise<number> {
    const result = await pool.query(
      `DELETE FROM projection_update WHERE created_at < clock_timestamp() - ($1 * interval '1 hour')
       AND stream_id < COALESCE((SELECT stream_id FROM projection_update ORDER BY stream_id DESC OFFSET $2 LIMIT 1),0)`,
      [keepHours, keepRows],
    );
    return result.rowCount ?? 0;
  }
}
