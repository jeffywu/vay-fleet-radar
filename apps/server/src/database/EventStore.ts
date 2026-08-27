import type pg from "pg";
import type { AnyFleetEvent } from "@fleet-radar/domain/events";

export type AppendedEvent = { ingestId: string; receivedAt: string };

export class EventStore {
  async append(client: pg.PoolClient, event: AnyFleetEvent, receivedAt?: string): Promise<AppendedEvent | undefined> {
    const result = await client.query<{ ingest_id: string; received_at: Date }>(
      `INSERT INTO event_log (event_id,event_type,schema_version,vehicle_id,sequence,occurred_at,received_at,correlation_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,clock_timestamp()),$8,$9::jsonb)
       ON CONFLICT (event_id) DO NOTHING RETURNING ingest_id,received_at`,
      [event.eventId, event.eventType, event.schemaVersion, event.vehicleId, event.sequence, event.occurredAt,
        receivedAt ?? null, event.correlationId ?? null, JSON.stringify(event.payload)],
    );
    const row = result.rows[0];
    return row ? { ingestId: row.ingest_id, receivedAt: row.received_at.toISOString() } : undefined;
  }

  async replay(client: pg.PoolClient): Promise<readonly { event: AnyFleetEvent; receivedAt: string }[]> {
    const result = await client.query<{ event_id: string; event_type: AnyFleetEvent["eventType"]; schema_version: 1; vehicle_id: string; sequence: string; occurred_at: Date; received_at: Date; correlation_id: string | null; payload: AnyFleetEvent["payload"] }>(
      "SELECT event_id,event_type,schema_version,vehicle_id,sequence,occurred_at,received_at,correlation_id,payload FROM event_log ORDER BY ingest_id",
    );
    return result.rows.map((row) => ({
      event: { eventId: row.event_id, eventType: row.event_type, schemaVersion: row.schema_version, vehicleId: row.vehicle_id,
        sequence: Number(row.sequence), occurredAt: row.occurred_at.toISOString(), ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        payload: row.payload } as AnyFleetEvent,
      receivedAt: row.received_at.toISOString(),
    }));
  }
}
