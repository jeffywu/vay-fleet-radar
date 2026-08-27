import type pg from "pg";
import type { DispatchJobDto } from "./types.ts";

type JobRow = { dispatch_job_id: string; vehicle_id: string; route_id: string; route_version: number; destination_id: string; strategy: string; decision_reason: string | null; command_id: string; correlation_id: string; state: string; requested_at: Date; accepted_at: Date | null; started_at: Date | null; completed_at: Date | null; updated_at: Date };
export type JobPageQuery = { state?: string; limit: number; cursor?: { updatedAt: string; dispatchJobId: string } };

export class DispatchJobRepository {
  constructor(private readonly pool: pg.Pool) {}
  async countActive(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM dispatch_job WHERE state IN ('REQUESTED','ACCEPTED','IN_PROGRESS')",
    );
    return result.rows[0]!.count;
  }
  async listJobs(query: JobPageQuery): Promise<{ data: DispatchJobDto[]; nextCursor?: string }> {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (query.state) { values.push(query.state); filters.push(`state=$${values.length}`); }
    if (query.cursor) { values.push(query.cursor.updatedAt, query.cursor.dispatchJobId); filters.push(`(updated_at,dispatch_job_id) < ($${values.length - 1}::timestamptz,$${values.length})`); }
    values.push(query.limit + 1);
    const result = await this.pool.query<JobRow>(`SELECT * FROM dispatch_job ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY updated_at DESC,dispatch_job_id DESC LIMIT $${values.length}`, values);
    const rows = result.rows.slice(0, query.limit);
    const data = rows.map(toDto);
    const last = rows.at(-1);
    return { data, ...(result.rows.length > query.limit && last ? { nextCursor: Buffer.from(JSON.stringify([last.updated_at.toISOString(), last.dispatch_job_id])).toString("base64url") } : {}) };
  }
}

export function toDto(row: JobRow): DispatchJobDto {
  return { dispatchJobId: row.dispatch_job_id, vehicleId: row.vehicle_id, routeId: row.route_id, routeVersion: row.route_version,
    destinationId: row.destination_id, strategy: row.strategy, ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    commandId: row.command_id, correlationId: row.correlation_id, state: row.state, requestedAt: row.requested_at.toISOString(),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at.toISOString() } : {}), ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}), updatedAt: row.updated_at.toISOString() };
}
