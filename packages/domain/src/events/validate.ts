import type { AnyFleetEvent, FleetEventPayloads, FleetEventType } from "./types.ts";

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

const envelopeKeys = ["eventId", "eventType", "schemaVersion", "vehicleId", "sequence", "occurredAt", "payload"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, description: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${description} must be an object`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  description: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`${description} contains unknown properties: ${unknown.join(", ")}`);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new TypeError(`${description} is missing required properties: ${missing.join(", ")}`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function utcTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function parseCoordinate(value: unknown): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2 ||
    typeof value[0] !== "number" || !Number.isFinite(value[0]) || value[0] < -180 || value[0] > 180 ||
    typeof value[1] !== "number" || !Number.isFinite(value[1]) || value[1] < -90 || value[1] > 90) {
    throw new TypeError("Telemetry coordinate must be a valid [longitude, latitude] pair");
  }
  return [value[0], value[1]];
}

function invalidPayload(eventType: FleetEventType): never {
  throw new TypeError(`Invalid payload for fleet event type: ${eventType}`);
}

function isTokenBearingUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value) &&
    /(?:[?&](?:access_token|token|api_key)=|(?:pk|sk)\.[a-z0-9_-]+\.)/i.test(value);
}

function parsePayload(eventType: FleetEventType, value: unknown): FleetEventPayloads[FleetEventType] {
  assertRecord(value, `Payload for ${eventType}`);
  if (eventType.startsWith("route.") && Object.values(value).some(isTokenBearingUrl)) {
    throw new TypeError(`Payload for ${eventType} contains a token-bearing URL`);
  }
  switch (eventType) {
    case "vehicle.telemetry-received": {
      assertExactKeys(value, ["coordinate", "heading", "batteryPercentage", "status"], [], `Payload for ${eventType}`);
      const coordinate = parseCoordinate(value.coordinate);
      if (typeof value.heading !== "number" || !Number.isFinite(value.heading) || value.heading < 0 || value.heading >= 360 ||
        typeof value.batteryPercentage !== "number" || !Number.isFinite(value.batteryPercentage) ||
        value.batteryPercentage < 0 || value.batteryPercentage > 100 ||
        !["FREE", "WITH_CUSTOMER", "EN_ROUTE"].includes(String(value.status))) return invalidPayload(eventType);
      return { coordinate, heading: value.heading, batteryPercentage: value.batteryPercentage,
        status: value.status as FleetEventPayloads["vehicle.telemetry-received"]["status"] };
    }
    case "route.assigned":
      assertExactKeys(value, ["routeId", "version", "destinationId", "assignmentState"], [], `Payload for ${eventType}`);
      if (!nonEmpty(value.routeId) || !positiveInteger(value.version) || !nonEmpty(value.destinationId) ||
        !["ACCEPTED", "IN_PROGRESS"].includes(String(value.assignmentState))) return invalidPayload(eventType);
      return { routeId: value.routeId, version: value.version, destinationId: value.destinationId,
        assignmentState: value.assignmentState as "ACCEPTED" | "IN_PROGRESS" };
    case "route.updated":
      assertExactKeys(value, ["routeId", "version", "destinationId"], [], `Payload for ${eventType}`);
      if (!nonEmpty(value.routeId) || !positiveInteger(value.version) || !nonEmpty(value.destinationId)) return invalidPayload(eventType);
      return { routeId: value.routeId, version: value.version, destinationId: value.destinationId };
    case "route.cancelled":
      assertExactKeys(value, ["routeId", "version"], ["reason"], `Payload for ${eventType}`);
      if (!nonEmpty(value.routeId) || !positiveInteger(value.version) ||
        (value.reason !== undefined && !nonEmpty(value.reason))) return invalidPayload(eventType);
      return { routeId: value.routeId, version: value.version, ...(value.reason === undefined ? {} : { reason: value.reason as string }) };
    case "route.completed":
      assertExactKeys(value, ["routeId", "version", "destinationId"], [], `Payload for ${eventType}`);
      if (!nonEmpty(value.routeId) || !positiveInteger(value.version) || !nonEmpty(value.destinationId)) return invalidPayload(eventType);
      return { routeId: value.routeId, version: value.version, destinationId: value.destinationId };
    case "route.assignment-rejected":
      assertExactKeys(value, ["routeId", "version", "destinationId", "reason"], [], `Payload for ${eventType}`);
      if (!nonEmpty(value.routeId) || !positiveInteger(value.version) || !nonEmpty(value.destinationId) || !nonEmpty(value.reason)) {
        return invalidPayload(eventType);
      }
      return { routeId: value.routeId, version: value.version, destinationId: value.destinationId, reason: value.reason };
    case "dispatch.assignment-requested":
      assertExactKeys(value, ["dispatchJobId", "commandId", "routeId", "routeVersion", "destinationId", "strategy"], ["reason"], `Payload for ${eventType}`);
      if (!nonEmpty(value.dispatchJobId) || !nonEmpty(value.commandId) || !nonEmpty(value.routeId) ||
        !positiveInteger(value.routeVersion) || !nonEmpty(value.destinationId) || !nonEmpty(value.strategy) ||
        (value.reason !== undefined && !nonEmpty(value.reason))) return invalidPayload(eventType);
      return { dispatchJobId: value.dispatchJobId, commandId: value.commandId, routeId: value.routeId,
        routeVersion: value.routeVersion, destinationId: value.destinationId, strategy: value.strategy,
        ...(value.reason === undefined ? {} : { reason: value.reason as string }) };
    case "dispatch.assignment-completed":
      assertExactKeys(value, ["dispatchJobId", "routeId", "routeVersion"], [], `Payload for ${eventType}`);
      if (!nonEmpty(value.dispatchJobId) || !nonEmpty(value.routeId) || !positiveInteger(value.routeVersion)) return invalidPayload(eventType);
      return { dispatchJobId: value.dispatchJobId, routeId: value.routeId, routeVersion: value.routeVersion };
  }
}

/** Parses an exact, transport-independent event and returns only its canonical fields. */
export function parseFleetEvent(value: unknown): AnyFleetEvent {
  assertRecord(value, "Fleet event");
  assertExactKeys(value, envelopeKeys, ["correlationId"], "Fleet event");
  if (!nonEmpty(value.eventId)) throw new TypeError("Fleet event eventId must be a non-empty string");
  if (!nonEmpty(value.eventType) || !eventTypes.has(value.eventType as FleetEventType)) {
    throw new TypeError(`Unsupported fleet event type: ${String(value.eventType)}`);
  }
  if (value.schemaVersion !== 1) throw new TypeError("Fleet event schemaVersion must be 1");
  if (!nonEmpty(value.vehicleId)) throw new TypeError("Fleet event vehicleId must be a non-empty string");
  if (!positiveInteger(value.sequence)) throw new TypeError("Fleet event sequence must be a positive safe integer");
  if (!utcTimestamp(value.occurredAt)) throw new TypeError("Fleet event occurredAt must be an ISO 8601 UTC timestamp");
  if (value.correlationId !== undefined && !nonEmpty(value.correlationId)) {
    throw new TypeError("Fleet event correlationId must be a non-empty string when supplied");
  }
  const eventType = value.eventType as FleetEventType;
  return {
    eventId: value.eventId,
    eventType,
    schemaVersion: 1,
    vehicleId: value.vehicleId,
    sequence: value.sequence,
    occurredAt: value.occurredAt,
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId }),
    payload: parsePayload(eventType, value.payload),
  } as AnyFleetEvent;
}

/** Backward-compatible assertion for callers that do not need the canonical copy. */
export function validateFleetEvent(value: unknown): asserts value is AnyFleetEvent {
  parseFleetEvent(value);
}
