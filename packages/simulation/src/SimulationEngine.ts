import type { AssignmentRejectionReason, AssignmentResult, AssignRouteCommand, CancellationResult, CancelRouteCommand, VehicleCommandPort } from "@fleet-radar/domain/commands";
import type { Destination, WorldCatalogView } from "@fleet-radar/world";
import { seededRandom } from "@fleet-radar/world";
import type { SimulationConfig } from "./config.ts";
import { batteryPercentageForDistance } from "./energy.ts";
import { SimulationEventEmitter } from "./events/SimulationEventEmitter.ts";
import { interpolateLine } from "./movement.ts";
import { ActiveRouteStore } from "./routing/ActiveRouteStore.ts";
import { RoutingError } from "./routing/errors.ts";
import type { RoutingPort } from "./routing/types.ts";
import type { ActiveMovement, SimulatedVehicle, VehicleSnapshot } from "./types.ts";

export type SimulationEngineOptions = {
  readonly config: SimulationConfig;
  readonly world: WorldCatalogView;
  readonly routing: RoutingPort;
  readonly events: SimulationEventEmitter;
  readonly routes?: ActiveRouteStore;
  readonly random?: () => number;
  readonly realNow?: () => number;
};

export class SimulationEngine implements VehicleCommandPort {
  private readonly vehicles = new Map<string, SimulatedVehicle>();
  private readonly handledCommands = new Map<string, AssignmentResult | CancellationResult>();
  private readonly inFlightAssignments = new Map<string, Promise<AssignmentResult>>();
  private readonly latestRouteVersion = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly runAbort = new AbortController();
  private readonly random: () => number;
  private readonly realNow: () => number;
  private simulatedMs = 0;
  private customerRouteSequence = 0;
  private firstAdvance = true;
  private stopping = false;
  private backgroundFailure?: unknown;
  private recentStarts: number[] = [];
  readonly activeRoutes: ActiveRouteStore;

  constructor(private readonly options: SimulationEngineOptions) {
    if (options.config.vehicleCount > options.world.destinations.length) throw new RangeError("vehicleCount cannot exceed available destinations");
    this.random = options.random ?? seededRandom(options.config.seed);
    this.realNow = options.realNow ?? (() => Date.now());
    this.activeRoutes = options.routes ?? new ActiveRouteStore();
    const destinations = this.shuffle([...options.world.destinations]);
    for (let index = 0; index < options.config.vehicleCount; index += 1) {
      const destination = destinations[index];
      const id = `vehicle-${String(index + 1).padStart(4, "0")}`;
      this.vehicles.set(id, {
        id,
        coordinate: destination.coordinate,
        heading: this.random() * 360,
        batteryPercentage: 55 + this.random() * 40,
        status: "FREE",
        currentDestinationId: destination.id,
        freeSinceSimulatedMs: 0,
      });
    }
  }

  snapshots(): readonly VehicleSnapshot[] {
    return [...this.vehicles.values()].map((vehicle) => Object.freeze({
      id: vehicle.id, coordinate: [...vehicle.coordinate] as [number, number], heading: vehicle.heading,
      batteryPercentage: vehicle.batteryPercentage, status: vehicle.status, currentDestinationId: vehicle.currentDestinationId,
      freeSinceSimulatedMs: vehicle.freeSinceSimulatedMs, telemetryGapUntilSimulatedMs: vehicle.telemetryGapUntilSimulatedMs,
      rechargeUntilSimulatedMs: vehicle.rechargeUntilSimulatedMs, customerBackoffUntilSimulatedMs: vehicle.customerBackoffUntilSimulatedMs,
      routePending: Boolean(vehicle.pendingMovement), activeRouteId: vehicle.activeMovement?.routeId,
    }));
  }

  async advance(deltaSimulatedMs: number): Promise<void> {
    if (this.stopping) return;
    if (this.backgroundFailure !== undefined) {
      const failure = this.backgroundFailure;
      this.backgroundFailure = undefined;
      throw failure;
    }
    if (!Number.isFinite(deltaSimulatedMs) || deltaSimulatedMs <= 0) throw new RangeError("deltaSimulatedMs must be positive");
    this.simulatedMs += deltaSimulatedMs;
    for (const vehicle of this.vehicles.values()) await this.advanceVehicle(vehicle, deltaSimulatedMs);
    for (const vehicle of this.vehicles.values()) this.updateAvailability(vehicle);
    if (!this.firstAdvance) for (const vehicle of this.vehicles.values()) this.updateTelemetryGap(vehicle, deltaSimulatedMs);
    for (const vehicle of this.vehicles.values()) {
      if (!vehicle.telemetryGapUntilSimulatedMs || vehicle.telemetryGapUntilSimulatedMs <= this.simulatedMs) await this.publishTelemetry(vehicle);
    }
    this.firstAdvance = false;
    this.startCustomerTrips(deltaSimulatedMs);
  }

  async assignRoute(command: AssignRouteCommand): Promise<AssignmentResult> {
    const duplicate = this.handledCommands.get(command.commandId);
    if (duplicate) return duplicate as AssignmentResult;
    const inFlight = this.inFlightAssignments.get(command.commandId);
    if (inFlight) return inFlight;
    const operation = this.assignRouteOnce(command);
    this.inFlightAssignments.set(command.commandId, operation);
    try { return await operation; }
    finally {
      if (this.inFlightAssignments.get(command.commandId) === operation) this.inFlightAssignments.delete(command.commandId);
    }
  }

  private async assignRouteOnce(command: AssignRouteCommand): Promise<AssignmentResult> {
    const reason = this.assignmentRejection(command);
    const vehicle = this.vehicles.get(command.vehicleId);
    const destination = this.options.world.getDestination(command.destinationId);
    if (reason || !vehicle || !destination) return this.rejectAssignment(command, reason ?? "ROUTING_UNAVAILABLE");

    vehicle.pendingMovement = { purpose: "DISPATCH", commandId: command.commandId };
    let route;
    try {
      route = await this.options.routing.planRoute(vehicle.coordinate, destination, this.runAbort.signal);
    } catch {
      return this.rejectAssignment(command, this.stopping ? "SHUTTING_DOWN" : "ROUTING_UNAVAILABLE", vehicle);
    }
    if (this.insufficientRange(vehicle, route.distanceMeters)) return this.rejectAssignment(command, "INSUFFICIENT_RANGE", vehicle);
    if (this.stopping) return this.rejectAssignment(command, "SHUTTING_DOWN", vehicle);
    const movement: ActiveMovement = { purpose: "DISPATCH", routeId: command.routeId, routeVersion: command.routeVersion,
      destinationId: destination.id, dispatchJobId: command.dispatchJobId, route, elapsedSeconds: 0, distanceTravelledMeters: 0 };
    vehicle.pendingMovement = undefined;
    vehicle.activeMovement = movement;
    vehicle.status = "EN_ROUTE";
    this.latestRouteVersion.set(command.routeId, command.routeVersion);
    this.activeRoutes.set({ routeId: command.routeId, vehicleId: vehicle.id, routeVersion: command.routeVersion,
      destinationId: destination.id, purpose: "DISPATCH", geometry: route.geometry });
    const result = { accepted: true, routeId: command.routeId, routeVersion: command.routeVersion } as const;
    this.remember(command.commandId, result);
    await this.options.events.publishRouteAssigned({ vehicleId: vehicle.id, routeId: command.routeId, version: command.routeVersion,
      destinationId: destination.id, dispatchJobId: command.dispatchJobId });
    await this.publishTelemetry(vehicle);
    return result;
  }

  async cancelRoute(command: CancelRouteCommand): Promise<CancellationResult> {
    const duplicate = this.handledCommands.get(command.commandId);
    if (duplicate) return duplicate as CancellationResult;
    if (this.stopping) return this.remember(command.commandId, { cancelled: false, reason: "SHUTTING_DOWN" });
    const vehicle = this.vehicles.get(command.vehicleId);
    if (!vehicle) return this.remember(command.commandId, { cancelled: false, reason: "UNKNOWN_VEHICLE" });
    const movement = vehicle.activeMovement;
    if (!movement || movement.purpose !== "DISPATCH" || movement.routeId !== command.routeId) return this.remember(command.commandId, { cancelled: false, reason: "ROUTE_NOT_ACTIVE" });
    if (movement.routeVersion !== command.routeVersion) return this.remember(command.commandId, { cancelled: false, reason: "STALE_ROUTE_VERSION" });
    vehicle.activeMovement = undefined;
    vehicle.status = "FREE";
    vehicle.freeSinceSimulatedMs = this.simulatedMs;
    this.activeRoutes.delete(movement.routeId);
    const result = this.remember(command.commandId, { cancelled: true } as const);
    await this.options.events.publishRouteCancelled({ vehicleId: vehicle.id, routeId: movement.routeId, version: movement.routeVersion,
      dispatchJobId: movement.dispatchJobId, reason: command.reason });
    await this.publishTelemetry(vehicle);
    return result;
  }

  async settle(): Promise<void> { await Promise.allSettled([...this.pending]); }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.runAbort.abort();
    await this.settle();
    this.activeRoutes.clear();
  }

  private async advanceVehicle(vehicle: SimulatedVehicle, deltaMs: number): Promise<void> {
    const movement = vehicle.activeMovement;
    if (!movement) return;
    const previousDistance = movement.distanceTravelledMeters;
    movement.elapsedSeconds += deltaMs / 1_000;
    const fraction = Math.min(1, movement.elapsedSeconds / movement.route.durationSeconds);
    movement.distanceTravelledMeters = movement.route.distanceMeters * fraction;
    const position = interpolateLine(movement.route.geometry.coordinates as unknown as readonly [number, number][], fraction);
    vehicle.coordinate = position.coordinate;
    vehicle.heading = position.heading;
    vehicle.batteryPercentage = Math.max(0, vehicle.batteryPercentage - batteryPercentageForDistance(
      movement.distanceTravelledMeters - previousDistance, this.options.config.batteryCapacityKwh, this.options.config.energyConsumptionKwhPerKm));
    if (fraction < 1) return;
    const destination = this.options.world.getDestination(movement.destinationId)!;
    vehicle.coordinate = destination.coordinate;
    vehicle.currentDestinationId = destination.id;
    vehicle.activeMovement = undefined;
    vehicle.status = "FREE";
    vehicle.freeSinceSimulatedMs = this.simulatedMs;
    this.activeRoutes.delete(movement.routeId);
    if (movement.purpose === "DISPATCH") await this.options.events.publishRouteCompleted({ vehicleId: vehicle.id, routeId: movement.routeId,
      version: movement.routeVersion, destinationId: movement.destinationId, dispatchJobId: movement.dispatchJobId });
  }

  private updateAvailability(vehicle: SimulatedVehicle): void {
    if (vehicle.rechargeUntilSimulatedMs !== undefined && vehicle.rechargeUntilSimulatedMs <= this.simulatedMs) {
      vehicle.batteryPercentage = this.options.config.rechargeTargetPercentage;
      vehicle.rechargeUntilSimulatedMs = undefined;
    }
    if (vehicle.status === "FREE" && !vehicle.pendingMovement && vehicle.rechargeUntilSimulatedMs === undefined &&
        vehicle.batteryPercentage <= this.options.config.rechargeThresholdPercentage) {
      vehicle.rechargeUntilSimulatedMs = this.simulatedMs + this.options.config.rechargeDelaySimulatedSeconds * 1_000;
    }
  }

  private updateTelemetryGap(vehicle: SimulatedVehicle, deltaMs: number): void {
    if (vehicle.telemetryGapUntilSimulatedMs !== undefined) {
      if (vehicle.telemetryGapUntilSimulatedMs <= this.simulatedMs) {
        vehicle.telemetryGapUntilSimulatedMs = undefined;
        return;
      }
      return;
    }
    const probability = 1 - (1 - this.options.config.telemetryGapProbabilityPerSimulatedMinute) ** (deltaMs / 60_000);
    if (this.random() < probability) {
      const min = this.options.config.minimumTelemetryGapSeconds;
      const max = this.options.config.maximumTelemetryGapSeconds;
      vehicle.telemetryGapUntilSimulatedMs = this.simulatedMs + (min + this.random() * (max - min)) * 1_000;
    }
  }

  private startCustomerTrips(deltaMs: number): void {
    const now = this.realNow();
    this.recentStarts = this.recentStarts.filter((started) => started > now - 60_000);
    let available = Math.min(this.options.config.maximumRouteStartsPerTick,
      this.options.config.maximumRouteStartsPerRealMinute - this.recentStarts.length);
    const probability = 1 - (1 - this.options.config.customerTripProbabilityPerSimulatedMinute) ** (deltaMs / 60_000);
    for (const vehicle of this.vehicles.values()) {
      if (available <= 0 || !this.customerEligible(vehicle) || this.random() >= probability) continue;
      available -= 1;
      this.recentStarts.push(now);
      vehicle.pendingMovement = { purpose: "CUSTOMER" };
      this.track(this.startCustomerTrip(vehicle));
    }
  }

  private async startCustomerTrip(vehicle: SimulatedVehicle): Promise<void> {
    const attempted = new Set<string>([vehicle.currentDestinationId]);
    for (let attempt = 0; attempt < this.options.config.maximumDestinationAttempts; attempt += 1) {
      const available = this.options.world.destinations.filter((destination) => !attempted.has(destination.id));
      if (available.length === 0) break;
      const destination = available[Math.min(available.length - 1, Math.floor(this.random() * available.length))];
      attempted.add(destination.id);
      let route;
      try {
        route = await this.options.routing.planRoute(vehicle.coordinate, destination, this.runAbort.signal);
      } catch (error) {
        const destinationSpecific = error instanceof RoutingError && (error.code === "NO_ROUTE" || error.code === "NO_SEGMENT");
        if (!destinationSpecific) break;
      }
      if (!route || this.insufficientRange(vehicle, route.distanceMeters)) continue;
      const routeId = `customer-${String(++this.customerRouteSequence).padStart(6, "0")}`;
      vehicle.pendingMovement = undefined;
      vehicle.activeMovement = { purpose: "CUSTOMER", routeId, routeVersion: 1, destinationId: destination.id,
        route, elapsedSeconds: 0, distanceTravelledMeters: 0 };
      vehicle.status = "WITH_CUSTOMER";
      this.activeRoutes.set({ routeId, vehicleId: vehicle.id, routeVersion: 1, destinationId: destination.id, purpose: "CUSTOMER", geometry: route.geometry });
      await this.publishTelemetry(vehicle);
      return;
    }
    vehicle.pendingMovement = undefined;
    vehicle.customerBackoffUntilSimulatedMs = this.simulatedMs + this.options.config.minimumFreeDwellSeconds * 1_000;
  }

  private customerEligible(vehicle: SimulatedVehicle): boolean {
    return vehicle.status === "FREE" && !vehicle.pendingMovement && vehicle.rechargeUntilSimulatedMs === undefined &&
      vehicle.batteryPercentage >= this.options.config.minimumMovementBatteryPercentage &&
      this.simulatedMs - vehicle.freeSinceSimulatedMs >= this.options.config.minimumFreeDwellSeconds * 1_000 &&
      (vehicle.customerBackoffUntilSimulatedMs ?? 0) <= this.simulatedMs;
  }

  private assignmentRejection(command: AssignRouteCommand): AssignmentRejectionReason | undefined {
    if (this.stopping) return "SHUTTING_DOWN";
    const vehicle = this.vehicles.get(command.vehicleId);
    if (!vehicle) return "UNKNOWN_VEHICLE";
    if (!this.options.world.getDestination(command.destinationId)) return "UNKNOWN_DESTINATION";
    if (command.routeVersion <= (this.latestRouteVersion.get(command.routeId) ?? 0)) return "STALE_ROUTE_VERSION";
    if (vehicle.pendingMovement) return "ROUTE_PENDING";
    if (vehicle.status !== "FREE" || vehicle.activeMovement) return "VEHICLE_BUSY";
    if (vehicle.rechargeUntilSimulatedMs !== undefined) return "RECHARGING";
    if (vehicle.batteryPercentage < this.options.config.minimumMovementBatteryPercentage) return "LOW_BATTERY";
  }

  private async rejectAssignment(command: AssignRouteCommand, reason: AssignmentRejectionReason, vehicle?: SimulatedVehicle): Promise<AssignmentResult> {
    if (vehicle?.pendingMovement?.commandId === command.commandId) vehicle.pendingMovement = undefined;
    const result = { accepted: false, reason } as const;
    this.remember(command.commandId, result);
    await this.options.events.publishAssignmentRejected({ vehicleId: command.vehicleId, routeId: command.routeId, version: command.routeVersion,
      destinationId: command.destinationId, dispatchJobId: command.dispatchJobId, reason });
    return result;
  }

  private insufficientRange(vehicle: SimulatedVehicle, distanceMeters: number): boolean {
    const needed = batteryPercentageForDistance(distanceMeters, this.options.config.batteryCapacityKwh, this.options.config.energyConsumptionKwhPerKm);
    return vehicle.batteryPercentage - needed < this.options.config.minimumMovementBatteryPercentage;
  }

  private publishTelemetry(vehicle: SimulatedVehicle): Promise<void> {
    if (vehicle.telemetryGapUntilSimulatedMs !== undefined && vehicle.telemetryGapUntilSimulatedMs > this.simulatedMs) {
      return Promise.resolve();
    }
    return this.options.events.publishTelemetry({ vehicleId: vehicle.id, coordinate: vehicle.coordinate, heading: vehicle.heading,
      batteryPercentage: vehicle.batteryPercentage, status: vehicle.status });
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      (error) => { this.pending.delete(work); this.backgroundFailure ??= error; },
    );
  }
  private remember<T extends AssignmentResult | CancellationResult>(commandId: string, result: T): T {
    if (this.handledCommands.size >= 10_000) this.handledCommands.delete(this.handledCommands.keys().next().value!);
    this.handledCommands.set(commandId, result); return result;
  }
  private shuffle<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.random() * (index + 1));
      [values[index], values[other]] = [values[other], values[index]];
    }
    return values;
  }
}
