export type RoutingConfig = {
  readonly timeoutMs: number;
  readonly maximumRetries: number;
  readonly maximumConcurrency: number;
  readonly requestsPerMinute: number;
  readonly maximumRequestsPerRun: number;
  readonly endpointSnapToleranceMeters: number;
};

export type SimulationConfig = {
  readonly seed: string;
  readonly vehicleCount: number;
  readonly tickIntervalMs: number;
  readonly timeMultiplier: number;
  readonly maximumAdvanceMs: number;
  readonly customerTripProbabilityPerSimulatedMinute: number;
  readonly minimumFreeDwellSeconds: number;
  readonly maximumRouteStartsPerTick: number;
  readonly maximumRouteStartsPerRealMinute: number;
  readonly maximumDestinationAttempts: number;
  readonly batteryCapacityKwh: number;
  readonly energyConsumptionKwhPerKm: number;
  readonly minimumMovementBatteryPercentage: number;
  readonly rechargeThresholdPercentage: number;
  readonly rechargeDelaySimulatedSeconds: number;
  readonly rechargeTargetPercentage: number;
  readonly telemetryGapProbabilityPerSimulatedMinute: number;
  readonly minimumTelemetryGapSeconds: number;
  readonly maximumTelemetryGapSeconds: number;
  readonly routing: RoutingConfig;
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, path: string, minimum: number, maximum = Infinity, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${path} must be ${integer ? "an integer" : "a number"} in [${minimum}, ${maximum}]`);
  }
  return value;
}

export function parseSimulationConfig(value: unknown): SimulationConfig {
  const input = record(value, "simulation");
  const routing = record(input.routing, "simulation.routing");
  if (typeof input.seed !== "string" || input.seed.trim() === "") throw new TypeError("simulation.seed must be a non-empty string");
  const parsed: SimulationConfig = {
    seed: input.seed,
    vehicleCount: number(input.vehicleCount, "simulation.vehicleCount", 1, 10_000, true),
    tickIntervalMs: number(input.tickIntervalMs, "simulation.tickIntervalMs", 1),
    timeMultiplier: number(input.timeMultiplier, "simulation.timeMultiplier", 0.001),
    maximumAdvanceMs: number(input.maximumAdvanceMs, "simulation.maximumAdvanceMs", 1),
    customerTripProbabilityPerSimulatedMinute: number(input.customerTripProbabilityPerSimulatedMinute, "simulation.customerTripProbabilityPerSimulatedMinute", 0, 1),
    minimumFreeDwellSeconds: number(input.minimumFreeDwellSeconds, "simulation.minimumFreeDwellSeconds", 0),
    maximumRouteStartsPerTick: number(input.maximumRouteStartsPerTick, "simulation.maximumRouteStartsPerTick", 0, 1_000, true),
    maximumRouteStartsPerRealMinute: number(input.maximumRouteStartsPerRealMinute, "simulation.maximumRouteStartsPerRealMinute", 1, 100_000, true),
    maximumDestinationAttempts: number(input.maximumDestinationAttempts, "simulation.maximumDestinationAttempts", 1, 100, true),
    batteryCapacityKwh: number(input.batteryCapacityKwh, "simulation.batteryCapacityKwh", 0.001),
    energyConsumptionKwhPerKm: number(input.energyConsumptionKwhPerKm, "simulation.energyConsumptionKwhPerKm", 0),
    minimumMovementBatteryPercentage: number(input.minimumMovementBatteryPercentage, "simulation.minimumMovementBatteryPercentage", 0, 100),
    rechargeThresholdPercentage: number(input.rechargeThresholdPercentage, "simulation.rechargeThresholdPercentage", 0, 100),
    rechargeDelaySimulatedSeconds: number(input.rechargeDelaySimulatedSeconds, "simulation.rechargeDelaySimulatedSeconds", 0),
    rechargeTargetPercentage: number(input.rechargeTargetPercentage, "simulation.rechargeTargetPercentage", 0, 100),
    telemetryGapProbabilityPerSimulatedMinute: number(input.telemetryGapProbabilityPerSimulatedMinute, "simulation.telemetryGapProbabilityPerSimulatedMinute", 0, 1),
    minimumTelemetryGapSeconds: number(input.minimumTelemetryGapSeconds, "simulation.minimumTelemetryGapSeconds", 0),
    maximumTelemetryGapSeconds: number(input.maximumTelemetryGapSeconds, "simulation.maximumTelemetryGapSeconds", 0),
    routing: {
      timeoutMs: number(routing.timeoutMs, "simulation.routing.timeoutMs", 1),
      maximumRetries: number(routing.maximumRetries, "simulation.routing.maximumRetries", 0, 10, true),
      maximumConcurrency: number(routing.maximumConcurrency, "simulation.routing.maximumConcurrency", 1, 1_000, true),
      requestsPerMinute: number(routing.requestsPerMinute, "simulation.routing.requestsPerMinute", 1, 100_000),
      maximumRequestsPerRun: number(routing.maximumRequestsPerRun, "simulation.routing.maximumRequestsPerRun", 0, 10_000_000, true),
      endpointSnapToleranceMeters: number(routing.endpointSnapToleranceMeters, "simulation.routing.endpointSnapToleranceMeters", 0),
    },
  };
  if (parsed.rechargeThresholdPercentage >= parsed.rechargeTargetPercentage) throw new TypeError("rechargeTargetPercentage must exceed rechargeThresholdPercentage");
  if (parsed.minimumTelemetryGapSeconds > parsed.maximumTelemetryGapSeconds) throw new TypeError("minimumTelemetryGapSeconds must not exceed maximumTelemetryGapSeconds");
  if (parsed.maximumAdvanceMs < parsed.tickIntervalMs) throw new TypeError("maximumAdvanceMs must be at least tickIntervalMs");
  return Object.freeze(parsed);
}
