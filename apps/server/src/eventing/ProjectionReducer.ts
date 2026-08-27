import type pg from "pg";
import type { AnyFleetEvent } from "@fleet-radar/domain/events";
import { serviceZoneIdFor, type WorldCatalogView } from "@fleet-radar/world";
import { ProjectionUpdateRepository } from "../database/ProjectionUpdateRepository.ts";

export type ProjectionDisposition = "APPLIED" | "STALE" | "NO_OP";
export type ProjectionResult = { disposition: ProjectionDisposition; streamIds: readonly string[] };

export class ProjectionReducer {
  constructor(private readonly world: WorldCatalogView, private readonly updates = new ProjectionUpdateRepository()) {}

  async apply(client: pg.PoolClient, event: AnyFleetEvent, receivedAt: string): Promise<ProjectionResult> {
    await client.query(
      `INSERT INTO vehicle_projection_cursor (vehicle_id,last_sequence,last_event_id,updated_at)
       VALUES ($1,0,$2,$3) ON CONFLICT (vehicle_id) DO NOTHING`, [event.vehicleId, event.eventId, receivedAt],
    );
    const cursor = await client.query<{ last_sequence: string }>(
      "SELECT last_sequence FROM vehicle_projection_cursor WHERE vehicle_id=$1 FOR UPDATE", [event.vehicleId],
    );
    if (event.sequence <= Number(cursor.rows[0]!.last_sequence)) return { disposition: "STALE", streamIds: [] };

    const changes = await this.project(client, event, receivedAt);
    await client.query(
      "UPDATE vehicle_projection_cursor SET last_sequence=$2,last_event_id=$3,updated_at=$4 WHERE vehicle_id=$1",
      [event.vehicleId, event.sequence, event.eventId, receivedAt],
    );
    const streamIds: string[] = [];
    for (const change of changes) streamIds.push(await this.updates.insert(client, event.eventId, change.type, change.id, change.payload));
    return { disposition: changes.length ? "APPLIED" : "NO_OP", streamIds };
  }

  private async project(client: pg.PoolClient, event: AnyFleetEvent, receivedAt: string): Promise<readonly Change[]> {
    switch (event.eventType) {
      case "vehicle.telemetry-received": {
        const zoneId = serviceZoneIdFor(event.payload.coordinate);
        await client.query(
          `INSERT INTO vehicle_current (vehicle_id,longitude,latitude,heading,battery_percentage,status,service_zone_id,last_telemetry_sequence,last_occurred_at,last_received_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
           ON CONFLICT (vehicle_id) DO UPDATE SET longitude=EXCLUDED.longitude,latitude=EXCLUDED.latitude,heading=EXCLUDED.heading,
           battery_percentage=EXCLUDED.battery_percentage,status=EXCLUDED.status,service_zone_id=EXCLUDED.service_zone_id,
           last_telemetry_sequence=EXCLUDED.last_telemetry_sequence,last_occurred_at=EXCLUDED.last_occurred_at,
           last_received_at=EXCLUDED.last_received_at,updated_at=EXCLUDED.updated_at`,
          [event.vehicleId, event.payload.coordinate[0], event.payload.coordinate[1], event.payload.heading,
            event.payload.batteryPercentage, event.payload.status, zoneId, event.sequence, event.occurredAt, receivedAt],
        );
        return [{ type: "vehicle.updated", id: event.vehicleId, payload: await vehiclePayload(client, event.vehicleId) }];
      }
      case "dispatch.assignment-requested": {
        const correlationId = event.correlationId ?? event.payload.dispatchJobId;
        const inserted = await client.query(
          `INSERT INTO dispatch_job (dispatch_job_id,vehicle_id,route_id,route_version,destination_id,strategy,decision_reason,command_id,correlation_id,state,requested_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED',$10,$10)
           ON CONFLICT (dispatch_job_id) DO NOTHING`,
          [event.payload.dispatchJobId, event.vehicleId, event.payload.routeId, event.payload.routeVersion,
            event.payload.destinationId, event.payload.strategy, event.payload.reason ?? null, event.payload.commandId, correlationId, receivedAt],
        );
        if (!inserted.rowCount) {
          const same = await client.query<{ same: boolean }>(
            `SELECT command_id=$2 AND vehicle_id=$3 AND route_id=$4 AND route_version=$5 AND destination_id=$6 AS same
             FROM dispatch_job WHERE dispatch_job_id=$1`,
            [event.payload.dispatchJobId, event.payload.commandId, event.vehicleId, event.payload.routeId,
              event.payload.routeVersion, event.payload.destinationId],
          );
          if (!same.rows[0]?.same) throw new Error("Dispatch job identifier conflicts with different assignment facts");
          return [];
        }
        return [{ type: "dispatch-job.updated", id: event.payload.dispatchJobId, payload: await dispatchPayload(client, event.payload.dispatchJobId) }];
      }
      case "route.assigned": {
        const previous = await client.query<{ version: number }>("SELECT version FROM route_current WHERE vehicle_id=$1", [event.vehicleId]);
        if (previous.rows[0] && previous.rows[0].version >= event.payload.version) return [];
        await client.query(
          `INSERT INTO route_current (vehicle_id,route_id,version,destination_id,dispatch_job_id,state,origin_longitude,origin_latitude,last_event_sequence,assigned_at,updated_at)
           SELECT $1,$2,$3,$4,$5,$6,v.longitude,v.latitude,$7,$8,$8 FROM (SELECT 1) x LEFT JOIN vehicle_current v ON v.vehicle_id=$1
           ON CONFLICT (vehicle_id) DO UPDATE SET route_id=EXCLUDED.route_id,version=EXCLUDED.version,destination_id=EXCLUDED.destination_id,
           dispatch_job_id=EXCLUDED.dispatch_job_id,state=EXCLUDED.state,origin_longitude=EXCLUDED.origin_longitude,
           origin_latitude=EXCLUDED.origin_latitude,last_event_sequence=EXCLUDED.last_event_sequence,
           assigned_at=EXCLUDED.assigned_at,updated_at=EXCLUDED.updated_at`,
          [event.vehicleId, event.payload.routeId, event.payload.version, event.payload.destinationId, event.correlationId ?? null,
            event.payload.assignmentState, event.sequence, receivedAt],
        );
        const changes: Change[] = [{ type: "route.updated", id: event.vehicleId, payload: await routePayload(client, event.vehicleId) }];
        const job = await advanceJob(client, event.correlationId, event.payload.assignmentState, receivedAt);
        if (job) changes.push({ type: "dispatch-job.updated", id: job, payload: await dispatchPayload(client, job) });
        return changes;
      }
      case "route.updated": {
        const updated = await client.query(
          `UPDATE route_current SET version=$3,destination_id=$4,state='IN_PROGRESS',last_event_sequence=$5,updated_at=$6
           WHERE vehicle_id=$1 AND route_id=$2 AND version < $3`,
          [event.vehicleId, event.payload.routeId, event.payload.version, event.payload.destinationId, event.sequence, receivedAt],
        );
        if (!updated.rowCount) return [];
        const changes: Change[] = [{ type: "route.updated", id: event.vehicleId, payload: await routePayload(client, event.vehicleId) }];
        const job = await advanceJob(client, event.correlationId, "IN_PROGRESS", receivedAt);
        if (job) changes.push({ type: "dispatch-job.updated", id: job, payload: await dispatchPayload(client, job) });
        return changes;
      }
      case "route.cancelled":
      case "route.completed": {
        const removed = await client.query<{ route_id: string }>(
          "DELETE FROM route_current WHERE vehicle_id=$1 AND route_id=$2 AND version <= $3 RETURNING route_id",
          [event.vehicleId, event.payload.routeId, event.payload.version],
        );
        const state = event.eventType === "route.completed" ? "COMPLETED" : "CANCELLED";
        const changes: Change[] = removed.rows[0] ? [{ type: "route.removed", id: event.vehicleId,
          payload: { vehicleId: event.vehicleId, routeId: removed.rows[0].route_id } }] : [];
        const job = await advanceJob(client, event.correlationId, state, receivedAt);
        if (job) changes.push({ type: "dispatch-job.updated", id: job, payload: await dispatchPayload(client, job) });
        return changes;
      }
      case "route.assignment-rejected": {
        const job = await advanceJob(client, event.correlationId, "REJECTED", receivedAt, event.payload.reason);
        return job ? [{ type: "dispatch-job.updated", id: job, payload: await dispatchPayload(client, job) }] : [];
      }
      case "dispatch.assignment-completed": {
        const job = await advanceJob(client, event.payload.dispatchJobId, "COMPLETED", receivedAt);
        return job ? [{ type: "dispatch-job.updated", id: job, payload: await dispatchPayload(client, job) }] : [];
      }
    }
  }
}

type Change = { type: "vehicle.updated" | "route.updated" | "route.removed" | "dispatch-job.updated"; id: string; payload: unknown };

async function vehiclePayload(client: pg.PoolClient, vehicleId: string): Promise<unknown> {
  const result = await client.query(
    `SELECT vehicle_id AS "vehicleId",jsonb_build_array(longitude,latitude) AS coordinate,heading,
     battery_percentage AS "batteryPercentage",status,service_zone_id AS "serviceZoneId",
     last_occurred_at AS "lastOccurredAt",last_received_at AS "lastReceivedAt" FROM vehicle_current WHERE vehicle_id=$1`, [vehicleId],
  );
  return result.rows[0];
}
async function routePayload(client: pg.PoolClient, vehicleId: string): Promise<unknown> {
  const result = await client.query(
    `SELECT vehicle_id AS "vehicleId",route_id AS "routeId",version,destination_id AS "destinationId",state,false AS "geometryAvailable",updated_at AS "updatedAt"
     FROM route_current WHERE vehicle_id=$1`, [vehicleId],
  );
  return result.rows[0];
}
async function dispatchPayload(client: pg.PoolClient, jobId: string): Promise<unknown> {
  const result = await client.query(
    `SELECT dispatch_job_id AS "dispatchJobId",vehicle_id AS "vehicleId",route_id AS "routeId",route_version AS "routeVersion",
     destination_id AS "destinationId",strategy,decision_reason AS "decisionReason",command_id AS "commandId",correlation_id AS "correlationId",
     state,requested_at AS "requestedAt",accepted_at AS "acceptedAt",started_at AS "startedAt",completed_at AS "completedAt",updated_at AS "updatedAt"
     FROM dispatch_job WHERE dispatch_job_id=$1`, [jobId],
  );
  return result.rows[0];
}
async function advanceJob(client: pg.PoolClient, jobId: string | undefined, state: string, at: string, reason?: string): Promise<string | undefined> {
  if (!jobId) return undefined;
  const terminal = ["COMPLETED", "REJECTED", "CANCELLED", "FAILED"];
  const result = await client.query<{ dispatch_job_id: string }>(
    `UPDATE dispatch_job SET state=$2,decision_reason=COALESCE($4,decision_reason),
     accepted_at=CASE WHEN $2 IN ('ACCEPTED','IN_PROGRESS') THEN COALESCE(accepted_at,$3) ELSE accepted_at END,
     started_at=CASE WHEN $2='IN_PROGRESS' THEN COALESCE(started_at,$3) ELSE started_at END,
     completed_at=CASE WHEN $2 IN ('COMPLETED','REJECTED','CANCELLED','FAILED') THEN COALESCE(completed_at,$3) ELSE completed_at END,
     updated_at=$3 WHERE dispatch_job_id=$1 AND state <> ALL($5::text[]) RETURNING dispatch_job_id`,
    [jobId, state, at, reason ?? null, terminal],
  );
  return result.rows[0]?.dispatch_job_id;
}
