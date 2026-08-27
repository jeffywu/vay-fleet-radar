import type { AnyFleetEvent, FleetEventType } from "./types.ts";

const eventTypes = new Set<FleetEventType>([
  "vehicle.telemetry-received",
  "route.assigned",
  "route.updated",
  "route.cancelled",
  "route.completed",
  "route.assignment-rejected",
  "dispatch.assignment-requested",
  "dispatch.assignment-completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function validCoordinate(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === "number" && Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180 &&
    typeof value[1] === "number" && Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90;
}

function validatePayload(eventType: FleetEventType, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (eventType) {
    case "vehicle.telemetry-received":
      return validCoordinate(value.coordinate) && typeof value.heading === "number" &&
        value.heading >= 0 && value.heading < 360 && typeof value.batteryPercentage === "number" &&
        value.batteryPercentage >= 0 && value.batteryPercentage <= 100 &&
        ["FREE", "WITH_CUSTOMER", "EN_ROUTE"].includes(String(value.status));
    case "route.assigned":
      return nonEmpty(value.routeId) && positiveInteger(value.version) && nonEmpty(value.destinationId) &&
        ["ACCEPTED", "IN_PROGRESS"].includes(String(value.assignmentState));
    case "route.updated":
      return nonEmpty(value.routeId) && positiveInteger(value.version) && nonEmpty(value.destinationId);
    case "route.cancelled":
      return nonEmpty(value.routeId) && positiveInteger(value.version) &&
        (value.reason === undefined || nonEmpty(value.reason));
    case "route.completed":
      return nonEmpty(value.routeId) && positiveInteger(value.version) && nonEmpty(value.destinationId);
    case "route.assignment-rejected":
      return nonEmpty(value.routeId) && positiveInteger(value.version) && nonEmpty(value.destinationId) && nonEmpty(value.reason);
    case "dispatch.assignment-requested":
      return nonEmpty(value.dispatchJobId) && nonEmpty(value.routeId) && positiveInteger(value.routeVersion) &&
        nonEmpty(value.destinationId) && nonEmpty(value.strategy) && (value.reason === undefined || nonEmpty(value.reason));
    case "dispatch.assignment-completed":
      return nonEmpty(value.dispatchJobId) && nonEmpty(value.routeId) && positiveInteger(value.routeVersion);
  }
}

export function validateFleetEvent(value: unknown): asserts value is AnyFleetEvent {
  if (!isRecord(value)) throw new TypeError("Fleet event must be an object");
  if (!nonEmpty(value.eventId)) throw new TypeError("Fleet event eventId must be a non-empty string");
  if (!nonEmpty(value.eventType) || !eventTypes.has(value.eventType as FleetEventType)) {
    throw new TypeError(`Unsupported fleet event type: ${String(value.eventType)}`);
  }
  if (value.schemaVersion !== 1) throw new TypeError("Fleet event schemaVersion must be 1");
  if (!nonEmpty(value.vehicleId)) throw new TypeError("Fleet event vehicleId must be a non-empty string");
  if (!positiveInteger(value.sequence)) throw new TypeError("Fleet event sequence must be a positive integer");
  if (!utcTimestamp(value.occurredAt)) throw new TypeError("Fleet event occurredAt must be an ISO 8601 UTC timestamp");
  if (value.correlationId !== undefined && !nonEmpty(value.correlationId)) {
    throw new TypeError("Fleet event correlationId must be a non-empty string when supplied");
  }
  if (!validatePayload(value.eventType as FleetEventType, value.payload)) {
    throw new TypeError(`Invalid payload for fleet event type: ${value.eventType}`);
  }
}
