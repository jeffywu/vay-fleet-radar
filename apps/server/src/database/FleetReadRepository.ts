import type pg from "pg";
import type { ActiveRouteReader } from "@fleet-radar/simulation";
import type { LineString } from "geojson";
import { inTransaction } from "./transaction.ts";
import type { RouteDto, VehicleDto } from "./types.ts";
import { ProjectionUpdateRepository } from "./ProjectionUpdateRepository.ts";

export type VehicleQuery = { status?: string; zoneId?: string; stale?: boolean; lowBattery?: number; search?: string };
type VehicleRow = { vehicle_id: string; longitude: number; latitude: number; heading: number; battery_percentage: number; status: VehicleDto["status"]; service_zone_id: string; last_occurred_at: Date; last_received_at: Date; route_id: string | null; version: number | null; destination_id: string | null; route_state: RouteDto["state"] | null };

export class FleetReadRepository {
  constructor(private readonly pool: pg.Pool, private readonly staleAfterSeconds: number, private readonly now: () => Date = () => new Date()) {}

  async listVehicles(query: VehicleQuery = {}): Promise<{ data: VehicleDto[]; streamCursor: string }> {
    return inTransaction(this.pool, async (client) => {
      const params: unknown[] = [];
      const filters: string[] = [];
      const add = (sql: string, value: unknown) => { params.push(value); filters.push(sql.replace("?", `$${params.length}`)); };
      if (query.status) add("v.status = ?", query.status);
      if (query.zoneId) add("v.service_zone_id = ?", query.zoneId);
      if (query.lowBattery !== undefined) add("v.battery_percentage <= ?", query.lowBattery);
      if (query.search) add("v.vehicle_id LIKE ?", `${query.search}%`);
      if (query.stale !== undefined) {
        params.push(this.now().toISOString(), this.staleAfterSeconds);
        filters.push(`${query.stale ? "" : "NOT "}(v.last_received_at < $${params.length - 1}::timestamptz - ($${params.length} * interval '1 second'))`);
      }
      const result = await client.query<VehicleRow>(
        `SELECT v.*,r.route_id,r.version,r.destination_id,r.state AS route_state FROM vehicle_current v
         LEFT JOIN route_current r USING (vehicle_id) ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY v.vehicle_id`, params,
      );
      const cursor = await new ProjectionUpdateRepository().currentCursor(client);
      return { data: result.rows.map((row) => this.toDto(row)), streamCursor: cursor };
    }, { readonlyOnly: true, isolation: "REPEATABLE READ" });
  }

  async getVehicle(vehicleId: string, routes: ActiveRouteReader): Promise<(Omit<VehicleDto, "activeRoute"> & { activeRoute?: RouteDto & { geometry?: LineString } }) | undefined> {
    const result = await this.pool.query<VehicleRow>(
      `SELECT v.*,r.route_id,r.version,r.destination_id,r.state AS route_state FROM vehicle_current v
       LEFT JOIN route_current r USING (vehicle_id) WHERE v.vehicle_id=$1`, [vehicleId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const dto = this.toDto(row);
    const active = row.route_id ? routes.get(row.route_id) : undefined;
    if (!dto.activeRoute) return dto;
    dto.activeRoute.geometryAvailable = Boolean(active);
    return active ? { ...dto, activeRoute: { ...dto.activeRoute, geometry: active.geometry } } : dto;
  }

  private toDto(row: VehicleRow): VehicleDto {
    const isStale = row.last_received_at.getTime() < this.now().getTime() - this.staleAfterSeconds * 1_000;
    const activeRoute = row.route_id && row.version && row.destination_id && row.route_state ? {
      routeId: row.route_id, version: row.version, destinationId: row.destination_id, state: row.route_state, geometryAvailable: false,
    } : undefined;
    return { vehicleId: row.vehicle_id, coordinate: [row.longitude, row.latitude], heading: row.heading,
      batteryPercentage: row.battery_percentage, status: row.status, serviceZoneId: row.service_zone_id,
      lastOccurredAt: row.last_occurred_at.toISOString(), lastReceivedAt: row.last_received_at.toISOString(), isStale,
      ...(activeRoute ? { activeRoute } : {}) };
  }
}
