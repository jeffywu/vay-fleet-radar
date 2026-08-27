import type { FastifyInstance } from "fastify";
import type { ActiveRouteReader } from "@fleet-radar/simulation";
import type { FleetReadRepository } from "../database/FleetReadRepository.ts";
import { ApiError } from "./errors.ts";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const statuses = new Set(["FREE", "WITH_CUSTOMER", "EN_ROUTE"]);

export function registerVehicleRoutes(app: FastifyInstance, fleet: FleetReadRepository, routes: ActiveRouteReader,
  staleAfterSeconds: number, now: () => Date = () => new Date()): void {
  app.get("/api/vehicles", { schema: { querystring: { type: "object", additionalProperties: false, properties: {
    status: { type: "string", enum: [...statuses] }, zoneId: { type: "string", minLength: 1, maxLength: 128 },
    stale: { type: "string", enum: ["true", "false"] }, lowBattery: { type: "string", pattern: "^(?:100|[0-9]{1,2})(?:\\.[0-9]+)?$" },
    search: { type: "string", minLength: 1, maxLength: 128 },
  } } } }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const status = stringValue(query.status, "status");
    if (status && !statuses.has(status)) throw new ApiError(400, "INVALID_STATUS", "status is not supported");
    const zoneId = stringValue(query.zoneId, "zoneId");
    const search = stringValue(query.search, "search");
    const stale = booleanValue(query.stale, "stale");
    const lowBattery = numberValue(query.lowBattery, "lowBattery", 0, 100);
    const snapshot = await fleet.listVehicles({ ...(status ? { status } : {}), ...(zoneId ? { zoneId } : {}),
      ...(search ? { search } : {}), ...(stale === undefined ? {} : { stale }), ...(lowBattery === undefined ? {} : { lowBattery }) });
    return { data: snapshot.data, meta: { count: snapshot.data.length, generatedAt: now().toISOString(),
      streamCursor: snapshot.streamCursor, staleAfterSeconds } };
  });

  app.get("/api/vehicles/:vehicleId", { schema: { params: { type: "object", additionalProperties: false, required: ["vehicleId"],
    properties: { vehicleId: { type: "string", minLength: 1, maxLength: 128 } } } } }, async (request) => {
    const vehicleId = (request.params as { vehicleId: string }).vehicleId;
    if (!identifier.test(vehicleId)) throw new ApiError(400, "INVALID_VEHICLE_ID", "vehicleId has an invalid format");
    const vehicle = await fleet.getVehicle(vehicleId, routes);
    if (!vehicle) throw new ApiError(404, "VEHICLE_NOT_FOUND", "Vehicle was not found");
    return { data: vehicle };
  });
}

function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 128) throw new ApiError(400, "INVALID_QUERY", `${name} is invalid`);
  return value;
}
function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError(400, "INVALID_QUERY", `${name} must be true or false`);
}
function numberValue(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ApiError(400, "INVALID_QUERY", `${name} is invalid`);
  return number;
}
