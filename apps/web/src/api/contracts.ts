export const vehicleStatuses = ["FREE", "WITH_CUSTOMER", "EN_ROUTE"] as const;

export type VehicleStatus = (typeof vehicleStatuses)[number];

export type VehicleMapRecord = {
  vehicleId: string;
  coordinate: [longitude: number, latitude: number];
  heading: number;
  batteryPercentage: number;
  status: VehicleStatus;
  serviceZoneId: string;
  lastOccurredAt: string;
  lastReceivedAt: string;
};

export type FleetSnapshot = {
  data: VehicleMapRecord[];
  meta: {
    count: number;
    generatedAt: string;
    streamCursor: string;
    staleAfterSeconds: number;
  };
};

const decimalCursor = /^(0|[1-9][0-9]{0,18})$/;
const maxCursor = 9_223_372_036_854_775_807n;
const statuses = new Set<string>(vehicleStatuses);

export function parseVehicleMapRecord(input: unknown): VehicleMapRecord {
  const value = record(input, "vehicle update");
  const coordinate = value.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 2) fail("coordinate");
  const longitude = boundedNumber(coordinate[0], "longitude", -180, 180);
  const latitude = boundedNumber(coordinate[1], "latitude", -90, 90);
  const status = nonEmptyString(value.status, "status");
  if (!statuses.has(status)) fail("status");
  return {
    vehicleId: nonEmptyString(value.vehicleId, "vehicleId"),
    coordinate: [longitude, latitude],
    heading: boundedNumber(value.heading, "heading", 0, 360, false),
    batteryPercentage: boundedNumber(value.batteryPercentage, "batteryPercentage", 0, 100),
    status: status as VehicleStatus,
    serviceZoneId: nonEmptyString(value.serviceZoneId, "serviceZoneId"),
    lastOccurredAt: timestamp(value.lastOccurredAt, "lastOccurredAt"),
    lastReceivedAt: timestamp(value.lastReceivedAt, "lastReceivedAt"),
  };
}

export function parseFleetSnapshot(input: unknown): FleetSnapshot {
  const envelope = record(input, "fleet snapshot");
  if (!Array.isArray(envelope.data)) fail("data");
  const meta = record(envelope.meta, "snapshot metadata");
  const cursor = nonEmptyString(meta.streamCursor, "streamCursor");
  if (!decimalCursor.test(cursor) || BigInt(cursor) > maxCursor) fail("streamCursor");
  const data = envelope.data.map(parseVehicleMapRecord);
  const count = integer(meta.count, "count", 0);
  if (count !== data.length) fail("count");
  return {
    data,
    meta: {
      count,
      generatedAt: timestamp(meta.generatedAt, "generatedAt"),
      streamCursor: cursor,
      staleAfterSeconds: positiveNumber(meta.staleAfterSeconds, "staleAfterSeconds"),
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256) fail(name);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = nonEmptyString(value, name);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) fail(name);
  return result;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(name);
  return value as number;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(name);
  return value;
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number, inclusiveMaximum = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (inclusiveMaximum ? value > maximum : value >= maximum)) fail(name);
  return value;
}

function fail(name: string): never {
  throw new Error(`Invalid fleet data: ${name}`);
}
